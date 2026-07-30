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
  buyer: { name: string; email: string | null; phone: string };
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
  tickets: IssuedTicket[];
}

async function buildView(order: Order): Promise<OrderView> {
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
    tickets: issued,
  };
}

export async function getOrderByReference(reference: string): Promise<OrderView> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.reference, reference))
    .limit(1);

  if (!order) throw notFound(`No order with reference ${reference}`);
  return buildView(order);
}

export async function getOrderById(id: string): Promise<OrderView> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound(`No order with id ${id}`);
  return buildView(order);
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
