import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Two kinds of Redis client:
//
// * cache clients use ioredis defaults (retry on failure, fail the command).
// * BullMQ clients MUST set `maxRetriesPerRequest: null` and disable ready
//   checks — BullMQ blocks on BRPOPLPUSH for long stretches and ioredis would
//   otherwise abort those commands and stall the queue.
// ---------------------------------------------------------------------------

const baseOptions: RedisOptions = {
  lazyConnect: false,
  enableAutoPipelining: true,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
};

export function createCacheClient(): Redis {
  const client = new Redis(env.REDIS_URL, {
    ...baseOptions,
    keyPrefix: `${env.REDIS_PREFIX}:cache:`,
  });
  client.on('error', (err) => logger.error({ err }, 'redis cache client error'));
  return client;
}

export function createQueueClient(): Redis {
  const client = new Redis(env.REDIS_URL, {
    ...baseOptions,
    // Required by BullMQ — see note above.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // BullMQ manages its own key naming via the queue prefix, so no keyPrefix.
  });
  client.on('error', (err) => logger.error({ err }, 'redis queue client error'));
  return client;
}

export const cacheRedis = createCacheClient();

export async function checkRedis(): Promise<boolean> {
  try {
    const pong = await cacheRedis.ping();
    return pong === 'PONG';
  } catch (error) {
    logger.error({ err: error }, 'redis health check failed');
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await cacheRedis.quit().catch(() => cacheRedis.disconnect());
}
