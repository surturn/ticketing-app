import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db } from '../db/client.js';
import {
  events,
  orderItems,
  orders,
  payments,
  ticketTiers,
  tickets,
  webhookEvents,
} from '../db/schema.js';
import type { SettlementResult } from '../gateways/types.js';

// ---------------------------------------------------------------------------
// A settlement that arrives by callback is a claim, not a fact.
//
// The callback endpoint is unauthenticated apart from a shared token, and the
// `gatewayRef` needed to aim a forged success at a specific payment is handed to
// the buyer in the checkout response. So the case that matters is not "does a
// real settlement work" — it is "does an invented one get refused", and it is
// asserted against a real Postgres because the claim/release logic under test
// is a conditional UPDATE, not a branch in TypeScript.
//
//   docker compose up -d postgres
//   RUN_DB_TESTS=true npm test
//
// Point DATABASE_URL at a throwaway database: this truncates tables.
// ---------------------------------------------------------------------------

/**
 * Refuses to run against a database that is not obviously disposable.
 *
 * `beforeEach` truncates six tables. `.env` in this repo points DATABASE_URL at
 * the local *development* database, not `ticketing_test`, so `RUN_DB_TESTS=true`
 * on a default checkout deletes the developer's own seed data — which is exactly
 * what happened when this file was first run. The convention was documented in a
 * comment in a sibling suite; a comment is not a guard.
 *
 * Override deliberately with TEST_DATABASE_URL, or name the database so it is
 * plainly a test one.
 */
function targetIsDisposable(): boolean {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) return false;
  try {
    const name = new URL(url).pathname.slice(1);
    return /(^|[_-])test($|[_-])/.test(name);
  } catch {
    return false;
  }
}

const enabled = process.env.RUN_DB_TESTS === 'true';

if (enabled && !targetIsDisposable()) {
  throw new Error(
    'RUN_DB_TESTS=true but DATABASE_URL does not name a test database.\n' +
      '  These tests truncate tables. Point DATABASE_URL (or TEST_DATABASE_URL) at\n' +
      '  a throwaway database whose name contains "test", e.g. ticketing_test.',
  );
}

/** What the gateway will claim when `queryStatus` is called. Set per test. */
let queryOutcome: SettlementResult['outcome'] = 'succeeded';
let queryThrows = false;

vi.mock('../gateways/registry.js', () => ({
  getGateway: () => ({
    name: 'mpesa',
    isConfigured: () => true,
    charge: vi.fn(),
    parseCallback: vi.fn(),
    queryStatus: async (gatewayRef: string): Promise<SettlementResult> => {
      if (queryThrows) throw new Error('Daraja unreachable');
      return {
        gatewayRef,
        outcome: queryOutcome,
        resultCode: queryOutcome === 'succeeded' ? 0 : 1,
        resultDesc: queryOutcome === 'succeeded' ? 'Success' : 'Insufficient balance',
        dedupeKey: `${gatewayRef}:query`,
        raw: {},
      };
    },
  }),
  DEFAULT_GATEWAY: 'mpesa',
  listGateways: () => ['mpesa'],
}));

// Imported after the mock is registered, so the service picks up the fake.
const { applySettlement } = await import('./payments.service.js');

describe.skipIf(!enabled)('settlement confirmation', () => {
  let orderId: string;
  let gatewayRef: string;

  beforeEach(async () => {
    queryOutcome = 'succeeded';
    queryThrows = false;

    // Children first — tickets reference order_items, so the parent-last order
    // is what keeps the foreign keys satisfied.
    await db.delete(tickets);
    await db.delete(webhookEvents);
    await db.delete(payments);
    await db.delete(orderItems);
    await db.delete(orders);
    await db.delete(ticketTiers);
    await db.delete(events);

    const [event] = await db
      .insert(events)
      .values({
        slug: `confirm-${Date.now()}`,
        name: 'Settlement Confirmation Event',
        startsAt: new Date(Date.now() + 86_400_000),
        status: 'published',
      })
      .returning();

    const [tier] = await db
      .insert(ticketTiers)
      .values({
        eventId: event!.id,
        name: 'GA',
        priceCents: 250_000,
        quantityTotal: 100,
        quantityReserved: 1,
      })
      .returning();

    const [order] = await db
      .insert(orders)
      .values({
        eventId: event!.id,
        reference: `TKT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        buyerName: 'Test Buyer',
        buyerEmail: 'buyer@example.com',
        buyerPhone: '254700000000',
        subtotalCents: 250_000,
        feeCents: 0,
        totalCents: 250_000,
        currency: 'KES',
        status: 'awaiting_payment',
        reservedUntil: new Date(Date.now() + 600_000),
      })
      .returning();

    orderId = order!.id;

    await db.insert(orderItems).values({
      orderId,
      tierId: tier!.id,
      tierName: 'GA',
      quantity: 1,
      unitPriceCents: 250_000,
      subtotalCents: 250_000,
    });

    gatewayRef = `ws_CO_${Date.now()}`;

    await db.insert(payments).values({
      orderId,
      gateway: 'mpesa',
      gatewayRef,
      amountCents: 250_000,
      currency: 'KES',
      payerPhone: '254700000000',
      status: 'pending',
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** The shape a forged callback produces: a plausible, well-formed success. */
  function forgedSuccess(): SettlementResult {
    return {
      gatewayRef,
      outcome: 'succeeded',
      resultCode: 0,
      resultDesc: 'The service request is processed successfully.',
      // Matching the order total exactly, so the underpayment guard would pass.
      amountCents: 250_000,
      receipt: 'SFORGED001',
      dedupeKey: `${gatewayRef}:0`,
      raw: {},
    };
  }

  async function paymentRow() {
    const [row] = await db.select().from(payments).where(eq(payments.gatewayRef, gatewayRef));
    return row!;
  }

  async function orderRow() {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    return row!;
  }

  it('refuses a callback the gateway contradicts, and issues nothing', async () => {
    queryOutcome = 'failed';

    const report = await applySettlement(forgedSuccess(), { source: 'callback' });

    expect(report.applied).toBe(false);
    expect(report.reason).toBe('unconfirmed_contradicted');

    // The money side is untouched: nothing was marked paid, and no ticket exists
    // for an order nobody paid for.
    const payment = await paymentRow();
    expect(payment.status).toBe('pending');
    expect((await orderRow()).status).toBe('awaiting_payment');
    expect(await db.select().from(tickets)).toHaveLength(0);
  });

  it('releases the claim so the reconciler can still settle it later', async () => {
    queryOutcome = 'failed';
    await applySettlement(forgedSuccess(), { source: 'callback' });

    // The claim is what stops two settlements racing. If a refused callback left
    // it set, the payment would be stranded — no reconciler attempt could ever
    // pick it up, and a buyer who really paid would never be issued a ticket.
    expect((await paymentRow()).claimedAt).toBeNull();
  });

  it('refuses when the gateway cannot be reached, rather than assuming success', async () => {
    queryThrows = true;

    const report = await applySettlement(forgedSuccess(), { source: 'callback' });

    expect(report.applied).toBe(false);
    expect(report.reason).toBe('unconfirmed_query_failed');
    expect((await paymentRow()).status).toBe('pending');
    expect((await paymentRow()).claimedAt).toBeNull();
  });

  it('settles a callback the gateway confirms', async () => {
    queryOutcome = 'succeeded';

    const report = await applySettlement(forgedSuccess(), { source: 'callback' });

    expect(report.applied).toBe(true);
    expect((await paymentRow()).status).toBe('succeeded');
    expect((await orderRow()).status).toBe('paid');
  });

  it('does not re-query a result that already came from the gateway', async () => {
    // A reconciler result is already confirmed by construction. Setting the
    // query to contradict it proves the confirmation step was skipped: if it ran,
    // this settlement would be refused.
    queryOutcome = 'failed';

    const report = await applySettlement(forgedSuccess(), { source: 'query' });

    expect(report.applied).toBe(true);
    expect((await paymentRow()).status).toBe('succeeded');
  });
});
