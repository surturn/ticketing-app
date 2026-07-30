import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createQueueClient } from '../lib/redis.js';

// ---------------------------------------------------------------------------
// Queues
//
// The API does the minimum on the request path — reserve inventory, authorise
// payment, respond. Everything else (issuing tickets, sending receipts,
// expiring lapsed holds, chasing missing callbacks) happens here, so a flash
// sale never waits on an SMTP handshake.
// ---------------------------------------------------------------------------

export const QUEUE = {
  ORDER_EXPIRY: 'order-expiry',
  PAYMENT_RECONCILE: 'payment-reconcile',
  TICKET_ISSUANCE: 'ticket-issuance',
  NOTIFICATION: 'notification',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

// ─── Job payloads ──────────────────────────────────────────────────────────

export interface ExpireOrderJob {
  orderId: string;
}

/** Safety net: sweeps for lapsed holds whose delayed job was lost. */
export interface SweepExpiredOrdersJob {
  limit?: number;
}

export interface ReconcilePaymentJob {
  paymentId: string;
  attempt: number;
}

export interface IssueTicketsJob {
  orderId: string;
}

export type NotificationJob =
  | { kind: 'order-paid'; orderId: string }
  | { kind: 'order-failed'; orderId: string; reason: string }
  | { kind: 'tickets-issued'; orderId: string };

// ─── Connection ────────────────────────────────────────────────────────────

const connection = createQueueClient();

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  // Keep a short window of history for debugging without letting Redis grow
  // without bound during a large sale.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600, count: 5_000 },
};

function makeQueue<T>(name: QueueName): Queue<T> {
  return new Queue<T>(name, {
    connection,
    prefix: `${env.REDIS_PREFIX}:bull`,
    defaultJobOptions,
  });
}

export const orderExpiryQueue = makeQueue<ExpireOrderJob | SweepExpiredOrdersJob>(
  QUEUE.ORDER_EXPIRY,
);
export const paymentReconcileQueue = makeQueue<ReconcilePaymentJob>(
  QUEUE.PAYMENT_RECONCILE,
);
export const ticketIssuanceQueue = makeQueue<IssueTicketsJob>(QUEUE.TICKET_ISSUANCE);
export const notificationQueue = makeQueue<NotificationJob>(QUEUE.NOTIFICATION);

export const allQueues = [
  orderExpiryQueue,
  paymentReconcileQueue,
  ticketIssuanceQueue,
  notificationQueue,
];

// ─── Job names ─────────────────────────────────────────────────────────────

export const JOB = {
  EXPIRE_ORDER: 'expire-order',
  SWEEP_EXPIRED: 'sweep-expired-orders',
  RECONCILE_PAYMENT: 'reconcile-payment',
  ISSUE_TICKETS: 'issue-tickets',
  NOTIFY: 'notify',
} as const;

// ─── Producers ─────────────────────────────────────────────────────────────

/**
 * Schedules the hold on an order to lapse. `jobId` is derived from the order so
 * a duplicate schedule is a no-op rather than a second release.
 */
export async function scheduleOrderExpiry(
  orderId: string,
  expiresAt: Date,
): Promise<void> {
  const delay = Math.max(expiresAt.getTime() - Date.now(), 0);
  await orderExpiryQueue.add(
    JOB.EXPIRE_ORDER,
    { orderId },
    { jobId: `expire:${orderId}`, delay },
  );
}

/** Cancels a scheduled expiry once an order settles. Best-effort — the worker
 *  re-checks order state before releasing anything, so a missed cancel is safe. */
export async function cancelOrderExpiry(orderId: string): Promise<void> {
  try {
    const job = await orderExpiryQueue.getJob(`expire:${orderId}`);
    await job?.remove();
  } catch (error) {
    logger.debug({ err: error, orderId }, 'could not cancel order expiry job');
  }
}

/**
 * Chases a payment whose callback has not arrived. Backs off across attempts —
 * a buyer can sit on the STK prompt for a couple of minutes legitimately.
 */
export async function scheduleReconcile(
  paymentId: string,
  attempt = 1,
): Promise<void> {
  const delaysSeconds = [30, 60, 120, 240, 300];
  const delay =
    (delaysSeconds[Math.min(attempt - 1, delaysSeconds.length - 1)] ?? 300) * 1_000;

  await paymentReconcileQueue.add(
    JOB.RECONCILE_PAYMENT,
    { paymentId, attempt },
    { jobId: `reconcile:${paymentId}:${attempt}`, delay },
  );
}

export async function enqueueTicketIssuance(orderId: string): Promise<void> {
  await ticketIssuanceQueue.add(
    JOB.ISSUE_TICKETS,
    { orderId },
    // Issuance is idempotent, but deduping keeps the queue clean when both the
    // callback and the reconciler settle the same order.
    { jobId: `issue:${orderId}` },
  );
}

export async function enqueueNotification(job: NotificationJob): Promise<void> {
  await notificationQueue.add(JOB.NOTIFY, job, {
    jobId: `notify:${job.kind}:${job.orderId}`,
  });
}

/**
 * Registers the repeatable safety-net sweep. Delayed per-order jobs are the
 * primary mechanism; this catches anything lost to a Redis restart.
 */
export async function registerRepeatableJobs(): Promise<void> {
  await orderExpiryQueue.add(
    JOB.SWEEP_EXPIRED,
    { limit: 500 },
    {
      jobId: 'sweep-expired-orders',
      repeat: { every: 60_000 },
      removeOnComplete: { count: 10 },
    },
  );
  logger.info('repeatable jobs registered');
}

export async function closeQueues(): Promise<void> {
  await Promise.all(allQueues.map((queue) => queue.close()));
  await connection.quit().catch(() => connection.disconnect());
}
