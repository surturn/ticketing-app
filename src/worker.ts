import { closeDatabase } from './db/client.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './queue/queues.js';
import { startWorkers, stopWorkers } from './queue/workers/index.js';

// ---------------------------------------------------------------------------
// Worker entrypoint.
//
// Deploy this as its own Railway service. Scaling the API on CPU during a sale
// should not multiply the number of queue consumers — the work here is bounded
// by Postgres and Daraja, not by inbound HTTP.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await startWorkers();
  logger.info('worker process ready');
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'worker shutting down');

  try {
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await closeDatabase();
    logger.info('worker shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error: unknown) => {
  logger.error({ err: error }, 'worker failed to start');
  process.exit(1);
});
