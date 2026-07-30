import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema.js';

// ---------------------------------------------------------------------------
// Connection
//
// Behind PgBouncer/Supavisor in *transaction* pooling mode, prepared statements
// must be disabled — a pooled backend is handed to a different client between
// transactions, so `s1` from one session collides with `s1` from another. The
// failure is intermittent and only appears under load, which is exactly when
// you least want to be debugging it.
// ---------------------------------------------------------------------------

const usingTransactionPooler = env.DATABASE_POOLER_MODE === 'transaction';

const client = postgres(env.DATABASE_URL, {
  max: env.DATABASE_MAX_CONNECTIONS,
  ssl: env.DATABASE_SSL ? 'require' : false,
  prepare: !usingTransactionPooler,
  // Recycle idle connections so an autoscaled-down replica does not pin
  // pooler slots it is no longer using.
  idle_timeout: 30,
  max_lifetime: 60 * 30,
  connect_timeout: 10,

  // Startup parameters are only reliable on a direct connection or a session
  // pooler. Under transaction pooling we apply timeouts per-transaction with
  // SET LOCAL instead (see `withTransaction`).
  connection: usingTransactionPooler
    ? {}
    : {
        statement_timeout: String(env.DATABASE_STATEMENT_TIMEOUT_MS),
        lock_timeout: String(env.DATABASE_LOCK_TIMEOUT_MS),
      },

  onnotice: (notice) => logger.debug({ notice }, 'postgres notice'),
});

export const db = drizzle(client, {
  schema,
  casing: 'snake_case',
  logger: env.LOG_LEVEL === 'trace',
});

export type Database = PostgresJsDatabase<typeof schema>;
/** The transaction-scoped handle Drizzle hands to `db.transaction` callbacks. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// ---------------------------------------------------------------------------
// Transaction helper
//
// Applies SET LOCAL timeouts so a contended row lock fails fast instead of
// holding a pooled connection while thousands of buyers queue behind it. These
// are transaction-scoped, so they work identically on a direct connection and
// behind a transaction pooler.
// ---------------------------------------------------------------------------

export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { lockTimeoutMs?: number; statementTimeoutMs?: number } = {},
): Promise<T> {
  const lockTimeout = options.lockTimeoutMs ?? env.DATABASE_LOCK_TIMEOUT_MS;
  const statementTimeout =
    options.statementTimeoutMs ?? env.DATABASE_STATEMENT_TIMEOUT_MS;

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${lockTimeout}`));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${statementTimeout}`));
    return fn(tx);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function checkDatabase(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'database health check failed');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await client.end({ timeout: 5 });
}

export { client as sqlClient };
