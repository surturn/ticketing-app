import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db } from '../db/client.js';
import { events, organisations, orderItems, orders, ticketTiers, tickets } from '../db/schema.js';
import { shouldRunDbTests } from '../test/disposable-db.js';

/**
 * The gateway is faked so this suite stays about the cap.
 *
 * Without it these tests reached the real Daraja sandbox — an external call on
 * every case, which is slow, flaky, and makes a unit of behaviour depend on
 * somebody else's uptime. Nothing here is asserting anything about M-Pesa.
 */
vi.mock('../gateways/registry.js', () => ({
  getGateway: () => ({
    name: 'mpesa',
    isConfigured: () => true,
    charge: async () => ({
      gatewayRef: `ws_CO_${Math.random().toString(36).slice(2, 12)}`,
      merchantRef: 'test',
      customerMessage: 'Check your phone',
      raw: {},
    }),
    parseCallback: vi.fn(),
    queryStatus: vi.fn(),
  }),
  DEFAULT_GATEWAY: 'mpesa',
  listGateways: () => ['mpesa'],
}));

const { createCheckout } = await import('./checkout.service.js');

// ---------------------------------------------------------------------------
// Denial of inventory, not theft.
//
// Held seats that never pay are stock nobody else can buy, and a hold costs an
// attacker nothing — guest checkout needs a well-formed name, email and number,
// and the per-IP rate limit is answered by using more addresses. The cap counts
// what is actually held rather than how fast it was asked for, which is what
// makes it survive an address book of IPs.
//
// Against a real Postgres because the query is the mechanism: it turns on `now()`
// and on the interaction between order status and `reserved_until`.
// ---------------------------------------------------------------------------

const enabled = shouldRunDbTests();

const PHONE = '254712345678';
const HOLD_LIMIT = 3;

describe.skipIf(!enabled)('active hold capacity', () => {
  let eventId: string;
  let tierId: string;

  beforeEach(async () => {
    await db.delete(tickets);
    await db.delete(orderItems);
    await db.delete(orders);
    await db.delete(ticketTiers);
    await db.delete(events);
    await db.delete(organisations);

    const [org] = await db
      .insert(organisations)
      .values({
        name: 'Test Org',
        slug: `org-holds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning();

    const [event] = await db
      .insert(events)
      .values({
        organisationId: org!.id,
        slug: `holds-${Date.now()}`,
        name: 'Hold Capacity Event',
        startsAt: new Date(Date.now() + 86_400_000),
        status: 'published',
      })
      .returning();
    eventId = event!.id;

    const [tier] = await db
      .insert(ticketTiers)
      .values({ eventId, name: 'GA', priceCents: 100_000, quantityTotal: 500 })
      .returning();
    tierId = tier!.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** An order sitting on a hold, as the checkout path would leave it. */
  async function seedHold(options: {
    status: 'pending' | 'awaiting_payment' | 'paid' | 'expired';
    minutesLeft: number;
    phone?: string;
    /** Seats already handed back by `releaseOrder`. */
    released?: boolean;
  }) {
    const [order] = await db
      .insert(orders)
      .values({
        eventId,
        reference: `TKT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        buyerName: 'Test Buyer',
        buyerEmail: 'buyer@example.com',
        buyerPhone: options.phone ?? PHONE,
        subtotalCents: 100_000,
        totalCents: 100_000,
        status: options.status,
        reservedUntil: new Date(Date.now() + options.minutesLeft * 60_000),
        releasedAt: options.released ? new Date() : null,
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: order!.id,
      tierId,
      tierName: 'GA',
      quantity: 1,
      unitPriceCents: 100_000,
      subtotalCents: 100_000,
    });

    return order!;
  }

  /** A checkout that would succeed but for the cap. */
  async function attempt() {
    const [event] = await db.select().from(events).where(eq(events.id, eventId));
    return createCheckout({
      eventSlug: event!.slug,
      items: [{ tierId, quantity: 1 }],
      buyer: { name: 'Test Buyer', email: 'buyer@example.com', phone: PHONE },
    });
  }

  it('refuses a checkout once the number is at the cap', async () => {
    for (let i = 0; i < HOLD_LIMIT; i += 1) {
      await seedHold({ status: 'awaiting_payment', minutesLeft: 5 });
    }

    await expect(attempt()).rejects.toMatchObject({ code: 'too_many_active_holds' });
  });

  it('still counts a lapsed hold the sweeper has not reached', async () => {
    // The clock running out does not give seats back — `releaseOrder` does, and
    // it is the only thing that moves `quantity_reserved`. Until it runs, these
    // three are still occupying inventory and must still count.
    for (let i = 0; i < HOLD_LIMIT; i += 1) {
      await seedHold({ status: 'awaiting_payment', minutesLeft: -5 });
    }

    await expect(attempt()).rejects.toMatchObject({ code: 'too_many_active_holds' });
  });

  it('stops counting once the seats have actually been returned', async () => {
    // Released, so the counters have the seats back and the buyer is free again.
    for (let i = 0; i < HOLD_LIMIT; i += 1) {
      await seedHold({ status: 'expired', minutesLeft: -5, released: true });
    }

    await expect(attempt()).resolves.toMatchObject({ status: 'awaiting_payment' });
  });

  it('does not count completed purchases', async () => {
    // Someone who has bought three times is a good customer, not a bot.
    for (let i = 0; i < HOLD_LIMIT; i += 1) {
      await seedHold({ status: 'paid', minutesLeft: -60 });
    }

    await expect(attempt()).resolves.toMatchObject({ status: 'awaiting_payment' });
  });

  it('counts per number rather than globally', async () => {
    // Another buyer at the cap must not stop this one — otherwise a single
    // attacker could lock out the whole event instead of only themselves.
    for (let i = 0; i < HOLD_LIMIT + 2; i += 1) {
      await seedHold({
        status: 'awaiting_payment',
        minutesLeft: 5,
        phone: '254799999999',
      });
    }

    await expect(attempt()).resolves.toMatchObject({ status: 'awaiting_payment' });
  });

  it('says when the oldest hold frees up', async () => {
    for (let i = 0; i < HOLD_LIMIT; i += 1) {
      await seedHold({ status: 'awaiting_payment', minutesLeft: 5 + i });
    }

    // A genuine buyer who hits this deserves to know it is temporary.
    await expect(attempt()).rejects.toMatchObject({
      code: 'too_many_active_holds',
      retryable: true,
    });
  });
});
