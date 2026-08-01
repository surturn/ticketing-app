import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, orderItems, orders, payments } from '../db/schema.js';
import type { Order } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { maskPhone } from '../lib/phone.js';
import { getTicketsForOrder, type IssuedTicket } from './tickets.service.js';

// ---------------------------------------------------------------------------
// Order read model — what the sale page polls while the buyer is on the STK
// prompt, and what the confirmation page renders afterwards.
//
// Not cached: it is per-buyer, changes the moment a callback lands, and a stale
// "still pending" would strand someone who has already paid.
// ---------------------------------------------------------------------------

export interface OrderView {
  reference: string;
  status: Order['status'];
  event: { slug: string; name: string; startsAt: Date; venue: string | null };
  buyer: { name: string; email: string; phone: string };
  items: Array<{
    tierName: string;
    quantity: number;
    unitPriceCents: number;
    subtotalCents: number;
  }>;
  totalCents: number;
  currency: string;
  expiresAt: Date;
  paidAt: Date | null;
  payment: {
    status: string;
    gateway: string;
    receipt: string | null;
    resultDesc: string | null;
  } | null;
  tickets: Array<IssuedTicket | (Omit<IssuedTicket, 'qr' | 'code'> & { qr: null; code: null })>;
  /** True when tickets exist but their scannable payloads were withheld. */
  ticketsRedacted: boolean;
}

/**
 * Who is asking, so far as the token proved it.
 *
 * `null` for a guest, or for anyone holding only the reference — which is most
 * callers, and legitimately so.
 */
export interface OrderViewer {
  uid: string | null;
}

async function buildView(order: Order, viewer: OrderViewer): Promise<OrderView> {
  const [event] = await db
    .select({
      slug: events.slug,
      name: events.name,
      startsAt: events.startsAt,
      venue: events.venue,
    })
    .from(events)
    .where(eq(events.id, order.eventId))
    .limit(1);

  const items = await db
    .select({
      tierName: orderItems.tierName,
      quantity: orderItems.quantity,
      unitPriceCents: orderItems.unitPriceCents,
      subtotalCents: orderItems.subtotalCents,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, order.id))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  // Tickets only exist once the order is paid and the issuance job has run.
  const issued = order.status === 'paid' ? await getTicketsForOrder(order.id) : [];

  /**
   * The QR payload is the credential, not the receipt.
   *
   * Anyone holding the reference can read this endpoint — that is the only way
   * a guest checkout can ever show someone their ticket, and it is not going to
   * change. But a reference travels: it is in the URL bar, in the confirmation
   * email, in the screenshot people post to a WhatsApp group the moment they
   * have tickets to an event their friends want. Whoever sees it could, until
   * now, render a working QR and be admitted first — and because the first scan
   * wins, the buyer who actually paid is the one turned away at the door.
   *
   * So the scannable payload is withheld unless the order belongs to the
   * account asking for it. The order itself still resolves for a guest with the
   * link: they see what they bought, what they paid, and that their tickets
   * exist — everything except the part that opens a gate. Signing in is what
   * turns a link that anyone could forward into a credential only its owner can
   * use, and it is the reason the account exists at all.
   */
  const ownsOrder = viewer.uid !== null && order.userId === viewer.uid;

  const visibleTickets = ownsOrder
    ? issued
    : issued.map(({ qr: _qr, code: _code, ...rest }) => ({
        ...rest,
        qr: null,
        code: null,
      }));

  return {
    reference: order.reference,
    status: order.status,
    event: {
      slug: event?.slug ?? '',
      name: event?.name ?? '',
      startsAt: event?.startsAt ?? new Date(0),
      venue: event?.venue ?? null,
    },
    buyer: {
      name: order.buyerName,
      email: order.buyerEmail,
      phone: maskPhone(order.buyerPhone),
    },
    items,
    totalCents: order.totalCents,
    currency: order.currency,
    expiresAt: order.reservedUntil,
    paidAt: order.paidAt,
    payment: payment
      ? {
          status: payment.status,
          gateway: payment.gateway,
          receipt: payment.receipt,
          resultDesc: payment.resultDesc,
        }
      : null,
    tickets: visibleTickets,
    /**
     * Whether the scannable payloads were included.
     *
     * Stated rather than left to be inferred from a null: the order page needs
     * to tell a guest "sign in to show your ticket at the gate" instead of
     * rendering an empty box, and a client cannot distinguish "withheld" from
     * "not issued yet" by looking at the value alone.
     */
    ticketsRedacted: !ownsOrder && issued.length > 0,
  };
}

export async function getOrderByReference(
  reference: string,
  viewer: OrderViewer = { uid: null },
): Promise<OrderView> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.reference, reference))
    .limit(1);

  if (!order) throw notFound(`No order with reference ${reference}`);
  return buildView(order, viewer);
}

export async function getOrderById(
  id: string,
  viewer: OrderViewer = { uid: null },
): Promise<OrderView> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound(`No order with id ${id}`);
  return buildView(order, viewer);
}

/** Lightweight status poll — avoids rebuilding the whole view every 2 seconds. */
export async function getOrderStatus(reference: string): Promise<{
  reference: string;
  status: Order['status'];
  paidAt: Date | null;
  expiresAt: Date;
  ticketCount: number;
  payment: { status: string; receipt: string | null; resultDesc: string | null } | null;
}> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.reference, reference))
    .limit(1);

  if (!order) throw notFound(`No order with reference ${reference}`);

  const [payment] = await db
    .select({
      status: payments.status,
      receipt: payments.receipt,
      resultDesc: payments.resultDesc,
    })
    .from(payments)
    .where(eq(payments.orderId, order.id))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  const issued = order.status === 'paid' ? await getTicketsForOrder(order.id) : [];

  return {
    reference: order.reference,
    status: order.status,
    paidAt: order.paidAt,
    expiresAt: order.reservedUntil,
    ticketCount: issued.length,
    payment: payment ?? null,
  };
}
