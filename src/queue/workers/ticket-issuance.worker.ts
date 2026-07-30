import { Worker, type Job } from 'bullmq';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { createQueueClient } from '../../lib/redis.js';
import { issueTicketsForOrder } from '../../services/tickets.service.js';
import { QUEUE, enqueueNotification, type IssueTicketsJob } from '../queues.js';

// ---------------------------------------------------------------------------
// Generates the actual admissions once money has settled. Kept off the request
// path entirely — a 40-ticket corporate order should not make the buyer's
// checkout request wait on 40 inserts and a QR signing pass.
// ---------------------------------------------------------------------------

export function createTicketIssuanceWorker(): Worker<IssueTicketsJob> {
  return new Worker<IssueTicketsJob>(
    QUEUE.TICKET_ISSUANCE,
    async (job: Job<IssueTicketsJob>) => {
      const { orderId } = job.data;

      try {
        const issued = await issueTicketsForOrder(orderId);
        await enqueueNotification({ kind: 'tickets-issued', orderId });
        return { count: issued.length };
      } catch (error) {
        // An order flagged for refund, or not yet paid, is a permanent state —
        // retrying it five times just fills the log with noise.
        if (
          error instanceof AppError &&
          (error.code === 'refund_required' || error.code === 'order_not_paid')
        ) {
          logger.warn(
            { orderId, code: error.code },
            'skipping ticket issuance for this order',
          );
          return { count: 0, skipped: error.code };
        }
        throw error;
      }
    },
    {
      connection: createQueueClient(),
      prefix: `${env.REDIS_PREFIX}:bull`,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );
}
