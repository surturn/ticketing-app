import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db, withTransaction } from '../db/client.js';
import { events, orderItems, orders, ticketTiers } from '../db/schema.js';
import { releaseOrder, reserveTier } from './inventory.service.js';

// ---------------------------------------------------------------------------
// Integration tests — these need a real Postgres, because the behaviour under
// test *is* Postgres behaviour. Run with:
//
//   docker compose up -d postgres
//   RUN_DB_TESTS=true npm test
//
// Point DATABASE_URL at a throwaway database: this truncates tables.
// ---------------------------------------------------------------------------

const enabled = process.env.RUN_DB_TESTS === 'true';

describe.skipIf(!enabled)('inventory concurrency', () => {
  let eventId: string;

  beforeEach(async () => {
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

  async function makeTier(quantityTotal: number, maxPerOrder = 10) {
    const [tier] = await db
      .insert(ticketTiers)
      .values({
        eventId,
        name: 'GA',
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
    expect(after!.quantityReserved + after!.quantitySold).toBeLessThanOrEqual(
      after!.quantityTotal,
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
