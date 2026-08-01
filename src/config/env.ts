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

/**
 * The out-of-band result paths.
 *
 * B2C and Reversal are asynchronous in a way STK Push is not: the POST returns
 * only an acknowledgement, and the actual outcome arrives minutes later on
 * `ResultURL` — or, if Daraja could not process the request in time, on
 * `QueueTimeOutURL`. Both must be publicly reachable before either product is
 * used, because a payout whose result never lands is money that left the
 * account with nothing recording where it went.
 *
 * Separate paths per product rather than one shared endpoint: the payloads are
 * different shapes, and a single handler branching on `ResultParameters` would
 * be guessing which product it was looking at.
 */
export const MPESA_B2C_RESULT_PATH = '/api/webhooks/mpesa/b2c/result';
export const MPESA_B2C_TIMEOUT_PATH = '/api/webhooks/mpesa/b2c/timeout';
export const MPESA_REVERSAL_RESULT_PATH = '/api/webhooks/mpesa/reversal/result';
export const MPESA_REVERSAL_TIMEOUT_PATH = '/api/webhooks/mpesa/reversal/timeout';

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

  /**
   * Signed-in accounts that also hold administrative access, by email.
   *
   * A convenience for the people who run the product, so they can manage events
   * from the account they are already signed into rather than pasting a shared
   * key. Comma-separated, and compared lowercased.
   *
   * Two properties make this safe enough to exist. The address must be
   * *verified* by the identity provider — an unverified one proves nothing,
   * since anyone can type someone else's address into a sign-up form. And this
   * grants nothing on its own: it is checked only after a Firebase token has
   * been cryptographically verified for this project.
   *
   * Empty by default. A deployment that does not set it behaves exactly as
   * before, with the API key as the only way in.
   */
  ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),

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

  // ─── M-Pesa B2C and Reversal ─────────────────────────────────────
  //
  // Both are "initiator" products: they move money *out* of the shortcode
  // rather than into it, and Safaricom gates them behind a separate API user
  // whose password is never sent in the clear. All optional, so a service that
  // only takes payments boots without them.

  /** The API operator username created in the Daraja portal, not the shortcode. */
  MPESA_INITIATOR_NAME: z.string().optional(),

  /**
   * The initiator's plaintext password.
   *
   * Never transmitted. It is RSA-encrypted against Safaricom's public
   * certificate to produce the `SecurityCredential` field on every request —
   * see `security-credential.ts`. Held in the platform's secret store like any
   * other credential that can move money.
   */
  MPESA_INITIATOR_PASSWORD: z.string().optional(),

  /**
   * Path to Safaricom's public certificate used to encrypt the above.
   *
   * The sandbox and production certificates are different files, and using the
   * wrong one produces a credential the far end rejects with an error that does
   * not mention certificates at all. Defaults to a per-environment path under
   * `certs/`, which is gitignored — the certificate is downloaded from the
   * Daraja portal rather than committed.
   */
  MPESA_INITIATOR_CERT_PATH: z.string().optional(),

  /**
   * Command issued for a B2C payout.
   *
   * `BusinessPayment` is the correct one for paying an organiser their takings:
   * it is a business-to-customer transfer with no salary or promotional
   * semantics attached. The others exist because Safaricom prices and reports
   * them differently, so this is configuration rather than a constant.
   */
  MPESA_B2C_COMMAND: z
    .enum(['BusinessPayment', 'SalaryPayment', 'PromotionPayment'])
    .default('BusinessPayment'),

  // ─── Cloudflare R2 (poster uploads) ──────────────────────────────
  //
  // All optional. Without them the event form still accepts a poster URL typed
  // in by hand, exactly as before — only uploading from a device is disabled,
  // and the endpoint says so rather than failing obscurely.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  /**
   * Where the stored objects are publicly readable from.
   *
   * A separate value because it is not derivable: it is either the bucket's
   * r2.dev subdomain or a custom domain, and which one is a deployment choice.
   * Required to be https for the same reason a typed-in poster URL is — a
   * browser blocks insecure images on a secure page, and the poster would
   * simply not appear.
   */
  R2_PUBLIC_BASE_URL: z
    .string()
    .url('must be an absolute URL')
    .refine(
      (value) => value.startsWith('https://'),
      'must be https — browsers block insecure images on a secure page',
    )
    .optional(),

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

  /**
   * The Firebase auth domain to forward `/__/auth/*` to, e.g.
   * `ticketa-9d7e7.firebaseapp.com`.
   *
   * Set this and the OAuth handler is served from our own origin instead, so a
   * buyer signing in sees our domain on Google's consent screen rather than a
   * Firebase project id they have never heard of. Leave it unset and Firebase
   * behaves exactly as it does by default.
   *
   * Deliberately not derived from `FIREBASE_PROJECT_ID`: turning the proxy on
   * also requires setting `VITE_FIREBASE_AUTH_DOMAIN` to our host and adding
   * that host to Firebase's authorised domains. Inferring it would switch on
   * half an arrangement whose other half lives in a console.
   */
  FIREBASE_AUTH_UPSTREAM: z
    .string()
    .regex(
      /^[a-z0-9-]+\.(firebaseapp\.com|web\.app)$/,
      'must be a Firebase auth domain, e.g. my-project.firebaseapp.com',
    )
    .optional(),
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
  /**
   * Where a buyer's order link points, in emails and on tickets.
   *
   * Validated, because an unvalidated one fails in the worst possible place: a
   * plain `z.string()` accepted `http://localhost:3000` in production, and the
   * only symptom would have been every confirmation email carrying a link to a
   * machine the buyer does not have. Nothing throws, nothing is logged, and it
   * surfaces as people saying their tickets never arrived.
   *
   * https is required except against a loopback host, which is what development
   * legitimately uses. That test is on the host rather than on NODE_ENV so it
   * cannot be defeated by a deployment that forgot to set the environment.
   */
  PUBLIC_ORDER_BASE_URL: z
    .string()
    .url('must be an absolute URL, e.g. https://tickets.example.com')
    .refine((value) => {
      const { protocol, hostname } = new URL(value);
      const loopback =
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
      return protocol === 'https:' || loopback;
    }, 'must be https — a ticket link is opened from an email, and http is rewritten or blocked by mail clients and link scanners')
    .optional(),
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

/** True when posters can be uploaded rather than only linked. */
export const r2Configured = Boolean(
  env.R2_ACCOUNT_ID &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_BUCKET &&
    env.R2_PUBLIC_BASE_URL,
);

/** True when live M-Pesa credentials are present. */
export const mpesaConfigured = Boolean(
  env.MPESA_CONSUMER_KEY &&
    env.MPESA_CONSUMER_SECRET &&
    env.MPESA_PASSKEY &&
    env.MPESA_CALLBACK_URL,
);

/**
 * True when the initiator credentials for B2C and Reversal are present.
 *
 * Deliberately separate from `mpesaConfigured`. Taking money and sending money
 * are different permissions with different credentials, and a deployment that
 * sells tickets should not implicitly gain the ability to move funds out
 * because someone filled in one more variable.
 */
export const mpesaInitiatorConfigured = Boolean(
  mpesaConfigured && env.MPESA_INITIATOR_NAME && env.MPESA_INITIATOR_PASSWORD,
);

/**
 * A public URL for one of this service's M-Pesa webhook paths.
 *
 * Built from the origin of `MPESA_CALLBACK_URL` rather than from four more
 * environment variables. That URL is already validated as https and already
 * pinned to a path this service actually serves, so reusing its origin means
 * the result and timeout URLs cannot be pointed somewhere the STK callback is
 * not — which is the failure that would otherwise be discovered only when a
 * payout result vanished.
 *
 * Carries the same shared-secret token, so all four endpoints authenticate the
 * same way.
 */
export function mpesaWebhookUrl(path: string): string {
  const configured = env.MPESA_CALLBACK_URL;
  if (!configured) {
    throw new Error('MPESA_CALLBACK_URL is not set — cannot derive a result URL');
  }

  const url = new URL(configured);
  url.pathname = path;
  url.search = '';
  if (env.MPESA_CALLBACK_TOKEN) {
    url.searchParams.set('token', env.MPESA_CALLBACK_TOKEN);
  }
  return url.toString();
}
