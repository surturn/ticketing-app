import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../db/client.js';
import {
  events,
  orderItems,
  orders,
  payments,
  ticketTiers,
  tickets,
} from '../db/schema.js';
import { purgeAbandonedOrders } from './purge.service.js';
import { shouldRunDbTests } from '../test/disposable-db.js';

// ---------------------------------------------------------------------------
// This is the only code in the system that deletes anything, so the tests that
// matter are the ones proving what it *refuses* to delete. A purge that removes
// slightly too much is not a bug you find in a log — it is a bug you find when
// somebody asks where their payment record went.
// ---------------------------------------------------------------------------

const enabled = shouldRunDbTests();
const DAY = 86_400_000;

describe.skipIf(!enabled)('purging abandoned orders', () => {
  let eventId: string;
  let tierId: string;

  beforeEach(async () => {
    await db.delete(tickets);
    await db.delete(payments);
    await db.delete(orderItems);
    await db.delete(orders);
    await db.delete(ticketTiers);
    await db.delete(events);

    const [event] = await db
      .insert(events)
      .values({
        slug: `purge-${Date.now()}`,
        name: 'Purge Test Event',
        startsAt: new Date(Date.now() + DAY),
        status: 'published',
      })
      .returning();
    eventId = event!.id;

    const [tier] = await db
      .insert(ticketTiers)
      .values({ eventId, name: 'GA', priceCents: 100_000, quantityTotal: 100 })
      .returning();
    tierId = tier!.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function makeOrder(options: {
    status: 'expired' | 'failed' | 'cancelled' | 'pending' | 'paid';
    ageDays: number;
    withPayment?: boolean;
    withTicket?: boolean;
  }) {
    const createdAt = new Date(Date.now() - options.ageDays * DAY);

    const [order] = await db
      .insert(orders)
      .values({
        eventId,
        reference: `TKT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        buyerName: 'Test Buyer',
        buyerEmail: `buyer-${Math.random().toString(36).slice(2, 8)}@example.com`,
        buyerPhone: '254712345678',
        subtotalCents: 100_000,
        totalCents: 100_000,
        status: options.status,
        reservedUntil: createdAt,
        createdAt,
      })
      .returning();

    const [item] = await db
      .insert(orderItems)
      .values({
        orderId: order!.id,
        tierId,
        // Denormalised on the row so an order stays readable if the tier is
        // later renamed — and not-null, so the fixture has to supply it.
        tierName: 'GA',
        quantity: 1,
        unitPriceCents: 100_000,
        subtotalCents: 100_000,
      })
      .returning();

    if (options.withPayment) {
      await db.insert(payments).values({
        orderId: order!.id,
        gatewayRef: `ws_CO_${Math.random().toString(36).slice(2, 10)}`,
        amountCents: 100_000,
        status: 'failed',
      });
    }

    if (options.withTicket) {
      await db.insert(tickets).values({
        eventId,
        orderId: order!.id,
        orderItemId: item!.id,
        tierId,
        code: `TKT${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        // "Ticket 1 of 2" on the stub — not-null, so the fixture supplies it.
        sequence: 1,
      });
    }

    return order!;
  }

  const survives = async (id: string) => {
    const rows = await db.select().from(orders).where(eq(orders.id, id));
    return rows.length === 1;
  };

  it('removes an expired order that never reached payment', async () => {
    const order = await makeOrder({ status: 'expired', ageDays: 45 });

    const result = await purgeAbandonedOrders(30);

    expect(result.purged).toBe(1);
    expect(await survives(order.id)).toBe(false);
  });

  it('removes the order items along with it', async () => {
    const order = await makeOrder({ status: 'failed', ageDays: 45 });

    await purgeAbandonedOrders(30);

    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    expect(items).toHaveLength(0);
  });

  it('KEEPS an order that has a payment record, however old', async () => {
    // The condition that matters most. A cancelled order that reached M-Pesa
    // has evidence attached, and evidence is not rubbish to be swept up.
    const order = await makeOrder({
      status: 'cancelled',
      ageDays: 400,
      withPayment: true,
    });

    const result = await purgeAbandonedOrders(30);

    expect(result.purged).toBe(0);
    expect(await survives(order.id)).toBe(true);
  });

  it('KEEPS an order that issued a ticket, however old', async () => {
    const order = await makeOrder({ status: 'expired', ageDays: 400, withTicket: true });

    const result = await purgeAbandonedOrders(30);

    expect(result.purged).toBe(0);
    expect(await survives(order.id)).toBe(true);
  });

  it('KEEPS a paid order, however old', async () => {
    const order = await makeOrder({ status: 'paid', ageDays: 400 });

    const result = await purgeAbandonedOrders(30);

    expect(result.purged).toBe(0);
    expect(await survives(order.id)).toBe(true);
  });

  it('KEEPS a pending order, however old', async () => {
    // Pending is not a terminal state. An order sitting here is a bug worth
    // investigating, not one to delete the evidence of.
    const order = await makeOrder({ status: 'pending', ageDays: 400 });

    const result = await purgeAbandonedOrders(30);

    expect(result.purged).toBe(0);
    expect(await survives(order.id)).toBe(true);
  });

  it('KEEPS an abandoned order that is younger than the window', async () => {
    // Age is measured from creation, and the window exists because a delayed
    // callback can still settle an order after its hold has lapsed.
    const order = await makeOrder({ status: 'expired', ageDays: 10 });

    const result = await purgeAbandonedOrders(30);

    expect(result.purged).toBe(0);
    expect(await survives(order.id)).toBe(true);
  });

  it('separates the purgeable from the protected in one pass', async () => {
    const doomed = await makeOrder({ status: 'expired', ageDays: 60 });
    const paid = await makeOrder({ status: 'paid', ageDays: 60 });
    const withPayment = await makeOrder({
      status: 'failed',
      ageDays: 60,
      withPayment: true,
    });
    const recent = await makeOrder({ status: 'failed', ageDays: 2 });

    const result = await purgeAbandonedOrders(30);

    expect(result.purged).toBe(1);
    expect(await survives(doomed.id)).toBe(false);
    expect(await survives(paid.id)).toBe(true);
    expect(await survives(withPayment.id)).toBe(true);
    expect(await survives(recent.id)).toBe(true);
  });

  it('is safe to run when there is nothing to do', async () => {
    const result = await purgeAbandonedOrders(30);
    expect(result).toEqual({ purged: 0, references: [] });
  });
});
