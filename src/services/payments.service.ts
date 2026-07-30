import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, payments, webhookEvents, type Payment } from '../db/schema.js';
import type { GatewayName, SettlementResult } from '../gateways/types.js';
import { invalidateEvent } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import {
  cancelOrderExpiry,
  enqueueNotification,
  enqueueTicketIssuance,
} from '../queue/queues.js';
import { commitOrder, releaseOrder } from './inventory.service.js';

// ---------------------------------------------------------------------------
// Settlement
//
// Both the webhook and the reconciliation worker funnel into `applySettlement`,
// so there is exactly one place where money turns into tickets. It is safe to
// call repeatedly with the same result — which is essential, because Safaricom
// retries callbacks and the reconciler races them.
// ---------------------------------------------------------------------------

export interface SettlementOutcomeReport {
  applied: boolean;
  reason?: string;
  orderStatus?: string;
  requiresRefund?: boolean;
}

/**
 * Records the raw callback and tells the caller whether it is new.
 * Returns false when this exact delivery has already been handled.
 */
export async function recordWebhookDelivery(
  gateway: GatewayName,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<{ isNew: boolean; id: string | null }> {
  const inserted = await db
    .insert(webhookEvents)
    .values({ gateway, dedupeKey, payload, status: 'received' })
    .onConflictDoNothing({
      target: [webhookEvents.gateway, webhookEvents.dedupeKey],
    })
    .returning({ id: webhookEvents.id });

  const row = inserted[0];
  return { isNew: Boolean(row), id: row?.id ?? null };
}

async function markWebhook(
  id: string | null,
  status: 'processed' | 'ignored' | 'failed',
  error?: string,
): Promise<void> {
  if (!id) return;
  await db
    .update(webhookEvents)
    .set({
      status,
      error: error ?? null,
      processedAt: new Date(),
      attempts: sql`${webhookEvents.attempts} + 1`,
    })
    .where(eq(webhookEvents.id, id));
}

/**
 * Applies a normalised gateway result to the order it belongs to.
 *
 * Idempotency comes from the payment row's own status: once it is terminal, a
 * repeat delivery is acknowledged and dropped.
 */
export async function applySettlement(
  result: SettlementResult,
  options: { webhookEventId?: string | null } = {},
): Promise<SettlementOutcomeReport> {
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.gatewayRef, result.gatewayRef))
    .limit(1);

  if (!payment) {
    // A callback for an attempt we never recorded. Nothing to do, but worth
    // knowing about — it usually means two environments share a shortcode.
    logger.warn(
      { gatewayRef: result.gatewayRef, resultCode: result.resultCode },
      'settlement received for an unknown payment reference',
    );
    await markWebhook(options.webhookEventId ?? null, 'ignored', 'unknown gateway ref');
    return { applied: false, reason: 'unknown_payment' };
  }

  if (payment.status !== 'pending') {
    await markWebhook(options.webhookEventId ?? null, 'ignored', 'already settled');
    return { applied: false, reason: 'already_settled', orderStatus: payment.status };
  }

  if (result.outcome === 'pending') {
    await db
      .update(payments)
      .set({
        reconcileAttempts: sql`${payments.reconcileAttempts} + 1`,
        lastReconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    return { applied: false, reason: 'still_pending' };
  }

  try {
    if (result.outcome === 'succeeded') {
      return await settleSuccess(payment, result, options.webhookEventId ?? null);
    }
    return await settleFailure(payment, result, options.webhookEventId ?? null);
  } catch (error) {
    await markWebhook(
      options.webhookEventId ?? null,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function settleSuccess(
  payment: Payment,
  result: SettlementResult,
  webhookEventId: string | null,
): Promise<SettlementOutcomeReport> {
  // Guard against a short payment: if Safaricom reports less than we asked for,
  // record it but do not issue tickets.
  if (result.amountCents !== undefined && result.amountCents < payment.amountCents) {
    logger.error(
      {
        paymentId: payment.id,
        expected: payment.amountCents,
        received: result.amountCents,
      },
      'underpayment — refusing to issue tickets',
    );

    await db
      .update(payments)
      .set({
        status: 'failed',
        resultCode: result.resultCode,
        resultDesc: `Underpaid: expected ${payment.amountCents}, received ${result.amountCents}`,
        receipt: result.receipt ?? null,
        rawResult: result.raw,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    await releaseOrder(payment.orderId, 'failed');
    await markWebhook(webhookEventId, 'processed');
    return { applied: true, reason: 'underpayment', orderStatus: 'failed' };
  }

  await db
    .update(payments)
    .set({
      status: 'succeeded',
      resultCode: result.resultCode,
      resultDesc: result.resultDesc,
      receipt: result.receipt ?? null,
      transactionDate: result.transactionDate ?? null,
      rawResult: result.raw,
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));

  const commit = await commitOrder(payment.orderId);

  await cancelOrderExpiry(payment.orderId);

  const [order] = await db
    .select({ eventId: orders.eventId })
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .limit(1);

  if (order) await invalidateEvent(order.eventId);

  if (commit.requiresRefund) {
    // Money taken, seats gone. Do not issue tickets — surface it for a human.
    await enqueueNotification({
      kind: 'order-failed',
      orderId: payment.orderId,
      reason: 'Paid after the hold lapsed and the tier had sold out — refund required',
    });
    await markWebhook(webhookEventId, 'processed');
    return {
      applied: true,
      reason: 'refund_required',
      orderStatus: 'paid',
      requiresRefund: true,
    };
  }

  // Off the request path: generate tickets, then send them.
  await enqueueTicketIssuance(payment.orderId);
  await markWebhook(webhookEventId, 'processed');

  return { applied: true, orderStatus: 'paid' };
}

async function settleFailure(
  payment: Payment,
  result: SettlementResult,
  webhookEventId: string | null,
): Promise<SettlementOutcomeReport> {
  const paymentStatus =
    result.outcome === 'cancelled'
      ? 'cancelled'
      : result.outcome === 'timeout'
        ? 'timeout'
        : 'failed';

  await db
    .update(payments)
    .set({
      status: paymentStatus,
      resultCode: result.resultCode,
      resultDesc: result.resultDesc,
      rawResult: result.raw,
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));

  const orderStatus = result.outcome === 'cancelled' ? 'cancelled' : 'failed';
  await releaseOrder(payment.orderId, orderStatus);
  await cancelOrderExpiry(payment.orderId);

  const [order] = await db
    .select({ eventId: orders.eventId })
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .limit(1);

  if (order) await invalidateEvent(order.eventId);

  await enqueueNotification({
    kind: 'order-failed',
    orderId: payment.orderId,
    reason: result.resultDesc || 'Payment was not completed',
  });

  await markWebhook(webhookEventId, 'processed');

  return { applied: true, orderStatus };
}
