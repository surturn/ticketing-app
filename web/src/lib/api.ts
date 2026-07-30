/**
 * The API client.
 *
 * Same origin in production and proxied to the same path in development, so
 * every request here is a bare `/api/...` with no base URL to configure and no
 * CORS in the buyer's path.
 */
import { firebaseAuth } from './firebase';

/** The API's error envelope: `{ error: { code, message, details?, retryable } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /**
   * Attach the buyer's ID token. Off by default so public endpoints — events,
   * checkout — cannot accidentally become authenticated ones.
   */
  auth?: boolean;
}

export async function apiFetch<T>(
  path: string,
  { body, auth = false, headers, ...init }: RequestOptions = {},
): Promise<T> {
  const finalHeaders = new Headers(headers);

  if (auth) {
    const user = firebaseAuth().currentUser;
    if (!user) throw new ApiError(401, 'not_signed_in', 'Sign in to continue.');

    // Not cached. `getIdToken` returns the current token and refreshes it only
    // when it is close to expiring, so this is cheap on every call and removes
    // any chance of sending a token that went stale while a tab sat open.
    finalHeaders.set('Authorization', `Bearer ${await user.getIdToken()}`);
  }

  if (body !== undefined) finalHeaders.set('Content-Type', 'application/json');

  const response = await fetch(path, {
    ...init,
    headers: finalHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: Record<string, unknown> } | null)?.error;
    throw new ApiError(
      response.status,
      String(error?.code ?? 'unknown'),
      String(error?.message ?? `Request failed (${response.status})`),
      error?.retryable === true,
    );
  }

  return payload as T;
}

// ─── Accounts ──────────────────────────────────────────────────────────────

export interface SessionResponse {
  user: {
    email: string;
    emailVerified: boolean;
    displayName: string | null;
    phone: string | null;
    announcementsOptIn: boolean;
  };
  /** True the first time this account was seen by the API. */
  created: boolean;
  /** Past guest orders attached to the account by this sign-in. */
  linkedOrders: number;
  /** When true, orders bought as a guest stay unclaimed until the email is verified. */
  verificationRequiredToLinkOrders: boolean;
}

/**
 * Announces a sign-in to the API, which mirrors the account locally and adopts
 * any orders bought as a guest with the same verified address.
 *
 * Called after every sign-in, not only the first: Firebase is where email and
 * verification state actually change, and this is how the API finds out. It is
 * also why a buyer who verifies their address later and returns finds their
 * older orders waiting — the linking runs again.
 */
export function postSession(): Promise<SessionResponse> {
  return apiFetch<SessionResponse>('/api/account/session', {
    method: 'POST',
    auth: true,
  });
}

export interface AccountOrder {
  reference: string;
  status: string;
  eventId: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  paidAt: string | null;
}

export function fetchMyOrders(): Promise<{ orders: AccountOrder[] }> {
  return apiFetch('/api/account/orders', { auth: true });
}

export function updateMyProfile(fields: {
  displayName?: string;
  phone?: string;
}): Promise<{ user: { displayName: string | null; phone: string | null } }> {
  return apiFetch('/api/account/me', { method: 'PATCH', auth: true, body: fields });
}
