import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db, withTransaction } from '../db/client.js';
import { ledgerEntries } from '../db/schema.js';
import { recordTransition, verifyChain, getOrderHistory } from './ledger.service.js';
import { shouldRunDbTests } from '../test/disposable-db.js';

// ---------------------------------------------------------------------------
// These assert the *database's* guarantees, not the application's. The whole
// value of the ledger rests on Postgres refusing to let anything rewrite it, so
// asserting that in TypeScript would prove nothing — every case here goes
// through a real connection and expects a real error.
//
// Run with: RUN_DB_TESTS=true npm test
// ---------------------------------------------------------------------------

const enabled = shouldRunDbTests();

const randomUuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('immutable ledger', () => {
  let orderId: string;

  beforeEach(() => {
    // A fresh order id per test gives each one its own hash chain, so tests do
    // not interfere and the table never needs clearing — which is just as well,
    // because it cannot be.
    orderId = randomUuid();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function append(event: string, toState: string, detail?: Record<string, unknown>) {
    await withTransaction(async (tx) => {
      await recordTransition(tx, {
        entity: 'order',
        entityId: orderId,
        event,
        fromState: null,
        toState,
        actor: 'test',
        orderId,
        amountCents: 100_000,
        detail: detail ?? { note: 'test entry' },
      });
    });
  }

  it('stamps a hash chain, linking each entry to the previous one', async () => {
    await append('order.created', 'pending');
    await append('order.awaiting_payment', 'awaiting_payment');
    await append('order.paid', 'paid');

    const history = await getOrderHistory(orderId);
    expect(history).toHaveLength(3);

    // First entry in a chain has no predecessor.
    expect(history[0]!.prevHash).toBeNull();
    expect(history[0]!.entryHash).toMatch(/^[0-9a-f]{64}$/);

    // Each subsequent entry points at the one before it.
    expect(history[1]!.prevHash).toBe(history[0]!.entryHash);
    expect(history[2]!.prevHash).toBe(history[1]!.entryHash);

    // And the placeholder the application sends is never what lands.
    expect(history[0]!.entryHash).not.toBe('set-by-trigger');
  });

  it('verifies a chain that has not been tampered with', async () => {
    await append('order.created', 'pending');
    await append('order.paid', 'paid');

    const result = await verifyChain({ orderId });
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(2);
  });

  it('refuses UPDATE, even as the table owner', async () => {
    await append('order.created', 'pending');

    await expect(
      db.execute(
        sql`UPDATE ledger_entries SET to_state = 'tampered' WHERE order_id = ${orderId}`,
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses DELETE, even as the table owner', async () => {
    await append('order.created', 'pending');

    await expect(
      db.execute(sql`DELETE FROM ledger_entries WHERE order_id = ${orderId}`),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses TRUNCATE', async () => {
    await expect(db.execute(sql`TRUNCATE ledger_entries`)).rejects.toThrow(
      /append-only/i,
    );
  });

  it('keeps the amount and receipt detail it was given', async () => {
    // The M-Pesa receipt is the field a buyer quotes in a dispute, so it is the
    // one that most needs to survive a round trip through jsonb unchanged.
    await append('payment.settled', 'succeeded', {
      receipt: 'RKT1A2B3C4',
      resultCode: 0,
    });

    const [entry] = await getOrderHistory(orderId);
    expect(entry!.detail).toEqual({ receipt: 'RKT1A2B3C4', resultCode: 0 });
    expect(entry!.amountCents).toBe(100_000);
  });

  it('rolls the entry back with the transaction that wrote it', async () => {
    // The ledger must never record something that did not happen. If the
    // surrounding transaction aborts, the entry must go with it.
    await expect(
      withTransaction(async (tx) => {
        await recordTransition(tx, {
          entity: 'order',
          entityId: orderId,
          event: 'order.created',
          fromState: null,
          toState: 'pending',
          actor: 'test',
          orderId,
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const history = await getOrderHistory(orderId);
    expect(history).toHaveLength(0);
  });

  it('serialises concurrent appends to one chain without duplicating a link', async () => {
    // Ten writers racing on the same order. The advisory lock in the trigger
    // must give them a total order, so no two entries share a prev_hash.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => append(`order.step${i}`, 'pending')),
    );

    const history = await getOrderHistory(orderId);
    expect(history).toHaveLength(10);

    const prevHashes = history.slice(1).map((entry) => entry.prevHash);
    expect(new Set(prevHashes).size).toBe(9);

    // Scoped to this test's own chain. An unscoped call would also verify every
    // other chain in the database, making the assertion depend on unrelated
    // rows — including any left behind by a previous run.
    const verified = await verifyChain({ orderId });
    expect(verified.valid).toBe(true);
  });

  it('rejects an application-supplied entry_hash', async () => {
    // The trigger overwrites whatever it is handed, so a caller cannot forge a
    // digest even by passing one explicitly.
    await withTransaction(async (tx) => {
      await tx.insert(ledgerEntries).values({
        entity: 'order',
        entityId: orderId,
        event: 'order.created',
        fromState: null,
        toState: 'pending',
        actor: 'test',
        orderId,
        entryHash: 'deadbeef',
        prevHash: 'forged',
      });
    });

    const [entry] = await getOrderHistory(orderId);
    expect(entry!.entryHash).not.toBe('deadbeef');
    expect(entry!.prevHash).toBeNull();
  });
});
