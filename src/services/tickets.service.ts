import { and, eq } from 'drizzle-orm';
import { db, withTransaction } from '../db/client.js';
import {
  orderItems,
  orders,
  tickets,
  type Ticket,
} from '../db/schema.js';
import { buildQrPayload, generateTicketCode, parseQrPayload } from '../lib/codes.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { recordTransition } from './ledger.service.js';

// ---------------------------------------------------------------------------
// Issuance
//
// Runs in the worker, never on the request path. Idempotent by construction:
// tickets carry a (order_item_id, sequence) unique key, so re-running the job
// inserts nothing the second time round.
// ---------------------------------------------------------------------------

export interface IssuedTicket {
  id: string;
  code: string;
  qr: string;
  tierName: string;
  status: Ticket['status'];
}

export async function issueTicketsForOrder(
  orderId: string,
): Promise<IssuedTicket[]> {
  const issued = await withTransaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);

    if (!order) throw notFound(`Order ${orderId} not found`);

    if (order.status !== 'paid') {
      throw conflict(
        'order_not_paid',
        `Cannot issue tickets for an order in status "${order.status}"`,
      );
    }

    if (order.metadata?.refundRequired === true) {
      throw conflict(
        'refund_required',
        'This order is flagged for refund; tickets will not be issued',
      );
    }

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    const existing = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.orderId, orderId));

    const countByItem = new Map<string, number>();
    for (const ticket of existing) {
      countByItem.set(
        ticket.orderItemId,
        (countByItem.get(ticket.orderItemId) ?? 0) + 1,
      );
    }

    const rows: Array<typeof tickets.$inferInsert> = [];

    for (const item of items) {
      const already = countByItem.get(item.id) ?? 0;
      for (let sequence = already + 1; sequence <= item.quantity; sequence += 1) {
        rows.push({
          eventId: order.eventId,
          orderId: order.id,
          orderItemId: item.id,
          tierId: item.tierId,
          code: generateTicketCode(),
          holderName: order.buyerName,
          holderEmail: order.buyerEmail,
          status: 'issued',
          sequence,
        });
      }
    }

    if (rows.length === 0) {
      // Already fully issued — a duplicate job run.
      return existing;
    }

    const inserted = await tx
      .insert(tickets)
      .values(rows)
      // A concurrent duplicate run loses the race harmlessly.
      .onConflictDoNothing({
        target: [tickets.orderItemId, tickets.sequence],
      })
      .returning();

    for (const ticket of inserted) {
      await recordTransition(tx, {
        entity: 'ticket',
        entityId: ticket.id,
        event: 'ticket.issued',
        fromState: null,
        toState: 'issued',
        actor: 'system:issuance',
        orderId: order.id,
        eventId: order.eventId,
        detail: { code: ticket.code, tierId: ticket.tierId, sequence: ticket.sequence },
      });
    }

    return [...existing, ...inserted];
  });

  const withNames = await attachTierNames(issued);

  logger.info(
    { orderId, count: withNames.length },
    'tickets issued',
  );

  return withNames;
}

async function attachTierNames(rows: Ticket[]): Promise<IssuedTicket[]> {
  if (rows.length === 0) return [];

  const items = await db
    .select({ id: orderItems.id, tierName: orderItems.tierName })
    .from(orderItems)
    .where(eq(orderItems.orderId, rows[0]!.orderId));

  const nameByItem = new Map(items.map((item) => [item.id, item.tierName]));

  return rows.map((ticket) => ({
    id: ticket.id,
    code: ticket.code,
    qr: buildQrPayload(ticket.code),
    tierName: nameByItem.get(ticket.orderItemId) ?? 'Ticket',
    status: ticket.status,
  }));
}

export async function getTicketsForOrder(orderId: string): Promise<IssuedTicket[]> {
  const rows = await db.select().from(tickets).where(eq(tickets.orderId, orderId));
  return attachTierNames(rows);
}

// ---------------------------------------------------------------------------
// Check-in
//
// Deliberately a SELECT … FOR UPDATE rather than a conditional UPDATE: the gate
// needs to distinguish "admitted" from "already admitted at 19:42", which means
// reading the row before deciding. Contention here is per-ticket, so it never
// becomes a hot row the way a tier does.
// ---------------------------------------------------------------------------

export interface CheckInResult {
  admitted: boolean;
  reason?: 'already_checked_in' | 'void' | 'order_not_paid';
  ticket: {
    code: string;
    holderName: string | null;
    tierName: string;
    eventId: string;
    status: Ticket['status'];
    checkedInAt: Date | null;
    checkedInBy: string | null;
  };
}

export async function checkInTicket(
  qrOrCode: string,
  options: { eventId?: string; scannedBy?: string } = {},
): Promise<CheckInResult> {
  const code = parseQrPayload(qrOrCode);
  if (!code) {
    throw badRequest('That QR code is not valid for this event');
  }

  return withTransaction(async (tx) => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.code, code))
      .for('update')
      .limit(1);

    if (!ticket) throw notFound(`No ticket matches code ${code}`);

    if (options.eventId && ticket.eventId !== options.eventId) {
      throw conflict('wrong_event', 'That ticket belongs to a different event');
    }

    const [item] = await tx
      .select({ tierName: orderItems.tierName })
      .from(orderItems)
      .where(eq(orderItems.id, ticket.orderItemId))
      .limit(1);

    const view = {
      code: ticket.code,
      holderName: ticket.holderName,
      tierName: item?.tierName ?? 'Ticket',
      eventId: ticket.eventId,
      status: ticket.status,
      checkedInAt: ticket.checkedInAt,
      checkedInBy: ticket.checkedInBy,
    };

    if (ticket.status === 'void') {
      return { admitted: false, reason: 'void' as const, ticket: view };
    }

    /**
     * The order, not just the ticket, has to still be good.
     *
     * `tickets.status` is a denormalisation: it is only correct if every state
     * that should stop admission remembers to write it. Voiding does. A refund
     * does not — `refunded` is a real order status, guarded against in
     * `releaseOrder` and filterable in the admin API, but nothing sets it and no
     * path voids the tickets behind it. The first refund this product processes
     * will very likely be a manual correction during a dispute, and the buyer
     * would keep a ticket that scans green for an event they were paid back for.
     *
     * Reading the order here makes admission derive from the authoritative
     * record instead, so refunds, chargebacks and any future reversal propagate
     * to the gate without a second place to remember. It costs one indexed read
     * inside a transaction that is already holding this ticket's row lock.
     */
    const [order] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, ticket.orderId))
      .limit(1);

    if (order?.status !== 'paid') {
      return { admitted: false, reason: 'order_not_paid' as const, ticket: view };
    }

    if (ticket.status === 'checked_in') {
      // Not an error — the gate wants to see when and where it was first used.
      return { admitted: false, reason: 'already_checked_in' as const, ticket: view };
    }

    const checkedInAt = new Date();

    await tx
      .update(tickets)
      .set({
        status: 'checked_in',
        checkedInAt,
        checkedInBy: options.scannedBy ?? null,
        updatedAt: checkedInAt,
      })
      .where(and(eq(tickets.id, ticket.id), eq(tickets.status, 'issued')));

    await recordTransition(tx, {
      entity: 'ticket',
      entityId: ticket.id,
      event: 'ticket.checked_in',
      fromState: 'issued',
      toState: 'checked_in',
      actor: options.scannedBy ? `scanner:${options.scannedBy}` : 'scanner:unknown',
      orderId: ticket.orderId,
      eventId: ticket.eventId,
      detail: { code: ticket.code, checkedInAt: checkedInAt.toISOString() },
    });

    return {
      admitted: true,
      ticket: {
        ...view,
        status: 'checked_in' as const,
        checkedInAt,
        checkedInBy: options.scannedBy ?? null,
      },
    };
  });
}

export async function voidTicket(
  code: string,
  reason?: string,
  actor = 'admin',
): Promise<void> {
  await withTransaction(async (tx) => {
    // Read before writing, so the ledger can record the state actually left
    // rather than an assumed one.
    const [before] = await tx
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.code, code))
      .for('update')
      .limit(1);

    if (!before) throw notFound(`No ticket matches code ${code}`);

    const result = await tx
      .update(tickets)
      .set({ status: 'void', updatedAt: new Date() })
      .where(eq(tickets.code, code))
      .returning();

    const voided = result[0];
    if (!voided) throw notFound(`No ticket matches code ${code}`);

    // Voiding is the one destructive act an admin can perform on a sold ticket,
    // so it is exactly what the ledger exists to record.
    //
    // `fromState` is read rather than assumed: voiding a ticket that had already
    // been checked in is precisely the case someone will later need to
    // reconstruct — somebody was admitted, and then the ticket was cancelled —
    // and hardcoding 'issued' erased the half of that story that mattered.
    await recordTransition(tx, {
      entity: 'ticket',
      entityId: voided.id,
      event: 'ticket.voided',
      fromState: before.status,
      toState: 'void',
      actor,
      orderId: voided.orderId,
      eventId: voided.eventId,
      detail: { code, reason: reason ?? null },
    });
  });

  logger.info({ code, reason, actor }, 'ticket voided');
}
