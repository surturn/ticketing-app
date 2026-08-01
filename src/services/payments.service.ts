import { and, eq, sql } from 'drizzle-orm';
import { db, withTransaction } from '../db/client.js';
import { orders, payments, webhookEvents, type Payment } from '../db/schema.js';
import { getGateway } from '../gateways/registry.js';
import type { GatewayName, SettlementResult } from '../gateways/types.js';
import { invalidateEvent } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import {
  cancelOrderExpiry,
  enqueueNotification,
  enqueueTicketIssuance,
} from '../queue/queues.js';
import { commitOrder, releaseOrder } from './inventory.service.js';
import { recordTransition } from './ledger.service.js';

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
 * Where a settlement result came from, and therefore how far it is trusted.
 *
 * `callback` is an unauthenticated HTTP request that claims to be Safaricom. A
 * shared token on the query string is the only thing distinguishing it from
 * anyone else's POST, and the `gatewayRef` needed to aim one at a specific
 * payment is returned to the buyer when they check out — so a success arriving
 * this way is a claim, not a fact.
 *
 * `query` is our own outbound call to Daraja over TLS, authenticated with our
 * credentials. It is the source of truth, and results carrying this provenance
 * are already confirmed by construction.
 */
export type SettlementSource = 'callback' | 'query';

export interface ApplySettlementOptions {
  webhookEventId?: string | null;
  /** Defaults to `callback` — the untrusted case, so a new caller is confirmed
   *  rather than trusted by omission. */
  source?: SettlementSource;
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
  options: ApplySettlementOptions = {},
): Promise<SettlementOutcomeReport> {
  // Claim the payment before touching it.
  //
  // The webhook and the reconciler race here as a matter of routine — that is
  // the whole point of having a reconciler. A plain SELECT of `status` followed
  // by an UPDATE lets both pass the check and both proceed: two settlements for
  // one payment, two ledger entries, and a `commitOrder` called twice.
  //
  // So the claim is a conditional UPDATE that both tests and mutates. Exactly
  // one caller can move a payment out of `pending`; the loser gets zero rows
  // back and returns without doing anything. `settling` is not a stored status
  // — the row keeps `pending` until the outcome is known — the claim is the
  // `claimed_at` stamp, which only a `pending` row can receive.
  const claimed = await db
    .update(payments)
    .set({ claimedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(payments.gatewayRef, result.gatewayRef), eq(payments.status, 'pending')))
    .returning();

  const payment = claimed[0];

  if (!payment) {
    // Either no such payment, or someone else already claimed it. Distinguish
    // the two, because "unknown reference" is worth an alert and "already
    // settled" is entirely normal.
    const [existing] = await db
      .select()
      .from(payments)
      .where(eq(payments.gatewayRef, result.gatewayRef))
      .limit(1);

    if (existing) {
      await markWebhook(options.webhookEventId ?? null, 'ignored', 'already settled');
      return {
        applied: false,
        reason: 'already_settled',
        orderStatus: existing.status,
      };
    }
    // A callback for an attempt we never recorded. Nothing to do, but worth
    // knowing about — it usually means two environments share a shortcode.
    logger.warn(
      { gatewayRef: result.gatewayRef, resultCode: result.resultCode },
      'settlement received for an unknown payment reference',
    );
    await markWebhook(options.webhookEventId ?? null, 'ignored', 'unknown gateway ref');
    return { applied: false, reason: 'unknown_payment' };
  }

  // The claim above already guarantees this payment was `pending`, so there is
  // no status re-check here — it would be dead code that implies a doubt the
  // conditional UPDATE has already settled.

  if (result.outcome === 'pending') {
    // Daraja says the transaction is still in flight. Release the claim, or no
    // later reconciler attempt could ever pick this payment up again.
    await db
      .update(payments)
      .set({
        claimedAt: null,
        reconcileAttempts: sql`${payments.reconcileAttempts} + 1`,
        lastReconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    return { applied: false, reason: 'still_pending' };
  }

  /**
   * A success we were told about is confirmed with Daraja before it counts.
   *
   * This is what makes the callback endpoint's shared token stop being the only
   * thing standing between an attacker and free tickets. Anyone can POST a
   * `ResultCode: 0`; only a transaction that really happened survives being
   * asked about. Safaricom becomes the authority on whether money moved, which
   * is where that authority belonged all along.
   *
   * Only successes, and only from a callback:
   *
   *   * A forged *failure* would release seats and mark an order failed, which
   *     is a nuisance rather than theft, and confirming those too would double
   *     the load on an endpoint Daraja rate-limits.
   *   * A result whose provenance is already `query` came from this exact call.
   *     Re-asking would spend a second request to learn what we just learned.
   */
  if (result.outcome === 'succeeded' && (options.source ?? 'callback') === 'callback') {
    const confirmation = await confirmSuccess(payment, result);

    if (!confirmation.confirmed) {
      // Release the claim, or no later reconciler attempt could pick this
      // payment up — the same reasoning as the `pending` branch above.
      await db
        .update(payments)
        .set({ claimedAt: null, updatedAt: new Date() })
        .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));

      await markWebhook(
        options.webhookEventId ?? null,
        'ignored',
        `unconfirmed: ${confirmation.reason}`,
      );

      return { applied: false, reason: `unconfirmed_${confirmation.reason}` };
    }
  }

  try {
    if (result.outcome === 'succeeded') {
      return await settleSuccess(payment, result, options.webhookEventId ?? null);
    }
    return await settleFailure(payment, result, options.webhookEventId ?? null);
  } catch (error) {
    // Settlement threw partway. Release the claim so the reconciler retries
    // rather than leaving the payment stuck holding a claim nobody will honour.
    await db
      .update(payments)
      .set({ claimedAt: null, updatedAt: new Date() })
      .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')))
      .catch((releaseError: unknown) => {
        logger.error(
          { err: releaseError, paymentId: payment.id },
          'could not release settlement claim',
        );
      });

    await markWebhook(
      options.webhookEventId ?? null,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

/**
 * Asks Daraja whether the transaction a callback described actually succeeded.
 *
 * Fails closed. An inconclusive answer — a network error, a rate limit, Daraja's
 * 5xx "still being processed" — is not a confirmation, so the payment is left
 * `pending` and unclaimed for the reconciler to retry. That costs a genuine
 * buyer a delay measured in the reconcile interval; treating the same
 * uncertainty as a confirmation would cost the difference between a real payment
 * and an invented one.
 *
 * The query API does not return the amount, so this confirms *that* the
 * transaction succeeded, not what it was worth. The underpayment guard in
 * `settleSuccess` still reads its figure from the callback — which is acceptable
 * only because a forged callback can no longer reach that code at all: an
 * attacker who cannot make Daraja agree the transaction happened never gets far
 * enough to have their amount believed.
 */
async function confirmSuccess(
  payment: Payment,
  result: SettlementResult,
): Promise<{ confirmed: true } | { confirmed: false; reason: string }> {
  const gateway = getGateway(payment.gateway as GatewayName);

  let confirmation: SettlementResult;
  try {
    confirmation = await gateway.queryStatus(result.gatewayRef);
  } catch (error) {
    logger.warn(
      { err: error, paymentId: payment.id, gatewayRef: result.gatewayRef },
      'could not confirm a reported settlement; leaving it for the reconciler',
    );
    return { confirmed: false, reason: 'query_failed' };
  }

  if (confirmation.outcome === 'succeeded') return { confirmed: true };

  if (confirmation.outcome === 'pending') {
    // Daraja has not finished deciding. Genuinely ambiguous rather than
    // suspicious: a callback can outrun the query API by a moment.
    return { confirmed: false, reason: 'still_pending' };
  }

  /**
   * Daraja says this transaction did not succeed, and something told us it did.
   *
   * There is no benign explanation involving a real Safaricom callback, so this
   * is logged as loudly as anything in this service: it is either a forgery
   * against the callback endpoint or two environments sharing a shortcode. Both
   * want a human, and the first wants one urgently.
   */
  logger.error(
    {
      paymentId: payment.id,
      orderId: payment.orderId,
      gatewayRef: result.gatewayRef,
      claimedResultCode: result.resultCode,
      actualOutcome: confirmation.outcome,
      actualResultCode: confirmation.resultCode,
    },
    'REPORTED SETTLEMENT CONTRADICTED BY THE GATEWAY — no tickets issued',
  );

  return { confirmed: false, reason: 'contradicted' };
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

    await withTransaction(async (tx) => {
      await tx
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

      await recordTransition(tx, {
        entity: 'payment',
        entityId: payment.id,
        event: 'payment.underpaid',
        fromState: 'pending',
        toState: 'failed',
        actor: 'gateway:mpesa',
        orderId: payment.orderId,
        amountCents: result.amountCents ?? null,
        detail: {
          expectedCents: payment.amountCents,
          receivedCents: result.amountCents,
          receipt: result.receipt ?? null,
          resultCode: result.resultCode,
        },
      });
    });

    await releaseOrder(payment.orderId, 'failed');
    await markWebhook(webhookEventId, 'processed');
    return { applied: true, reason: 'underpayment', orderStatus: 'failed' };
  }

  // The money is real from here on, so the ledger entry commits with it.
  await withTransaction(async (tx) => {
    await tx
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

    await recordTransition(tx, {
      entity: 'payment',
      entityId: payment.id,
      event: 'payment.settled',
      fromState: 'pending',
      toState: 'succeeded',
      actor: 'gateway:mpesa',
      orderId: payment.orderId,
      amountCents: result.amountCents ?? payment.amountCents,
      detail: {
        // The M-Pesa receipt is the number a buyer quotes in a dispute, so it
        // is the single most important field in this whole table.
        receipt: result.receipt ?? null,
        resultCode: result.resultCode,
        resultDesc: result.resultDesc,
        transactionDate: result.transactionDate?.toISOString() ?? null,
        payerPhone: payment.payerPhone,
      },
    });
  });

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

  await withTransaction(async (tx) => {
    await tx
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

    await recordTransition(tx, {
      entity: 'payment',
      entityId: payment.id,
      event: `payment.${paymentStatus}`,
      fromState: 'pending',
      toState: paymentStatus,
      actor: 'gateway:mpesa',
      orderId: payment.orderId,
      amountCents: payment.amountCents,
      detail: {
        resultCode: result.resultCode,
        resultDesc: result.resultDesc,
        outcome: result.outcome,
      },
    });
  });

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
