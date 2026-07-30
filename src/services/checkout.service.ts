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
import {
  cancelOrderExpiry,
  scheduleOrderExpiry,
  scheduleReconcile,
} from '../queue/queues.js';
import { env } from '../config/env.js';
import { getEventRowBySlug } from './events.service.js';
import {
  explainReservationFailure,
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

export interface CheckoutInput {
  eventSlug: string;
  items: CheckoutItemInput[];
  buyer: { name: string; email?: string; phone: string };
  idempotencyKey?: string;
  gateway?: GatewayName;
  metadata?: Record<string, unknown>;
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
          buyerName: input.buyer.name.trim(),
          buyerEmail: input.buyer.email?.trim() || null,
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

  // Seats are held — the sale page should stop advertising them.
  await invalidateEvent(event.id, event.slug);
  await scheduleOrderExpiry(order.id, reservedUntil);

  // ─── Authorise the payment (outside the transaction) ────────────────────
  try {
    const charge = await gateway.charge({
      orderId: order.id,
      reference: order.reference,
      amountCents: order.totalCents,
      currency: order.currency,
      phone,
      description: `Tickets ${order.reference}`,
    });

    const [payment] = await db
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

    await db
      .update(orders)
      .set({ status: 'awaiting_payment', updatedAt: new Date() })
      .where(eq(orders.id, order.id));

    // Chase this payment if Safaricom's callback never arrives.
    await scheduleReconcile(payment!.id, 1);

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
    // The gateway refused or timed out. Give the seats back immediately rather
    // than making the buyer wait out the full hold.
    logger.error(
      { err: error, orderId: order.id, reference: order.reference },
      'payment initiation failed — releasing held inventory',
    );

    await releaseOrder(order.id, 'failed').catch((releaseError: unknown) => {
      // The expiry worker is the backstop if this fails.
      logger.error(
        { err: releaseError, orderId: order.id },
        'failed to release inventory after a failed charge',
      );
    });
    await cancelOrderExpiry(order.id);
    await invalidateEvent(event.id, event.slug);

    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      'payment_initiation_failed',
      'We could not reach M-Pesa. Please try again.',
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
