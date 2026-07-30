import { Worker, type Job } from 'bullmq';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { orders } from '../../db/schema.js';
import { invalidateEvent } from '../../lib/cache.js';
import { logger } from '../../lib/logger.js';
import { createQueueClient } from '../../lib/redis.js';
import { releaseOrder } from '../../services/inventory.service.js';
import { JOB, QUEUE, type ExpireOrderJob, type SweepExpiredOrdersJob } from '../queues.js';

// ---------------------------------------------------------------------------
// Returns lapsed holds to the pool.
//
// Two paths, on purpose:
//   * a delayed per-order job fires exactly when the hold lapses (precise, and
//     the seat is back on sale the second it is free);
//   * a repeatable sweep catches anything the first path lost — a Redis
//     restart, a job evicted, a worker killed mid-flight.
//
// releaseOrder is idempotent, so the two overlapping is harmless.
// ---------------------------------------------------------------------------

async function expireOne(orderId: string): Promise<void> {
  const [order] = await db
    .select({ id: orders.id, eventId: orders.eventId, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return;

  const result = await releaseOrder(orderId, 'expired');

  if (result.released) {
    await invalidateEvent(order.eventId);
    logger.info({ orderId }, 'hold expired, inventory released');
  }
}

async function sweep(limit: number): Promise<number> {
  const stale = await db
    .select({ id: orders.id, eventId: orders.eventId })
    .from(orders)
    .where(
      and(
        or(eq(orders.status, 'pending'), eq(orders.status, 'awaiting_payment')),
        lt(orders.reservedUntil, new Date()),
        isNull(orders.releasedAt),
      ),
    )
    .limit(limit);

  for (const order of stale) {
    try {
      const result = await releaseOrder(order.id, 'expired');
      if (result.released) await invalidateEvent(order.eventId);
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, 'sweep failed to release order');
    }
  }

  if (stale.length > 0) {
    logger.info({ count: stale.length }, 'swept lapsed holds');
  }

  return stale.length;
}

export function createOrderExpiryWorker(): Worker {
  return new Worker(
    QUEUE.ORDER_EXPIRY,
    async (job: Job<ExpireOrderJob | SweepExpiredOrdersJob>) => {
      if (job.name === JOB.SWEEP_EXPIRED) {
        const { limit } = job.data as SweepExpiredOrdersJob;
        return sweep(limit ?? 500);
      }

      const { orderId } = job.data as ExpireOrderJob;
      await expireOne(orderId);
      return null;
    },
    {
      connection: createQueueClient(),
      prefix: `${env.REDIS_PREFIX}:bull`,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );
}
