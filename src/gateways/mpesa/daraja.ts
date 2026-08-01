import { createHash } from 'node:crypto';
import {
  MPESA_B2C_RESULT_PATH,
  MPESA_B2C_TIMEOUT_PATH,
  MPESA_REVERSAL_RESULT_PATH,
  MPESA_REVERSAL_TIMEOUT_PATH,
  env,
  mpesaInitiatorConfigured,
  mpesaPartyB,
  mpesaWebhookUrl,
} from '../../config/env.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { cacheRedis } from '../../lib/redis.js';
import { buildSecurityCredential } from './security-credential.js';

// ---------------------------------------------------------------------------
// Raw Safaricom Daraja client. Knows nothing about orders or tickets.
// ---------------------------------------------------------------------------

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface CallbackMetadataItem {
  Name: string;
  Value?: string | number;
}

export interface StkCallback {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: { Item: CallbackMetadataItem[] };
}

export interface MpesaCallbackBody {
  Body: { stkCallback: StkCallback };
}

export interface StkQueryResponse {
  ResponseCode: string;
  ResponseDescription: string;
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: string;
  ResultDesc: string;
}

export function getBaseUrl(): string {
  return env.MPESA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

// ---------------------------------------------------------------------------
// OAuth token
//
// Cached in Redis, not in process memory: with autoscaling every new container
// would otherwise mint its own token on boot, and Daraja rate-limits the token
// endpoint hard enough that a scale-up during a flash sale can get throttled.
// A local copy short-circuits the Redis round trip on the hot path.
// ---------------------------------------------------------------------------

/**
 * The token cache key, scoped to the credentials that minted the token.
 *
 * It used to be a bare `mpesa:oauth-token`, and that is a real trap: a token is
 * only valid for the environment and app that issued it, so switching
 * `MPESA_ENVIRONMENT` from sandbox to production left the *sandbox* token
 * sitting in Redis, still inside its hour, and every production push was made
 * with it. Daraja answers that with `404.001.03 Invalid Access Token`, which
 * names neither the cache nor the environment and sends you looking at your
 * credentials instead.
 *
 * The consumer key is hashed in rather than used directly — it is a credential,
 * and Redis keys turn up in logs, slow-query output and monitoring. Eight bytes
 * is ample to separate two apps without carrying the secret around.
 */
const TOKEN_CACHE_KEY = (() => {
  const fingerprint = createHash('sha256')
    .update(`${env.MPESA_ENVIRONMENT}:${env.MPESA_CONSUMER_KEY ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return `mpesa:oauth-token:${env.MPESA_ENVIRONMENT}:${fingerprint}`;
})();

const TOKEN_SAFETY_MARGIN_SECONDS = 120;

let localToken: { value: string; expiresAt: number } | null = null;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw serviceUnavailable('gateway_timeout', `Daraja request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Throws away the cached token, in this process and in Redis.
 *
 * Called when Daraja rejects a token we believed was current. A token can stop
 * working before its stated expiry — credentials rotated in the portal, an app
 * disabled, a cached value that outlived an environment switch — and without
 * this the whole cache window has to elapse before anything works again. With
 * it, the next attempt mints a fresh one.
 */
/**
 * Whether a Daraja response means "your token is no good".
 *
 * Matched on the error code rather than the status: the status is 404, which on
 * any other API would mean the endpoint does not exist, and treating it that way
 * would send someone looking for a typo in a URL that is perfectly correct.
 */
export function isInvalidTokenResponse(status: number, body: string): boolean {
  if (status !== 401 && status !== 404) return false;
  return /404\.001\.03/.test(body) || /invalid access token/i.test(body);
}

export async function invalidateAccessToken(): Promise<void> {
  localToken = null;
  try {
    await cacheRedis.del(TOKEN_CACHE_KEY);
  } catch (error) {
    logger.warn({ err: error }, 'could not clear the cached Daraja token');
  }
}

export async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (localToken && now < localToken.expiresAt) {
    return localToken.value;
  }

  try {
    const shared = await cacheRedis.get(TOKEN_CACHE_KEY);
    if (shared) {
      const ttl = await cacheRedis.ttl(TOKEN_CACHE_KEY);
      localToken = { value: shared, expiresAt: now + Math.max(ttl, 1) * 1000 };
      return shared;
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not read cached Daraja token, minting a new one');
  }

  const key = env.MPESA_CONSUMER_KEY;
  const secret = env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) {
    throw serviceUnavailable(
      'gateway_not_configured',
      'MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET are not set',
    );
  }

  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');
  const response = await fetchWithTimeout(
    `${getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { method: 'GET', headers: { Authorization: `Basic ${credentials}` } },
  );

  if (!response.ok) {
    const text = await response.text();
    throw serviceUnavailable(
      'gateway_auth_failed',
      `Daraja OAuth failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as { access_token: string; expires_in: string };
  const expiresIn = Number.parseInt(data.expires_in, 10) || 3600;
  const ttl = Math.max(expiresIn - TOKEN_SAFETY_MARGIN_SECONDS, 60);

  localToken = { value: data.access_token, expiresAt: now + ttl * 1000 };

  try {
    await cacheRedis.set(TOKEN_CACHE_KEY, data.access_token, 'EX', ttl);
  } catch (error) {
    logger.warn({ err: error }, 'could not cache Daraja token');
  }

  return data.access_token;
}

// ---------------------------------------------------------------------------
// Timestamp / password
// ---------------------------------------------------------------------------

/** Daraja expects YYYYMMDDHHmmss in East Africa Time (UTC+3). */
export function generateTimestamp(date = new Date()): string {
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    eat.getUTCFullYear(),
    pad(eat.getUTCMonth() + 1),
    pad(eat.getUTCDate()),
    pad(eat.getUTCHours()),
    pad(eat.getUTCMinutes()),
    pad(eat.getUTCSeconds()),
  ].join('');
}

export function generatePassword(timestamp: string): string {
  const passkey = env.MPESA_PASSKEY;
  if (!passkey) {
    throw serviceUnavailable('gateway_not_configured', 'MPESA_PASSKEY is not set');
  }
  return Buffer.from(`${env.MPESA_SHORTCODE}${passkey}${timestamp}`).toString('base64');
}

/** Parses Daraja's 20240115123045 (EAT) into a real Date. */
export function parseTransactionDate(value: string | number | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value);
  if (!/^\d{14}$/.test(raw)) return undefined;
  const iso =
    `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` +
    `T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+03:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// ---------------------------------------------------------------------------
// STK Push
// ---------------------------------------------------------------------------

export interface StkPushParams {
  phone: string;
  /** Whole shillings — Daraja rejects/truncates decimals. */
  amount: number;
  accountReference: string;
  description: string;
}

export async function stkPush(params: StkPushParams): Promise<StkPushResponse> {
  const callbackUrl = env.MPESA_CALLBACK_URL;
  if (!callbackUrl) {
    throw serviceUnavailable('gateway_not_configured', 'MPESA_CALLBACK_URL is not set');
  }

  const token = await getAccessToken();
  const timestamp = generateTimestamp();

  const url = new URL(callbackUrl);
  if (env.MPESA_CALLBACK_TOKEN) {
    url.searchParams.set('token', env.MPESA_CALLBACK_TOKEN);
  }

  const payload = {
    BusinessShortCode: env.MPESA_SHORTCODE,
    Password: generatePassword(timestamp),
    Timestamp: timestamp,
    TransactionType: env.MPESA_TRANSACTION_TYPE,
    Amount: params.amount,
    PartyA: params.phone,
    PartyB: mpesaPartyB,
    PhoneNumber: params.phone,
    CallBackURL: url.toString(),
    // Daraja truncates these; keep them short so the buyer sees something useful.
    AccountReference: params.accountReference.slice(0, 12),
    TransactionDesc: params.description.slice(0, 13),
  };

  const send = (bearer: string) =>
    fetchWithTimeout(`${getBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  let response = await send(token);
  let text = await response.text();

  /**
   * One retry, and only for a rejected token.
   *
   * Daraja answers a token it does not accept with `404.001.03 Invalid Access
   * Token`, which is a 404 — the status says "no such thing", the body says
   * "your credential is stale". A cached token can stop being valid before its
   * stated expiry, and until that window elapsed every buyer pressing pay saw a
   * failure for a payment that would have worked a minute later.
   *
   * Narrow on purpose: the token is discarded and the push is sent once more.
   * Anything else is not retried, because a retried push is a second prompt on
   * somebody's phone and a second chance to be charged.
   */
  if (!response.ok && isInvalidTokenResponse(response.status, text)) {
    logger.warn('Daraja rejected the cached token; minting a new one and retrying');
    await invalidateAccessToken();
    response = await send(await getAccessToken());
    text = await response.text();
  }

  if (!response.ok) {
    throw serviceUnavailable(
      'gateway_error',
      `Daraja STK Push failed (${response.status}): ${text}`,
      'We could not reach M-Pesa just then. Nothing was charged — please try again.',
    );
  }

  const data = JSON.parse(text) as StkPushResponse;

  if (data.ResponseCode !== '0') {
    throw serviceUnavailable(
      'gateway_rejected',
      `Daraja rejected the STK Push: ${data.ResponseDescription}`,
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// STK Query — reconciliation when a callback never lands
// ---------------------------------------------------------------------------

export async function stkQuery(checkoutRequestId: string): Promise<StkQueryResponse> {
  const token = await getAccessToken();
  const timestamp = generateTimestamp();

  const response = await fetchWithTimeout(
    `${getBaseUrl()}/mpesa/stkpushquery/v1/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: env.MPESA_SHORTCODE,
        Password: generatePassword(timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    // 500 with "transaction is being processed" is Daraja's way of saying
    // "still pending" — the caller treats that as not-yet-final.
    throw serviceUnavailable(
      'gateway_error',
      `Daraja STK Query failed (${response.status}): ${text}`,
    );
  }

  return JSON.parse(text) as StkQueryResponse;
}

// ---------------------------------------------------------------------------
// Initiator products — B2C and Reversal
//
// Both move money out of the shortcode, and both are asynchronous in a way STK
// Push is not. The POST returns an acknowledgement only: it says Daraja
// accepted the instruction, never that it succeeded. The real outcome arrives
// minutes later on `ResultURL`, or on `QueueTimeOutURL` if Daraja could not
// process it in time.
//
// Treating the acknowledgement as success is the single most expensive mistake
// available here — it would mark an organiser as paid the instant the request
// was queued, including when the transfer later fails.
// ---------------------------------------------------------------------------

/** What Daraja returns immediately from B2C and Reversal. Not an outcome. */
export interface InitiatorAck {
  /** Ours, echoed back on the result callback — the only join key we control. */
  OriginatorConversationID: string;
  /** Safaricom's id for the same conversation. */
  ConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
}

/** One entry from a result callback's parameter bag. */
export interface ResultParameterItem {
  Key: string;
  Value?: string | number;
}

/**
 * The body posted to a `ResultURL`.
 *
 * `ResultParameters` is a bag of key/value pairs whose contents differ per
 * product, which is why it is read through `resultParameter` rather than
 * destructured — a field that is absent for one command must not throw for
 * another.
 */
export interface InitiatorResultBody {
  Result: {
    ResultType: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID: string;
    ResultParameters?: { ResultParameter: ResultParameterItem[] };
    ReferenceData?: { ReferenceItem: ResultParameterItem | ResultParameterItem[] };
  };
}

/** Reads one value out of a result callback's parameter bag, if present. */
export function resultParameter(
  body: InitiatorResultBody,
  key: string,
): string | number | undefined {
  const items = body.Result?.ResultParameters?.ResultParameter;
  if (!Array.isArray(items)) return undefined;
  return items.find((item) => item.Key === key)?.Value;
}

/**
 * Shared POST for the two initiator products.
 *
 * Kept together because the failure handling is identical and subtle: a
 * non-zero `ResponseCode` on the acknowledgement means the instruction was
 * never queued, which is safe to surface as an error. Anything after that point
 * is not, because the money may already be moving.
 */
async function postInitiatorRequest(
  path: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<InitiatorAck> {
  if (!mpesaInitiatorConfigured) {
    throw serviceUnavailable(
      'gateway_not_configured',
      `MPESA_INITIATOR_NAME and MPESA_INITIATOR_PASSWORD must both be set — ` +
        `${label} cannot be used`,
    );
  }

  const token = await getAccessToken();

  const response = await fetchWithTimeout(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw serviceUnavailable(
      'gateway_error',
      `Daraja ${label} failed (${response.status}): ${text}`,
    );
  }

  const data = JSON.parse(text) as InitiatorAck;

  if (data.ResponseCode !== '0') {
    throw serviceUnavailable(
      'gateway_rejected',
      `Daraja rejected the ${label}: ${data.ResponseDescription}`,
    );
  }

  return data;
}

export interface B2CParams {
  /** Recipient MSISDN, 2547XXXXXXXX. */
  phone: string;
  /** Whole shillings — Daraja rejects decimals. */
  amount: number;
  /**
   * Our own id for this payout, echoed back on the result callback.
   *
   * Must be unique per attempt and is the only key we control on both sides, so
   * it is what a result is matched against. Without it, two payouts of the same
   * amount to the same organiser are indistinguishable when their results land.
   */
  originatorConversationId: string;
  remarks: string;
  occasion?: string;
}

/**
 * Pays an organiser out to their M-Pesa number.
 *
 * Returns as soon as Daraja accepts the instruction. The caller must treat the
 * payout as in-flight, not settled, until the result callback arrives.
 */
export async function b2cPayment(params: B2CParams): Promise<InitiatorAck> {
  const payload = {
    OriginatorConversationID: params.originatorConversationId,
    InitiatorName: env.MPESA_INITIATOR_NAME,
    SecurityCredential: buildSecurityCredential(),
    CommandID: env.MPESA_B2C_COMMAND,
    Amount: params.amount,
    // PartyA is the paying shortcode. Not `mpesaPartyB` — that is the Till that
    // *receives* customer payments, and is frequently a different number.
    PartyA: env.MPESA_SHORTCODE,
    PartyB: params.phone,
    Remarks: params.remarks.slice(0, 100),
    QueueTimeOutURL: mpesaWebhookUrl(MPESA_B2C_TIMEOUT_PATH),
    ResultURL: mpesaWebhookUrl(MPESA_B2C_RESULT_PATH),
    Occasion: (params.occasion ?? '').slice(0, 100),
  };

  logger.info(
    {
      originatorConversationId: params.originatorConversationId,
      amount: params.amount,
      command: env.MPESA_B2C_COMMAND,
    },
    'initiating M-Pesa B2C payout',
  );

  return postInitiatorRequest('/mpesa/b2c/v1/paymentrequest', payload, 'B2C payout');
}

export interface ReversalParams {
  /**
   * The M-Pesa receipt of the transaction being reversed, e.g. `SBK1A2B3C4`.
   *
   * This is the receipt recorded against the payment, not our order reference.
   */
  transactionId: string;
  /** Whole shillings. Must match the original transaction. */
  amount: number;
  originatorConversationId: string;
  remarks: string;
  occasion?: string;
}

/**
 * Reverses a completed C2B payment, returning the money to the payer.
 *
 * `ReceiverParty` is our own shortcode — the money is coming *back out* of it —
 * and identifier type 11 is Safaricom's code for an organisation shortcode.
 * Type 4 (organisation) is the value most commonly copied from older examples
 * and is rejected for reversals.
 */
export async function reverseTransaction(
  params: ReversalParams,
): Promise<InitiatorAck> {
  const payload = {
    OriginatorConversationID: params.originatorConversationId,
    Initiator: env.MPESA_INITIATOR_NAME,
    SecurityCredential: buildSecurityCredential(),
    CommandID: 'TransactionReversal',
    TransactionID: params.transactionId,
    Amount: params.amount,
    ReceiverParty: env.MPESA_SHORTCODE,
    // Safaricom's own spelling. Correcting it to "Receiver" makes the request
    // fail validation, so the typo is load-bearing.
    RecieverIdentifierType: '11',
    ResultURL: mpesaWebhookUrl(MPESA_REVERSAL_RESULT_PATH),
    QueueTimeOutURL: mpesaWebhookUrl(MPESA_REVERSAL_TIMEOUT_PATH),
    Remarks: params.remarks.slice(0, 100),
    Occasion: (params.occasion ?? '').slice(0, 100),
  };

  logger.info(
    {
      originatorConversationId: params.originatorConversationId,
      transactionId: params.transactionId,
      amount: params.amount,
    },
    'initiating M-Pesa reversal',
  );

  return postInitiatorRequest('/mpesa/reversal/v1/request', payload, 'reversal');
}
