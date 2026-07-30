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

/**
 * The one path the M-Pesa callback is served on.
 *
 * Exported and used by both the route registration and the MPESA_CALLBACK_URL
 * check below, so the configured URL and the route that answers it cannot drift
 * apart without the build failing.
 */
export const MPESA_WEBHOOK_PATH = '/api/webhooks/mpesa';

const schema = z.object({
  // ─── Server ──────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  // `silent` is a real pino level, and the test setup relies on it.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
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

  // Days after an event finishes before it is archived out of the current
  // listing and into past events. Archiving never deletes anything.
  EVENT_ARCHIVE_AFTER_DAYS: z.coerce.number().int().positive().default(2),
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

  // Must be the public URL of *this service's* webhook route. Pointing it at
  // some other path is a silent failure of the worst kind: Safaricom takes the
  // money, posts the callback to a 404, and the order sits in awaiting_payment
  // until the hold lapses. Only the reconciler saves it, and only if the payment
  // was recorded at all. So the path is checked at boot rather than trusted.
  MPESA_CALLBACK_URL: z
    .string()
    .url('must be an absolute URL')
    .optional()
    .refine(
      (value) => value === undefined || new URL(value).pathname === MPESA_WEBHOOK_PATH,
      `must end in ${MPESA_WEBHOOK_PATH} — that is the only path this service serves the M-Pesa callback on`,
    )
    .refine((value) => {
      if (value === undefined) return true;
      const url = new URL(value);
      // Safaricom will not post to plain HTTP, and will not reach localhost.
      return url.protocol === 'https:';
    }, 'must be https — Safaricom will not post to a plain HTTP callback'),
  MPESA_CALLBACK_TOKEN: z.string().optional(),

  // ─── Firebase (buyer accounts) ───────────────────────────────────
  //
  // Optional. Without these the service runs exactly as before — guest checkout
  // is unaffected — and any request presenting a bearer token is rejected rather
  // than trusted. Accounts are an enhancement, never a prerequisite for a sale.
  //
  // These three come from a service-account JSON key. That key is effectively
  // full project admin: keep it in the platform's env store, never in the repo,
  // and treat rotating it as a break-glass procedure.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),

  /**
   * The PEM private key, as a single line with `\n` escapes.
   *
   * It has to be one line: a `.env` value ends at the first real newline, so a PEM
   * pasted with its line breaks intact silently becomes just
   * `-----BEGIN PRIVATE KEY-----`. That surfaces much later as
   * `DECODER routines::unsupported` from inside OpenSSL, which names neither the
   * variable nor the cause — so the second check below catches it here instead.
   */
  FIREBASE_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .trim()
            .replace(/^["']|["']$/g, '')
            .replace(/\\n/g, '\n'),
    )
    .refine(
      (value) => value === undefined || value.includes('BEGIN PRIVATE KEY'),
      'must be the full PEM private key, including the BEGIN PRIVATE KEY line',
    )
    .refine(
      (value) => value === undefined || value.trim().split('\n').length > 2,
      'looks truncated — a PEM pasted with real newlines stops at the header line. Put the whole key on one line, with \\n between the segments',
    ),

  // ─── Brevo (transactional email) ─────────────────────────────────
  // Optional: without a key the notification worker logs what it would
  // have sent instead of failing, so a missing key never blocks a sale.
  BREVO_API_KEY: z.string().optional(),
  // A bare address, not `Name <addr@example.com>`. Brevo's API takes the display
  // name as a separate field, which is what BREVO_SENDER_NAME is for — and the
  // combined form is the mistake people actually make, so it is called out here
  // rather than left to a generic "invalid email".
  BREVO_SENDER_EMAIL: z
    .string()
    .email(
      'must be a bare address like rsvp@example.com — put the display name in BREVO_SENDER_NAME, not in angle brackets here',
    )
    .optional(),
  BREVO_SENDER_NAME: z.string().default('Tickets'),
  // Where buyers are pointed to view their tickets, e.g. https://event.example.com
  // Used to build the order link in receipt emails.
  PUBLIC_ORDER_BASE_URL: z.string().optional(),
});

// A commented-out variable and one left blank are the same intent, but Zod sees
// `''` as a present value and runs `.email()` / `.default()` against it. Both
// .env files and the Railway dashboard produce empty strings freely, so drop
// them and let `.optional()` and `.default()` mean what they say.
const present = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ''),
);

const parsed = schema.safeParse(present);

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

/** True when buyer accounts are available. */
export const firebaseConfigured = Boolean(
  env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
);

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
