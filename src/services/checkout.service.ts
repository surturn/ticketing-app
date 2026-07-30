import { and, eq, inArray } from 'drizzle-orm';
import { db, withTransaction } from '../db/client.js';
import {
  orderItems,
  orders,
  payments,
  ticketTiers,
  type Order,
} from '../db/schema.js';
import { DEFAULT_GATEWAY, getGateway } from '../gateways/registry.js';
import type { GatewayName } from '../gateways/types.js';
import { invalidateEvent } from '../lib/cache.js';
import { generateOrderReference } from '../lib/codes.js';
import { AppError, badRequest, conflict, isRetryablePgError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { centsToMpesaAmount } from '../lib/money.js';
import {
  cancelOrderExpiry,
  scheduleOrderExpiry,
  scheduleReconcile,
} from '../queue/queues.js';
import { env } from '../config/env.js';
import { getEventRowBySlug } from './events.service.js';
import { recordTransition } from './ledger.service.js';
import {
  availableSeats,
  explainReservationFailure,
  hasRoomFor,
  releaseOrder,
  reserveTier,
  sortForLocking,
} from './inventory.service.js';

// ---------------------------------------------------------------------------
// Checkout
//
// The request path does exactly two things that cannot be deferred:
//   1. hold the inventory (one short transaction, no network calls inside it)
//   2. authorise the payment (one call to the gateway, after the commit)
//
// Ticket generation, receipts and reconciliation are all queued. That keeps the
// p99 of this endpoint bounded by Postgres + Daraja, not by anything else.
// ---------------------------------------------------------------------------

export interface CheckoutItemInput {
  tierId: string;
  quantity: number;
}

export interface BuyerInput {
  name: string;
  /** Mandatory — validated and lowercased at the route boundary. */
  email: string;
  /** Already normalised to 254… by the route schema. */
  phone: string;
}

export interface CheckoutInput {
  eventSlug: string;
  items: CheckoutItemInput[];
  buyer: BuyerInput;
  idempotencyKey?: string;
  gateway?: GatewayName;
  metadata?: Record<string, unknown>;
  /**
   * Account to attach the order to, or null for a guest purchase.
   *
   * Must come from a verified token at the route boundary. Accepting it as a
   * plain string here is safe only because no route passes anything a caller
   * supplied.
   */
  userId?: string | null;
}

export interface CheckoutResult {
  orderId: string;
  reference: string;
  status: Order['status'];
  totalCents: number;
  currency: string;
  expiresAt: Date;
  payment: {
    gateway: GatewayName;
    gatewayRef: string;
    customerMessage: string;
  } | null;
  /** True when a retried Idempotency-Key returned the original order. */
  idempotentReplay: boolean;
}

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PG_UNIQUE_VIOLATION;
}

async function findByIdempotencyKey(key: string): Promise<Order | undefined> {
  const [existing] = await db
    .select()
    .from(orders)
    .where(eq(orders.idempotencyKey, key))
    .limit(1);
  return existing;
}

async function buildReplayResult(order: Order): Promise<CheckoutResult> {
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, order.id))
    .limit(1);

  return {
    orderId: order.id,
    reference: order.reference,
    status: order.status,
    totalCents: order.totalCents,
    currency: order.currency,
    expiresAt: order.reservedUntil,
    payment: payment
      ? {
          gateway: payment.gateway as GatewayName,
          gatewayRef: payment.gatewayRef,
          customerMessage: 'Check your phone to complete the M-Pesa payment.',
        }
      : null,
    idempotentReplay: true,
  };
}

export async function createCheckout(
  input: CheckoutInput,
): Promise<CheckoutResult> {
  // ─── Validate the basket shape before touching the database ─────────────
  if (input.items.length === 0) {
    throw badRequest('Your basket is empty');
  }

  const seenTiers = new Set<string>();
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw badRequest('Each item needs a whole quantity of at least 1');
    }
    if (seenTiers.has(item.tierId)) {
      throw badRequest(
        'Each ticket tier may appear only once — combine them into a single quantity',
      );
    }
    seenTiers.add(item.tierId);
  }

  const phone = normalizePhone(input.buyer.phone);
  const gatewayName = input.gateway ?? DEFAULT_GATEWAY;
  const gateway = getGateway(gatewayName);

  if (!gateway.isConfigured()) {
    throw new AppError(
      503,
      'gateway_not_configured',
      `The ${gatewayName} gateway is not configured on this server`,
    );
  }

  // ─── Idempotency fast path ──────────────────────────────────────────────
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(input.idempotencyKey);
    if (existing) return buildReplayResult(existing);
  }

  const event = await getEventRowBySlug(input.eventSlug);

  if (event.status !== 'published') {
    throw conflict('event_not_on_sale', `"${event.name}" is not currently on sale`);
  }

  const reference = generateOrderReference();
  const reservedUntil = new Date(Date.now() + env.ORDER_HOLD_MINUTES * 60_000);

  // ─── Hold the inventory ─────────────────────────────────────────────────
  //
  // Short, lock-ordered, and entirely local to Postgres. `lock_timeout` from
  // withTransaction means a contended tier fails fast rather than pinning a
  // pooled connection while the queue behind it grows.
  let order: Order;
  try {
    order = await withTransaction(async (tx) => {
      const requests = sortForLocking(
        input.items.map((item) => ({ tierId: item.tierId, quantity: item.quantity })),
      );

      const reservedTiers = new Map<string, { name: string; priceCents: number }>();

      for (const request of requests) {
        const tier = await reserveTier(tx, event.id, request);
        if (!tier) {
          // Only now do we spend a read working out *why* it failed.
          await explainReservationFailure(tx, event.id, request);
        }
        reservedTiers.set(request.tierId, {
          name: tier!.name,
          priceCents: tier!.priceCents,
        });
      }

      const lines = input.items.map((item) => {
        const tier = reservedTiers.get(item.tierId)!;
        return {
          tierId: item.tierId,
          tierName: tier.name,
          quantity: item.quantity,
          unitPriceCents: tier.priceCents,
          subtotalCents: tier.priceCents * item.quantity,
        };
      });

      const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);

      const [created] = await tx
        .insert(orders)
        .values({
          eventId: event.id,
          reference,
          userId: input.userId ?? null,
          buyerName: input.buyer.name,
          buyerEmail: input.buyer.email,
          buyerPhone: phone,
          subtotalCents,
          feeCents: 0,
          totalCents: subtotalCents,
          currency: event.currency,
          status: 'pending',
          reservedUntil,
          idempotencyKey: input.idempotencyKey ?? null,
          metadata: input.metadata ?? null,
        })
        .returning();

      await tx.insert(orderItems).values(
        lines.map((line) => ({ ...line, orderId: created!.id })),
      );

      await recordTransition(tx, {
        entity: 'order',
        entityId: created!.id,
        event: 'order.created',
        fromState: null,
        toState: 'pending',
        actor: 'system:checkout',
        orderId: created!.id,
        eventId: event.id,
        amountCents: subtotalCents,
        detail: {
          reference,
          items: lines.map((line) => ({
            tierId: line.tierId,
            tierName: line.tierName,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
          })),
        },
      });

      // Inventory moved available → reserved for each tier in this basket.
      for (const line of lines) {
        await recordTransition(tx, {
          entity: 'inventory',
          entityId: line.tierId,
          event: 'inventory.reserved',
          fromState: 'available',
          toState: 'reserved',
          actor: 'system:checkout',
          orderId: created!.id,
          eventId: event.id,
          detail: { quantity: line.quantity, tierName: line.tierName },
        });
      }

      return created!;
    });
  } catch (error) {
    // A concurrent request with the same Idempotency-Key won the race; its
    // order is the canonical one and ours rolled back cleanly.
    if (isUniqueViolation(error) && input.idempotencyKey) {
      const existing = await findByIdempotencyKey(input.idempotencyKey);
      if (existing) return buildReplayResult(existing);
    }

    if (isRetryablePgError(error)) {
      throw conflict(
        'inventory_contended',
        'That ticket tier is busy right now. Please try again.',
        { retryable: true },
      );
    }

    throw error;
  }

  // Seats are held — the sale page should stop advertising them. A cache miss
  // is harmless (the next read repopulates it), so this must never be the thing
  // that fails a checkout.
  await invalidateEvent(event.id, event.slug).catch((error: unknown) => {
    logger.warn({ err: error, eventId: event.id }, 'could not invalidate event cache');
  });

  // ─── Everything past the commit must be covered by the release ───────────
  //
  // Inventory is held from here on. Anything that throws before the order
  // reaches `awaiting_payment` has to give those seats back, which is why
  // scheduling the expiry is *inside* this try rather than before it: a throw
  // from `queue.add` would otherwise strand the seats permanently — held, with
  // no expiry job to release them and no compensating path to run. That is
  // exactly how a colon in a BullMQ job id took every checkout down.
  try {
    await scheduleOrderExpiry(order.id, reservedUntil);

    const charge = await gateway.charge({
      orderId: order.id,
      reference: order.reference,
      amountCents: order.totalCents,
      currency: order.currency,
      phone,
      description: `Tickets ${order.reference}`,
    });

    // One transaction, not two statements. A crash between the payment INSERT
    // and the status UPDATE would otherwise leave a pending payment attached to
    // a `pending` order — money in flight against an order that does not know
    // it is being paid for.
    const payment = await withTransaction(async (tx) => {
      const [row] = await tx
        .insert(payments)
        .values({
          orderId: order.id,
          gateway: gatewayName,
          gatewayRef: charge.gatewayRef,
          merchantRef: charge.merchantRef ?? null,
          amountCents: order.totalCents,
          currency: order.currency,
          payerPhone: phone,
          status: 'pending',
          rawRequest: charge.raw,
        })
        .returning();

      await tx
        .update(orders)
        .set({ status: 'awaiting_payment', updatedAt: new Date() })
        .where(eq(orders.id, order.id));

      await recordTransition(tx, {
        entity: 'payment',
        entityId: row!.id,
        event: 'payment.initiated',
        fromState: null,
        toState: 'pending',
        actor: 'system:checkout',
        orderId: order.id,
        amountCents: order.totalCents,
        detail: { gateway: gatewayName, gatewayRef: charge.gatewayRef },
      });

      await recordTransition(tx, {
        entity: 'order',
        entityId: order.id,
        event: 'order.awaiting_payment',
        fromState: 'pending',
        toState: 'awaiting_payment',
        actor: 'system:checkout',
        orderId: order.id,
        amountCents: order.totalCents,
      });

      return row!;
    });

    // Chase this payment if Safaricom's callback never arrives.
    await scheduleReconcile(payment.id, 1);

    return {
      orderId: order.id,
      reference: order.reference,
      status: 'awaiting_payment',
      totalCents: order.totalCents,
      currency: order.currency,
      expiresAt: reservedUntil,
      payment: {
        gateway: gatewayName,
        gatewayRef: charge.gatewayRef,
        customerMessage:
          charge.customerMessage ??
          'Check your phone to complete the M-Pesa payment.',
      },
      idempotentReplay: false,
    };
  } catch (error) {
    // The gateway refused or timed out, or the queue would not accept the job.
    // Either way the seats go back immediately rather than making the buyer wait
    // out the full hold.
    logger.error(
      { err: error, orderId: order.id, reference: order.reference },
      'checkout failed after inventory was held — releasing it',
    );

    await releaseOrder(order.id, 'failed').catch((releaseError: unknown) => {
      // The expiry worker is the backstop if this fails.
      logger.error(
        { err: releaseError, orderId: order.id },
        'failed to release inventory after a failed charge',
      );
    });
    await cancelOrderExpiry(order.id);
    await invalidateEvent(event.id, event.slug).catch(() => {});

    if (error instanceof AppError) throw error;

    // A non-AppError here is ours, not Safaricom's — a queue rejection, a Redis
    // outage. Saying "we could not reach M-Pesa" would send an operator to the
    // wrong system, so the message stays about us while the log carries the
    // detail.
    throw new AppError(
      503,
      'checkout_failed',
      'We could not start your payment. Please try again.',
      { retryable: true },
    );
  }
}

// ---------------------------------------------------------------------------
// Cancellation — buyer backed out before paying
// ---------------------------------------------------------------------------

export async function cancelOrder(reference: string): Promise<{ status: string }> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.reference, reference))
    .limit(1);

  if (!order) throw badRequest(`No order with reference ${reference}`);

  if (order.status === 'paid') {
    throw conflict('order_already_paid', 'This order has already been paid');
  }

  const result = await releaseOrder(order.id, 'cancelled');
  await cancelOrderExpiry(order.id);
  await invalidateEvent(order.eventId);

  return { status: result.status };
}

// ---------------------------------------------------------------------------
// Preview — confirm the buyer's details and the price before any money moves
//
// The point is to make the frontend's confirm screen show exactly what the
// server will do, using the server's own normalisation. A buyer typing
// `0712 345 678` should see `254712345678` before they commit, not discover it
// on an M-Pesa prompt they did not expect.
//
// Nothing here mutates: no inventory is held, no gateway is called. Availability
// is reported as of *now* and may change before checkout — that is inherent to a
// flash sale, and is why `availableNow` is labelled rather than promised.
// ---------------------------------------------------------------------------

export interface CheckoutPreview {
  event: { slug: string; name: string; currency: string; startsAt: Date };
  buyer: BuyerInput;
  items: Array<{
    tierId: string;
    tierName: string;
    quantity: number;
    unitPriceCents: number;
    subtotalCents: number;
    /** Seats left, or `null` when the tier has no capacity limit. */
    availableNow: number | null;
    uncapped: boolean;
    soldOut: boolean;
    sufficient: boolean;
  }>;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
  /** Whole shillings that will be charged — what the STK prompt will show. */
  mpesaAmount: number;
  holdMinutes: number;
  /** False when something would fail today; `issues` says what. */
  chargeable: boolean;
  issues: string[];
}

export async function previewCheckout(input: {
  eventSlug: string;
  items: CheckoutItemInput[];
  buyer: BuyerInput;
}): Promise<CheckoutPreview> {
  const issues: string[] = [];

  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.tierId)) {
      throw badRequest(
        'Each ticket tier may appear only once — combine them into a single quantity',
      );
    }
    seen.add(item.tierId);
  }

  const event = await getEventRowBySlug(input.eventSlug);

  if (event.status !== 'published') {
    issues.push(`"${event.name}" is not currently on sale`);
  }

  const tiers = await db
    .select()
    .from(ticketTiers)
    .where(
      and(
        eq(ticketTiers.eventId, event.id),
        inArray(
          ticketTiers.id,
          input.items.map((item) => item.tierId),
        ),
      ),
    );

  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));

  const lines = input.items.map((item) => {
    const tier = tierById.get(item.tierId);
    if (!tier) {
      throw badRequest(`Unknown ticket tier ${item.tierId} for "${event.name}"`);
    }

    const availableNow = availableSeats(tier);
    const sufficient = hasRoomFor(tier, item.quantity);

    if (!sufficient && availableNow !== null) {
      issues.push(
        availableNow <= 0
          ? `"${tier.name}" is sold out`
          : `Only ${availableNow} ticket(s) left for "${tier.name}"`,
      );
    }
    if (tier.status === 'closed') {
      issues.push(`"${tier.name}" is sold out`);
    } else if (tier.status !== 'active') {
      issues.push(`"${tier.name}" is not currently on sale`);
    }
    if (item.quantity < tier.minPerOrder || item.quantity > tier.maxPerOrder) {
      issues.push(
        `"${tier.name}" allows between ${tier.minPerOrder} and ${tier.maxPerOrder} tickets per order`,
      );
    }

    return {
      tierId: tier.id,
      tierName: tier.name,
      quantity: item.quantity,
      unitPriceCents: tier.priceCents,
      subtotalCents: tier.priceCents * item.quantity,
      availableNow,
      uncapped: availableNow === null,
      soldOut: tier.status === 'closed' || (availableNow !== null && availableNow <= 0),
      sufficient: sufficient && tier.status !== 'closed',
    };
  });

  const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  const totalCents = subtotalCents;

  // Surface the whole-shillings problem here rather than at charge time: M-Pesa
  // cannot take 1250.50, and finding that out mid-checkout costs the seats.
  let mpesaAmount = 0;
  try {
    mpesaAmount = centsToMpesaAmount(totalCents);
  } catch (error) {
    issues.push(error instanceof AppError ? error.message : 'Amount is not chargeable');
  }

  return {
    event: {
      slug: event.slug,
      name: event.name,
      currency: event.currency,
      startsAt: event.startsAt,
    },
    // Echoed back post-normalisation so the client can show what will be stored.
    buyer: input.buyer,
    items: lines,
    subtotalCents,
    feeCents: 0,
    totalCents,
    currency: event.currency,
    mpesaAmount,
    holdMinutes: env.ORDER_HOLD_MINUTES,
    chargeable: issues.length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Helper used by admin tooling to preview a basket's price without holding it.
// ---------------------------------------------------------------------------

export async function quoteBasket(
  eventSlug: string,
  items: CheckoutItemInput[],
): Promise<{ subtotalCents: number; currency: string }> {
  const event = await getEventRowBySlug(eventSlug);

  const tiers = await db
    .select()
    .from(ticketTiers)
    .where(
      and(
        eq(ticketTiers.eventId, event.id),
        inArray(
          ticketTiers.id,
          items.map((item) => item.tierId),
        ),
      ),
    );

  const priceByTier = new Map(tiers.map((tier) => [tier.id, tier.priceCents]));

  const subtotalCents = items.reduce((sum, item) => {
    const price = priceByTier.get(item.tierId);
    if (price === undefined) {
      throw badRequest(`Unknown ticket tier ${item.tierId}`);
    }
    return sum + price * item.quantity;
  }, 0);

  return { subtotalCents, currency: event.currency };
}
