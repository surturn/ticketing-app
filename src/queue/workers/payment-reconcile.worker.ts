import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { payments } from '../../db/schema.js';
import { getGateway } from '../../gateways/registry.js';
import type { GatewayName } from '../../gateways/types.js';
import { logger } from '../../lib/logger.js';
import { createQueueClient } from '../../lib/redis.js';
import { applySettlement } from '../../services/payments.service.js';
import { QUEUE, scheduleReconcile, type ReconcilePaymentJob } from '../queues.js';

// ---------------------------------------------------------------------------
// Chases payments whose callback never arrived.
//
// Safaricom callbacks are not guaranteed — they get lost, they get delivered to
// a URL that was briefly down during a deploy, they arrive twenty minutes late.
// Without this worker those orders sit in `awaiting_payment` until the hold
// lapses, and a buyer who genuinely paid never gets a ticket.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;

async function reconcile(paymentId: string, attempt: number): Promise<string> {
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) return 'payment_not_found';

  // The callback beat us to it.
  if (payment.status !== 'pending') return `already_${payment.status}`;

  const gateway = getGateway(payment.gateway as GatewayName);

  let result;
  try {
    result = await gateway.queryStatus(payment.gatewayRef);
  } catch (error) {
    // Daraja answers "transaction is being processed" with a 5xx while the
    // buyer is still looking at the prompt. That is a pending, not a failure.
    logger.debug(
      { err: error, paymentId, attempt },
      'status query inconclusive, will retry',
    );

    if (attempt < MAX_ATTEMPTS) {
      await scheduleReconcile(paymentId, attempt + 1);
      return 'retry_scheduled';
    }

    // Out of attempts. Leave the payment pending — the expiry worker will
    // release the seats, and a late callback can still settle it.
    logger.warn({ paymentId }, 'giving up reconciling payment; hold will lapse');
    return 'exhausted';
  }

  if (result.outcome === 'pending') {
    if (attempt < MAX_ATTEMPTS) {
      await scheduleReconcile(paymentId, attempt + 1);
      return 'retry_scheduled';
    }
    return 'exhausted';
  }

  // `query` provenance: this result came from our own authenticated call to
  // Daraja a few lines up, so it is already confirmed. Without the flag the
  // settlement path would ask the same question a second time.
  const report = await applySettlement(result, { source: 'query' });
  logger.info(
    { paymentId, attempt, outcome: result.outcome, applied: report.applied },
    'payment reconciled via status query',
  );

  return report.applied ? `settled_${result.outcome}` : (report.reason ?? 'noop');
}

export function createPaymentReconcileWorker(): Worker<ReconcilePaymentJob> {
  return new Worker<ReconcilePaymentJob>(
    QUEUE.PAYMENT_RECONCILE,
    async (job: Job<ReconcilePaymentJob>) =>
      reconcile(job.data.paymentId, job.data.attempt ?? 1),
    {
      connection: createQueueClient(),
      prefix: `${env.REDIS_PREFIX}:bull`,
      concurrency: env.WORKER_CONCURRENCY,
      // Daraja rate-limits; do not let a backlog stampede the query endpoint.
      limiter: { max: 10, duration: 1_000 },
    },
  );
}
