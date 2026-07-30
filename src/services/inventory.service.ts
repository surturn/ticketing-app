import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { withTransaction } from '../db/client.js';
import { orderItems, orders, ticketTiers } from '../db/schema.js';
import type { OrderStatus, TicketTier } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Inventory is three counters on ticket_tiers:
//
//   available = quantity_total - quantity_reserved - quantity_sold
//
// A checkout moves available → reserved. Settlement moves reserved → sold.
// An expiry or failure moves reserved → available.
//
// Every one of those transitions is a single conditional UPDATE. That matters:
// under a flash sale each tier row is a serialization point, and a
// SELECT-then-UPDATE would hold the row lock across two round trips instead of
// one. The CHECK constraint in the schema backstops all of it.
// ---------------------------------------------------------------------------

/** Deterministic lock ordering — two orders touching the same pair of tiers in
 *  opposite orders would otherwise deadlock. Sorting by id makes that
 *  impossible. */
export function sortForLocking<T extends { tierId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.tierId < b.tierId ? -1 : a.tierId > b.tierId ? 1 : 0));
}

export interface ReservationRequest {
  tierId: string;
  quantity: number;
}

/**
 * Atomically holds `quantity` seats on a tier.
 *
 * Returns the updated tier, or null when the UPDATE matched no row — which can
 * mean sold out, sales closed, tier paused, or wrong event. The caller
 * disambiguates, because doing so requires a second read we do not want inside
 * the hot path unless we already know we are failing.
 */
export async function reserveTier(
  tx: Tx,
  eventId: string,
  request: ReservationRequest,
): Promise<TicketTier | null> {
  const rows = await tx
    .update(ticketTiers)
    .set({
      quantityReserved: sql`${ticketTiers.quantityReserved} + ${request.quantity}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ticketTiers.id, request.tierId),
        eq(ticketTiers.eventId, eventId),
        eq(ticketTiers.status, 'active'),
        sql`${request.quantity} BETWEEN ${ticketTiers.minPerOrder} AND ${ticketTiers.maxPerOrder}`,
        sql`(${ticketTiers.salesStartAt} IS NULL OR ${ticketTiers.salesStartAt} <= now())`,
        sql`(${ticketTiers.salesEndAt} IS NULL OR ${ticketTiers.salesEndAt} > now())`,
        // The oversell guard, evaluated inside the same statement that mutates.
        sql`${ticketTiers.quantityTotal} - ${ticketTiers.quantityReserved} - ${ticketTiers.quantitySold} >= ${request.quantity}`,
      ),
    )
    .returning();

  return rows[0] ?? null;
}

/** Explains a failed reservation, for a useful error message. */
export async function explainReservationFailure(
  tx: Tx,
  eventId: string,
  request: ReservationRequest,
): Promise<never> {
  const [tier] = await tx
    .select()
    .from(ticketTiers)
    .where(and(eq(ticketTiers.id, request.tierId), eq(ticketTiers.eventId, eventId)))
    .limit(1);

  if (!tier) {
    throw notFound(`Ticket tier ${request.tierId} does not belong to this event`);
  }

  if (tier.status !== 'active') {
    throw conflict('tier_unavailable', `"${tier.name}" is not currently on sale`);
  }

  const now = Date.now();
  if (tier.salesStartAt && tier.salesStartAt.getTime() > now) {
    throw conflict(
      'sales_not_open',
      `Sales for "${tier.name}" open at ${tier.salesStartAt.toISOString()}`,
      { details: { salesStartAt: tier.salesStartAt } },
    );
  }
  if (tier.salesEndAt && tier.salesEndAt.getTime() <= now) {
    throw conflict('sales_closed', `Sales for "${tier.name}" have closed`);
  }

  if (request.quantity < tier.minPerOrder || request.quantity > tier.maxPerOrder) {
    throw conflict(
      'quantity_out_of_bounds',
      `"${tier.name}" allows between ${tier.minPerOrder} and ${tier.maxPerOrder} tickets per order`,
      { details: { minPerOrder: tier.minPerOrder, maxPerOrder: tier.maxPerOrder } },
    );
  }

  const available = tier.quantityTotal - tier.quantityReserved - tier.quantitySold;
  throw conflict(
    'insufficient_inventory',
    available <= 0
      ? `"${tier.name}" is sold out`
      : `Only ${available} ticket(s) left for "${tier.name}"`,
    // Retryable: held-but-unpaid seats may return to the pool shortly.
    { details: { available, requested: request.quantity }, retryable: available > 0 },
  );
}

// ---------------------------------------------------------------------------
// Release — hold lapsed, payment failed, or buyer cancelled
// ---------------------------------------------------------------------------

export interface ReleaseResult {
  released: boolean;
  status: OrderStatus;
}

/**
 * Returns an order's held seats to the pool and moves it to a terminal status.
 *
 * `released_at` makes this idempotent: the expiry worker, a failed callback and
 * the reconciler can all race to release the same order, and only the first
 * one moves the counters.
 */
export async function releaseOrder(
  orderId: string,
  terminalStatus: Extract<
    OrderStatus,
    'expired' | 'failed' | 'cancelled'
  > = 'expired',
): Promise<ReleaseResult> {
  return withTransaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);

    if (!order) throw notFound(`Order ${orderId} not found`);

    // Already settled or already released — nothing to give back.
    if (order.releasedAt || order.status === 'paid' || order.status === 'refunded') {
      return { released: false, status: order.status };
    }

    if (order.status !== 'pending' && order.status !== 'awaiting_payment') {
      return { released: false, status: order.status };
    }

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    for (const item of sortForLocking(items)) {
      await tx
        .update(ticketTiers)
        .set({
          // GREATEST guards the counter against ever going negative, even if a
          // prior bug double-released.
          quantityReserved: sql`GREATEST(${ticketTiers.quantityReserved} - ${item.quantity}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(ticketTiers.id, item.tierId));
    }

    await tx
      .update(orders)
      .set({ status: terminalStatus, releasedAt: new Date(), updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return { released: true, status: terminalStatus };
  });
}

// ---------------------------------------------------------------------------
// Commit — payment settled, convert the hold into a sale
// ---------------------------------------------------------------------------

export interface CommitResult {
  committed: boolean;
  alreadyPaid: boolean;
  /** True when the hold had already lapsed and the seats could not be
   *  recovered — the buyer has paid for tickets we cannot issue. */
  requiresRefund: boolean;
}

/**
 * Moves an order's seats from reserved to sold.
 *
 * The awkward case is a late success: the hold expired, the seats went back on
 * sale, and *then* the buyer's payment landed. We try to take the seats from
 * general availability instead; if the event has since sold out, the order is
 * flagged for refund rather than quietly issuing tickets that do not exist.
 */
export async function commitOrder(orderId: string): Promise<CommitResult> {
  return withTransaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);

    if (!order) throw notFound(`Order ${orderId} not found`);

    if (order.status === 'paid') {
      return { committed: false, alreadyPaid: true, requiresRefund: false };
    }

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    const holdLapsed = Boolean(order.releasedAt);
    let requiresRefund = false;

    for (const item of sortForLocking(items)) {
      if (holdLapsed) {
        // Seats were already returned to the pool — re-take them from
        // availability, which may now fail.
        const rows = await tx
          .update(ticketTiers)
          .set({
            quantitySold: sql`${ticketTiers.quantitySold} + ${item.quantity}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ticketTiers.id, item.tierId),
              sql`${ticketTiers.quantityTotal} - ${ticketTiers.quantityReserved} - ${ticketTiers.quantitySold} >= ${item.quantity}`,
            ),
          )
          .returning({ id: ticketTiers.id });

        if (rows.length === 0) {
          requiresRefund = true;
          logger.error(
            { orderId, tierId: item.tierId, quantity: item.quantity },
            'late payment settled after hold lapsed and tier is now sold out — refund required',
          );
        }
      } else {
        await tx
          .update(ticketTiers)
          .set({
            quantityReserved: sql`GREATEST(${ticketTiers.quantityReserved} - ${item.quantity}, 0)`,
            quantitySold: sql`${ticketTiers.quantitySold} + ${item.quantity}`,
            updatedAt: new Date(),
          })
          .where(eq(ticketTiers.id, item.tierId));
      }
    }

    await tx
      .update(orders)
      .set({
        status: 'paid',
        paidAt: new Date(),
        updatedAt: new Date(),
        // Cleared so a later expiry sweep does not try to release a paid order.
        releasedAt: null,
        metadata: requiresRefund
          ? { ...(order.metadata ?? {}), refundRequired: true }
          : (order.metadata ?? null),
      })
      .where(eq(orders.id, orderId));

    return { committed: true, alreadyPaid: false, requiresRefund };
  });
}
