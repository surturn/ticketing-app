import { env, mpesaPartyB } from '../../config/env.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { cacheRedis } from '../../lib/redis.js';

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

const TOKEN_CACHE_KEY = 'mpesa:oauth-token';
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

  const response = await fetchWithTimeout(
    `${getBaseUrl()}/mpesa/stkpush/v1/processrequest`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw serviceUnavailable(
      'gateway_error',
      `Daraja STK Push failed (${response.status}): ${text}`,
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
