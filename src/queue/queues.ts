import { createHash } from 'node:crypto';
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
  MAINTENANCE: 'maintenance',
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
  | { kind: 'tickets-issued'; orderId: string }
  // One job per recipient rather than one per event. A single job mailing the
  // whole list would resend to everyone on a retry after a partial failure;
  // per-recipient jobs dedupe individually and retry in isolation.
  | {
      kind: 'event-announced';
      eventId: string;
      email: string;
      unsubscribeToken: string | null;
    };

/** Fans an event announcement out into one notification job per recipient. */
export interface AnnounceEventJob {
  eventId: string;
}

/** Retires events that finished more than the retention window ago. */
export interface PurgeAbandonedOrdersJob {
  /** Overrides ORDER_PURGE_AFTER_DAYS for a one-off run. */
  afterDays?: number;
}

export interface ArchivePastEventsJob {
  afterDays?: number;
}

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

/**
 * Delivery gets a much longer runway than everything else.
 *
 * The default policy exhausts in about thirty seconds. That is the right shape
 * for a transient blip, and the wrong shape for the interruptions mail delivery
 * actually sees, which are resolved by an operator rather than by time alone.
 *
 * Eight attempts backing off from thirty seconds spans roughly an hour, so a
 * routine interruption resolves itself with nothing to replay by hand.
 */
const deliveryJobOptions: JobsOptions = {
  ...defaultJobOptions,
  attempts: 8,
  backoff: { type: 'exponential', delay: 30_000 },
};

function makeQueue<T>(name: QueueName, jobOptions = defaultJobOptions): Queue<T> {
  return new Queue<T>(name, {
    connection,
    prefix: `${env.REDIS_PREFIX}:bull`,
    defaultJobOptions: jobOptions,
  });
}

export const orderExpiryQueue = makeQueue<ExpireOrderJob | SweepExpiredOrdersJob>(
  QUEUE.ORDER_EXPIRY,
);
export const paymentReconcileQueue = makeQueue<ReconcilePaymentJob>(
  QUEUE.PAYMENT_RECONCILE,
);
export const ticketIssuanceQueue = makeQueue<IssueTicketsJob>(QUEUE.TICKET_ISSUANCE);
export const notificationQueue = makeQueue<NotificationJob>(
  QUEUE.NOTIFICATION,
  deliveryJobOptions,
);
export const maintenanceQueue = makeQueue<
  ArchivePastEventsJob | AnnounceEventJob | PurgeAbandonedOrdersJob
>(
  QUEUE.MAINTENANCE,
);

export const allQueues = [
  orderExpiryQueue,
  paymentReconcileQueue,
  ticketIssuanceQueue,
  notificationQueue,
  maintenanceQueue,
];

// ─── Job ids ───────────────────────────────────────────────────────────────
//
// BullMQ rejects a colon in a custom job id — it uses `:` as its own Redis key
// separator, and `queue.add` throws `Custom Ids cannot contain :`. Every id here
// is built through this helper so that constraint is enforced in one place
// rather than remembered at five call sites.
//
// This is not cosmetic: a throw from `add()` on the checkout path happens after
// the inventory transaction has committed, so getting it wrong strands seats.

function jobId(...parts: Array<string | number>): string {
  return parts.join('-');
}

// ─── Job names ─────────────────────────────────────────────────────────────

export const JOB = {
  EXPIRE_ORDER: 'expire-order',
  SWEEP_EXPIRED: 'sweep-expired-orders',
  RECONCILE_PAYMENT: 'reconcile-payment',
  ISSUE_TICKETS: 'issue-tickets',
  NOTIFY: 'notify',
  ARCHIVE_PAST_EVENTS: 'archive-past-events',
  PURGE_ABANDONED_ORDERS: 'purge-abandoned-orders',
  ANNOUNCE_EVENT: 'announce-event',
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
    { jobId: jobId('expire', orderId), delay },
  );
}

/** Cancels a scheduled expiry once an order settles. Best-effort — the worker
 *  re-checks order state before releasing anything, so a missed cancel is safe. */
export async function cancelOrderExpiry(orderId: string): Promise<void> {
  try {
    const job = await orderExpiryQueue.getJob(jobId('expire', orderId));
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
    { jobId: jobId('reconcile', paymentId, attempt), delay },
  );
}

export async function enqueueTicketIssuance(orderId: string): Promise<void> {
  await ticketIssuanceQueue.add(
    JOB.ISSUE_TICKETS,
    { orderId },
    // Issuance is idempotent, but deduping keeps the queue clean when both the
    // callback and the reconciler settle the same order.
    { jobId: jobId('issue', orderId) },
  );
}

export async function enqueueNotification(job: NotificationJob): Promise<void> {
  // Announcements are keyed on event plus recipient; order notifications on the
  // order. Both dedupe, but on different identities.
  const id =
    job.kind === 'event-announced'
      ? jobId('notify', job.kind, job.eventId, hashForJobId(job.email))
      : jobId('notify', job.kind, job.orderId);

  await notificationQueue.add(JOB.NOTIFY, job, { jobId: id });
}

/**
 * Short stable digest of an email, for use inside a job id.
 *
 * The address itself cannot go in: BullMQ job ids reject `:`, and an email is
 * also not something to leave sitting in Redis keys in clear text.
 */
function hashForJobId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Queues the fan-out for a newly published event. */
export async function enqueueEventAnnouncement(eventId: string): Promise<void> {
  await maintenanceQueue.add(
    JOB.ANNOUNCE_EVENT,
    { eventId },
    { jobId: jobId('announce', eventId) },
  );
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

  // Hourly rather than by the minute: the retention window is measured in days,
  // so an event archiving up to an hour late is invisible, and the sweep is a
  // table scan that has no reason to run 1,440 times a day.
  await maintenanceQueue.add(
    JOB.ARCHIVE_PAST_EVENTS,
    {},
    {
      jobId: 'archive-past-events',
      repeat: { every: 3_600_000 },
      removeOnComplete: { count: 24 },
    },
  );

  // Daily. The retention window is thirty days, so the exact hour a purge runs
  // is immaterial, and this is the only job in the system that deletes anything
  // — there is no argument for running it more often than the smallest unit it
  // measures.
  await maintenanceQueue.add(
    JOB.PURGE_ABANDONED_ORDERS,
    {},
    {
      jobId: 'purge-abandoned-orders',
      repeat: { every: 86_400_000 },
      removeOnComplete: { count: 7 },
    },
  );

  logger.info('repeatable jobs registered');
}

export async function closeQueues(): Promise<void> {
  await Promise.all(allQueues.map((queue) => queue.close()));
  await connection.quit().catch(() => connection.disconnect());
}
