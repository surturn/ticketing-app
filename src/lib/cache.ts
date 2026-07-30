import { env } from '../config/env.js';
import { logger } from './logger.js';
import { cacheRedis } from './redis.js';

// ---------------------------------------------------------------------------
// Cache-aside helpers.
//
// The cache is strictly an optimisation: every miss, and every Redis outage,
// falls through to Postgres. Nothing here is a source of truth — in particular
// live availability is never *served* from cache without a short TTL, because
// a stale "tickets available" figure sends buyers into a checkout that fails.
// ---------------------------------------------------------------------------

/** Deduplicates concurrent loads inside a single container (stampede guard). */
const inflight = new Map<string, Promise<unknown>>();

export const cacheKeys = {
  eventBySlug: (slug: string) => `event:slug:${slug}`,
  eventTiers: (eventId: string) => `event:${eventId}:tiers`,
  eventAvailability: (eventId: string) => `event:${eventId}:availability`,
  publicEventList: () => 'events:published',
} as const;

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!env.CACHE_ENABLED) return null;
  try {
    const raw = await cacheRedis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    // A cache failure must never fail the request.
    logger.warn({ err: error, key }, 'cache read failed');
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds = env.CACHE_TTL_SECONDS,
): Promise<void> {
  if (!env.CACHE_ENABLED) return;
  try {
    await cacheRedis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    logger.warn({ err: error, key }, 'cache write failed');
  }
}

/**
 * Read-through cache. Concurrent callers for the same key inside this process
 * share one loader call, so a cache miss on a hot event during a flash sale
 * produces a single database query rather than one per in-flight request.
 */
export async function remember<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    const value = await loader();
    await cacheSet(key, value, ttlSeconds);
    return value;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

export async function cacheDelete(...keys: string[]): Promise<void> {
  if (!env.CACHE_ENABLED || keys.length === 0) return;
  try {
    await cacheRedis.del(...keys);
  } catch (error) {
    logger.warn({ err: error, keys }, 'cache delete failed');
  }
}

/**
 * Drops every key under a prefix. Uses SCAN rather than KEYS so it never
 * blocks the Redis event loop while a sale is running.
 */
export async function cacheDeletePrefix(prefix: string): Promise<void> {
  if (!env.CACHE_ENABLED) return;
  const keyPrefix = cacheRedis.options.keyPrefix ?? '';
  const match = `${keyPrefix}${prefix}*`;
  try {
    let cursor = '0';
    do {
      const [next, found] = await cacheRedis.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (found.length > 0) {
        // SCAN returns fully-qualified keys, but ioredis prepends keyPrefix to
        // every command argument — so strip it back off before unlinking, or
        // the delete targets `prefix:prefix:key` and silently no-ops.
        const stripped = found.map((key) =>
          keyPrefix && key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key,
        );
        await cacheRedis.unlink(...stripped);
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.warn({ err: error, prefix }, 'cache prefix delete failed');
  }
}

/** Invalidates everything derived from one event's inventory. */
export async function invalidateEvent(
  eventId: string,
  slug?: string,
): Promise<void> {
  const keys = [
    cacheKeys.eventTiers(eventId),
    cacheKeys.eventAvailability(eventId),
    cacheKeys.publicEventList(),
  ];
  if (slug) keys.push(cacheKeys.eventBySlug(slug));
  await cacheDelete(...keys);
}
