import { env } from './config/env.js';
import { closeDatabase } from './db/client.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './queue/queues.js';
import { startWorkers, stopWorkers } from './queue/workers/index.js';
import { buildServer } from './server.js';

// ---------------------------------------------------------------------------
// API entrypoint. Workers normally run as a separate service (`worker.ts`);
// RUN_WORKERS_IN_API=true collapses them into this process for local dev or a
// single-container deployment.
// ---------------------------------------------------------------------------

const app = await buildServer();

if (env.RUN_WORKERS_IN_API) {
  await startWorkers();
  logger.warn(
    'workers are running inside the API process — use a separate service in production',
  );
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    'ticketing API listening',
  );
} catch (error) {
  logger.error({ err: error }, 'failed to start server');
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');

  try {
    // Stop accepting connections first, then drain everything behind them.
    await app.close();
    if (env.RUN_WORKERS_IN_API) await stopWorkers();
    await closeQueues();
    await closeRedis();
    await closeDatabase();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
