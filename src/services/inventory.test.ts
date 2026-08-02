import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db, withTransaction } from '../db/client.js';
import { events, orderItems, orders, ticketTiers, tickets } from '../db/schema.js';
import { shouldRunDbTests } from '../test/disposable-db.js';
import {
  explainReservationFailure,
  releaseOrder,
  reserveTier,
} from './inventory.service.js';

// ---------------------------------------------------------------------------
// Integration tests — these need a real Postgres, because the behaviour under
// test *is* Postgres behaviour. Run with:
//
//   docker compose up -d postgres
//   RUN_DB_TESTS=true npm test
//
// Point DATABASE_URL at a throwaway database: this truncates tables.
// ---------------------------------------------------------------------------

const enabled = shouldRunDbTests();

describe.skipIf(!enabled)('inventory concurrency', () => {
  let eventId: string;

  beforeEach(async () => {
    // Deleted parent-last, and `tickets` first of all.
    //
    // Without that first line every test in this file failed on its own
    // cleanup — tickets reference order_items, so removing the items first
    // violates the foreign key and the suite never reached a single assertion.
    // These are the tests that prove the tier counters cannot oversell, so
    // silently failing to run them was worse than not having them.
    await db.delete(tickets);
    await db.delete(orderItems);
    await db.delete(orders);
    await db.delete(ticketTiers);
    await db.delete(events);

    const [event] = await db
      .insert(events)
      .values({
        slug: `test-${Date.now()}`,
        name: 'Concurrency Test Event',
        startsAt: new Date(Date.now() + 86_400_000),
        status: 'published',
      })
      .returning();

    eventId = event!.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** `quantityTotal: null` creates an uncapped tier. */
  async function makeTier(quantityTotal: number | null, maxPerOrder = 10) {
    const [tier] = await db
      .insert(ticketTiers)
      .values({
        eventId,
        name: `GA-${Math.random().toString(36).slice(2, 8)}`,
        priceCents: 100_000,
        quantityTotal,
        maxPerOrder,
      })
      .returning();
    return tier!;
  }

  it('never sells more than the tier holds, under concurrent pressure', async () => {
    const capacity = 10;
    const tier = await makeTier(capacity);
    const contenders = 50;

    // Everyone grabs one seat at the same moment.
    const results = await Promise.all(
      Array.from({ length: contenders }, () =>
        withTransaction(async (tx) => reserveTier(tx, eventId, { tierId: tier.id, quantity: 1 }))
          .then((row) => (row ? 'reserved' : 'rejected'))
          .catch(() => 'errored'),
      ),
    );

    const reserved = results.filter((r) => r === 'reserved').length;
    const [after] = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, tier.id));

    // The two numbers must agree, and neither may exceed capacity.
    expect(reserved).toBe(capacity);
    expect(after!.quantityReserved).toBe(capacity);
    // This tier is capped, so the guard is a real comparison rather than a
    // vacuous one against null.
    expect(after!.quantityTotal).not.toBeNull();
    expect(after!.quantityReserved + after!.quantitySold).toBeLessThanOrEqual(
      after!.quantityTotal!,
    );
  });

  it('handles multi-seat baskets without overselling the remainder', async () => {
    const tier = await makeTier(10, 4);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTransaction(async (tx) => reserveTier(tx, eventId, { tierId: tier.id, quantity: 4 }))
          .then((row) => Boolean(row))
          .catch(() => false),
      ),
    );

    const successes = results.filter(Boolean).length;
    const [after] = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, tier.id));

    // 10 capacity / 4 per basket → at most 2 baskets fit.
    expect(successes).toBe(2);
    expect(after!.quantityReserved).toBe(8);
  });

  it('rejects a quantity above maxPerOrder', async () => {
    const tier = await makeTier(100, 4);

    const row = await withTransaction(async (tx) =>
      reserveTier(tx, eventId, { tierId: tier.id, quantity: 5 }),
    );

    expect(row).toBeNull();
  });

  // ─── Uncapped tiers ──────────────────────────────────────────────────────
  //
  // An organiser who books the venue on the strength of what sold runs the sale
  // with no capacity at all. The reservation guard compares against
  // `quantity_total`, and in SQL a comparison with NULL is NULL — which a WHERE
  // treats as false. Without the explicit `IS NULL` branch, an uncapped tier
  // would silently refuse every single purchase.

  it('sells from an uncapped tier', async () => {
    const tier = await makeTier(null);

    const row = await withTransaction(async (tx) =>
      reserveTier(tx, eventId, { tierId: tier.id, quantity: 5 }),
    );

    expect(row).not.toBeNull();
    expect(row!.quantityReserved).toBe(5);
    expect(row!.quantityTotal).toBeNull();
  });

  it('keeps selling an uncapped tier well past any implied limit', async () => {
    const tier = await makeTier(null, 10);
    const buyers = 50;

    const results = await Promise.all(
      Array.from({ length: buyers }, () =>
        withTransaction(async (tx) =>
          reserveTier(tx, eventId, { tierId: tier.id, quantity: 10 }),
        )
          .then((row) => Boolean(row))
          .catch(() => false),
      ),
    );

    const [after] = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, tier.id));

    // Every buyer succeeds, and the counter is exact — the oversell CHECK must
    // not fire on a tier that has no capacity to oversell.
    expect(results.filter(Boolean).length).toBe(buyers);
    expect(after!.quantityReserved).toBe(buyers * 10);
  });

  it('still enforces maxPerOrder on an uncapped tier', async () => {
    // Uncapped means no ceiling on the tier, not a free-for-all per order.
    const tier = await makeTier(null, 4);

    const row = await withTransaction(async (tx) =>
      reserveTier(tx, eventId, { tierId: tier.id, quantity: 5 }),
    );

    expect(row).toBeNull();
  });

  it('refuses sales once the organiser closes an uncapped tier', async () => {
    // Closing is the only way an uncapped tier can be sold out. If the guard
    // were left to capacity alone, an organiser would have no way to stop a sale
    // that has no limit to reach.
    const tier = await makeTier(null);

    const beforeClosing = await withTransaction(async (tx) =>
      reserveTier(tx, eventId, { tierId: tier.id, quantity: 2 }),
    );
    expect(beforeClosing).not.toBeNull();

    await db
      .update(ticketTiers)
      .set({ status: 'closed' })
      .where(eq(ticketTiers.id, tier.id));

    const afterClosing = await withTransaction(async (tx) =>
      reserveTier(tx, eventId, { tierId: tier.id, quantity: 1 }),
    );
    expect(afterClosing).toBeNull();

    // Already-sold seats are untouched — closing stops new sales, it does not
    // cancel anything.
    const [after] = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, tier.id));
    expect(after!.quantityReserved).toBe(2);
  });

  it('reports a closed tier as sold out rather than merely unavailable', async () => {
    const tier = await makeTier(null);
    await db
      .update(ticketTiers)
      .set({ status: 'closed' })
      .where(eq(ticketTiers.id, tier.id));

    // A buyer hitting a closed tier must be told it is sold out — final — not
    // "not currently on sale", which invites them to come back.
    await expect(
      withTransaction(async (tx) =>
        explainReservationFailure(tx, eventId, { tierId: tier.id, quantity: 1 }),
      ),
    ).rejects.toMatchObject({
      code: 'insufficient_inventory',
      retryable: false,
    });
  });

  it('releases seats on an uncapped tier without going negative', async () => {
    const tier = await makeTier(null);

    const order = await withTransaction(async (tx) => {
      await reserveTier(tx, eventId, { tierId: tier.id, quantity: 3 });
      const [created] = await tx
        .insert(orders)
        .values({
          eventId,
          reference: `TKT-UNCAP${Date.now().toString(36).toUpperCase().slice(-4)}`,
          buyerName: 'Test Buyer',
          buyerEmail: 'uncapped@example.com',
          buyerPhone: '254712345678',
          subtotalCents: 300_000,
          totalCents: 300_000,
          reservedUntil: new Date(Date.now() + 600_000),
        })
        .returning();

      await tx.insert(orderItems).values({
        orderId: created!.id,
        tierId: tier.id,
        tierName: tier.name,
        quantity: 3,
        unitPriceCents: 100_000,
        subtotalCents: 300_000,
      });

      return created!;
    });

    await releaseOrder(order.id, 'expired');

    const [after] = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, tier.id));

    expect(after!.quantityReserved).toBe(0);
    expect(after!.quantityTotal).toBeNull();
  });

  it('releases a hold exactly once, even when release races itself', async () => {
    const tier = await makeTier(10);

    const order = await withTransaction(async (tx) => {
      await reserveTier(tx, eventId, { tierId: tier.id, quantity: 3 });
      const [created] = await tx
        .insert(orders)
        .values({
          eventId,
          reference: `TKT-${Date.now()}`,
          buyerName: 'Test Buyer',
          buyerEmail: 'test.buyer@example.com',
          buyerPhone: '254712345678',
          subtotalCents: 300_000,
          totalCents: 300_000,
          reservedUntil: new Date(Date.now() + 600_000),
        })
        .returning();

      await tx.insert(orderItems).values({
        orderId: created!.id,
        tierId: tier.id,
        tierName: 'GA',
        quantity: 3,
        unitPriceCents: 100_000,
        subtotalCents: 300_000,
      });

      return created!;
    });

    // The expiry job, a failed callback and the reconciler can all fire at once.
    const releases = await Promise.all([
      releaseOrder(order.id, 'expired'),
      releaseOrder(order.id, 'expired'),
      releaseOrder(order.id, 'expired'),
    ]);

    expect(releases.filter((r) => r.released)).toHaveLength(1);

    const [after] = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, tier.id));

    // Seats returned once — not three times.
    expect(after!.quantityReserved).toBe(0);
  });
});
