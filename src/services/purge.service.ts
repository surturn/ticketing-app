import { and, eq, inArray, lt, notExists, sql } from 'drizzle-orm';
import { db, withTransaction } from '../db/client.js';
import { orderItems, orders, payments, tickets } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { recordStandaloneTransition } from './ledger.service.js';

// ---------------------------------------------------------------------------
// Purging abandoned orders.
//
// The rest of this system deliberately never deletes, and that default is
// right: an automatic job that removes rows will eventually remove a payment
// record nobody meant to lose. This is the one exception, and it is narrow
// enough to state in a sentence — an order that reached no payment, issued no
// ticket, and has sat dead for a month is not a financial record. It is
// somebody who opened a checkout and closed the tab.
//
// Three conditions, all required, and the second two are what make this safe:
//
//   1. Status is expired, failed or cancelled. A pending or paid order is never
//      touched, whatever its age.
//   2. No payment row exists. This is the important one. A cancelled order that
//      *did* reach M-Pesa has a payment record, and that record is evidence —
//      it stays for as long as everything else does.
//   3. No ticket was issued. Belt and braces behind (2): an order that produced
//      admission is a thing that happened.
//
// Age is measured from creation rather than from the status change, because a
// delayed callback can settle an order long after its hold lapsed. Thirty days
// is far outside any window in which that is still possible.
// ---------------------------------------------------------------------------

/** Statuses that can be purged. Everything else is left alone at any age. */
const PURGEABLE = ['expired', 'failed', 'cancelled'] as const;

export interface PurgeResult {
  purged: number;
  references: string[];
}

/**
 * Removes orders that were abandoned before any money or ticket existed.
 *
 * Returns what it removed, so the caller can log it. The ledger keeps a record
 * of each removal: its `order_id` is denormalised with no foreign key, which is
 * exactly so an entry can outlive the row it describes. Deleting an order
 * therefore leaves a trail rather than a hole.
 */
export async function purgeAbandonedOrders(afterDays: number): Promise<PurgeResult> {
  const cutoff = new Date(Date.now() - afterDays * 86_400_000);

  const candidates = await db
    .select({
      id: orders.id,
      reference: orders.reference,
      status: orders.status,
      eventId: orders.eventId,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.status, [...PURGEABLE]),
        lt(orders.createdAt, cutoff),
        // Correlated NOT EXISTS rather than a join: a join would multiply rows
        // and then need distinct, and this reads as the rule it enforces.
        notExists(
          db.select({ one: sql`1` }).from(payments).where(eq(payments.orderId, orders.id)),
        ),
        notExists(
          db.select({ one: sql`1` }).from(tickets).where(eq(tickets.orderId, orders.id)),
        ),
      ),
    )
    // Bounded per run. A first run after months of accumulation should not open
    // a transaction over tens of thousands of rows; the job repeats, so the
    // backlog drains over successive passes rather than in one long lock.
    .limit(500);

  if (candidates.length === 0) return { purged: 0, references: [] };

  const ids = candidates.map((order) => order.id);

  await withTransaction(async (tx) => {
    // Children first. `order_items` has no cascade, and tickets are already
    // known to be absent by the query above.
    await tx.delete(orderItems).where(inArray(orderItems.orderId, ids));
    await tx.delete(orders).where(inArray(orders.id, ids));
  });

  // Written after the delete rather than inside it: the ledger is append-only
  // and hash-chained, and a failed transaction that had already appended would
  // leave an entry describing something that did not happen.
  for (const order of candidates) {
    await recordStandaloneTransition({
      entity: 'order',
      entityId: order.id,
      event: 'order.purged',
      fromState: order.status,
      toState: 'purged',
      actor: 'system:maintenance',
      orderId: order.id,
      eventId: order.eventId,
      detail: {
        reference: order.reference,
        createdAt: order.createdAt.toISOString(),
        afterDays,
        // Recorded so the entry itself shows why removal was permitted.
        hadPayment: false,
        hadTickets: false,
      },
    });
  }

  logger.info(
    { count: candidates.length, afterDays, cutoff: cutoff.toISOString() },
    'purged abandoned orders',
  );

  return { purged: candidates.length, references: candidates.map((o) => o.reference) };
}
