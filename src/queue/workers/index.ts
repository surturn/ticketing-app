import type { Worker } from 'bullmq';
import { logger } from '../../lib/logger.js';
import { registerRepeatableJobs } from '../queues.js';
import { createMaintenanceWorker } from './maintenance.worker.js';
import { createNotificationWorker } from './notification.worker.js';
import { createOrderExpiryWorker } from './order-expiry.worker.js';
import { createPaymentReconcileWorker } from './payment-reconcile.worker.js';
import { createTicketIssuanceWorker } from './ticket-issuance.worker.js';

let workers: Worker[] = [];

export async function startWorkers(): Promise<Worker[]> {
  if (workers.length > 0) return workers;

  workers = [
    createOrderExpiryWorker(),
    createPaymentReconcileWorker(),
    createTicketIssuanceWorker(),
    createNotificationWorker(),
    createMaintenanceWorker(),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      logger.error(
        { queue: worker.name, jobId: job?.id, attempt: job?.attemptsMade, err },
        'job failed',
      );
    });
    worker.on('error', (err) => {
      logger.error({ queue: worker.name, err }, 'worker error');
    });
  }

  await registerRepeatableJobs();

  logger.info(
    { queues: workers.map((worker) => worker.name) },
    'workers started',
  );

  return workers;
}

export async function stopWorkers(): Promise<void> {
  // `close()` waits for in-flight jobs to finish, so a deploy never kills a
  // half-issued order.
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
}
