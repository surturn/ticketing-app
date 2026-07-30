import { z } from 'zod';

// Node 20.12+ can read a .env file without a dependency. In production the
// platform (Railway) injects real environment variables, so a missing file is
// not an error.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env on disk — rely on the ambient environment
}

const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

const schema = z.object({
  // ─── Server ──────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  CORS_ORIGINS: csv,

  // ─── Postgres ────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool('false'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),

  // `transaction` disables prepared statements, which PgBouncer/Supavisor in
  // transaction pooling mode cannot support. Getting this wrong surfaces as
  // intermittent `prepared statement "sN" already exists` errors under load.
  DATABASE_POOLER_MODE: z
    .enum(['none', 'session', 'transaction'])
    .default('none'),

  // Fail a contended row lock fast rather than holding a pooled connection
  // hostage and starving the pool during a flash sale.
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(3000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(10_000),

  // ─── Redis ───────────────────────────────────────────────────────
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z.string().default('ticketing'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  CACHE_ENABLED: bool('true'),

  // ─── Secrets ─────────────────────────────────────────────────────
  TICKET_SIGNING_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SCANNER_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ADMIN_API_KEY: z.string().min(16, 'must be at least 16 characters'),

  // ─── Checkout ────────────────────────────────────────────────────
  ORDER_HOLD_MINUTES: z.coerce.number().int().positive().default(10),
  RUN_WORKERS_IN_API: bool('false'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),

  // ─── M-Pesa Daraja ───────────────────────────────────────────────
  // Optional so the service boots for frontend work without live credentials.
  // The gateway raises a clear error if a payment is attempted without them.
  MPESA_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_SHORTCODE: z.string().default('174379'),

  // Paybill numbers use CustomerPayBillOnline; Till numbers (Buy Goods) use
  // CustomerBuyGoodsOnline. Sending the wrong one fails every push, so it is
  // configuration rather than a hardcoded constant.
  MPESA_TRANSACTION_TYPE: z
    .enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'])
    .default('CustomerPayBillOnline'),

  // For Buy Goods the passkey is issued against the head-office/store number
  // (BusinessShortCode) while funds credit the Till (PartyB), and the two are
  // often different. Defaults to MPESA_SHORTCODE when they are the same.
  MPESA_PARTY_B: z.string().optional(),

  MPESA_CALLBACK_URL: z.string().optional(),
  MPESA_CALLBACK_TOKEN: z.string().optional(),

  // ─── Brevo (transactional email) ─────────────────────────────────
  // Optional: without a key the notification worker logs what it would
  // have sent instead of failing, so a missing key never blocks a sale.
  BREVO_API_KEY: z.string().optional(),
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  BREVO_SENDER_NAME: z.string().default('Tickets'),
  // Where buyers are pointed to view their tickets, e.g. https://event.example.com
  // Used to build the order link in receipt emails.
  PUBLIC_ORDER_BASE_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Fail at boot rather than at the first request that needs the value.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** True when Brevo can actually send. */
export const brevoConfigured = Boolean(env.BREVO_API_KEY && env.BREVO_SENDER_EMAIL);

/** The shortcode funds actually credit — the Till for Buy Goods. */
export const mpesaPartyB = env.MPESA_PARTY_B || env.MPESA_SHORTCODE;

/** True when live M-Pesa credentials are present. */
export const mpesaConfigured = Boolean(
  env.MPESA_CONSUMER_KEY &&
    env.MPESA_CONSUMER_SECRET &&
    env.MPESA_PASSKEY &&
    env.MPESA_CALLBACK_URL,
);
