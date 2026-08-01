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

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: finalHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    /**
     * The request never reached the API: no signal, flight mode, a dropped
     * connection mid-tunnel, or the server not answering.
     *
     * `fetch` rejects with a bare `TypeError` whose message is "Failed to
     * fetch" — which is the browser talking to a developer, not the product
     * talking to a buyer. It also names the wrong culprit: it reads as though
     * the site is broken, when the usual cause is a train going through a
     * tunnel. Translated here, at the only place that can tell the difference
     * between "no network" and "the API said no".
     */
    throw new ApiError(
      0,
      'network_unreachable',
      'We could not reach the network. Check your connection and try again.',
      true,
    );
  }

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

// ─── Events ────────────────────────────────────────────────────────────────

export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  venue: string | null;
  /** The promoter's artwork. Null is normal — every surface must cope. */
  posterUrl: string | null;
  timezone: string;
  currency: string;
  startsAt: string;
  endsAt: string | null;
  /** Cheapest ticket currently on sale, or null when nothing is. */
  fromPriceCents: number | null;
}

export interface Tier {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  minPerOrder: number;
  maxPerOrder: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  /** Null when the tier is uncapped — not zero. */
  available: number | null;
  uncapped: boolean;
  soldOut: boolean;
  /** Sold out because the organiser ended the sale, not because stock ran out. */
  closedByOrganiser: boolean;
  onSale: boolean;
}

export interface EventDetail extends EventSummary {
  tiers: Tier[];
}

export function fetchEvents(): Promise<{ events: EventSummary[] }> {
  return apiFetch('/api/events');
}

export function fetchPastEvents(): Promise<{ events: EventSummary[] }> {
  return apiFetch('/api/events/past');
}

/**
 * In-flight and recently-resolved event requests, keyed by slug.
 *
 * The Speculation Rules API prefetches whole *documents*, which buys a
 * client-rendered app nothing — the navigation never leaves the page. The
 * equivalent win here is to start the request on tap-intent instead of on tap,
 * so the payload is usually already in hand by the time the route renders. On
 * a 4G connection in Nairobi that is the difference between a skeleton and no
 * skeleton at all.
 */
const eventCache = new Map<string, { at: number; promise: Promise<{ event: EventDetail }> }>();

/** Long enough to cover the gap between pointing at a card and tapping it. */
const PREFETCH_TTL_MS = 30_000;

function requestEvent(slug: string): Promise<{ event: EventDetail }> {
  return apiFetch<{ event: EventDetail }>(`/api/events/${encodeURIComponent(slug)}`);
}

export function fetchEvent(slug: string): Promise<{ event: EventDetail }> {
  const hit = eventCache.get(slug);
  if (hit && Date.now() - hit.at < PREFETCH_TTL_MS) {
    // Consumed once. Availability moves underneath this page constantly, so a
    // warmed payload is a head start on the first paint, never a cache the
    // page keeps reading from.
    eventCache.delete(slug);
    return hit.promise;
  }

  eventCache.delete(slug);
  return requestEvent(slug);
}

/**
 * Warm the payload for an event the buyer looks likely to open.
 *
 * Deliberately swallows failures: this is speculative work, and a prefetch that
 * surfaced an error would turn hovering a card into an error screen. If it
 * fails, the real request runs normally a moment later.
 */
export function prefetchEvent(slug: string): void {
  if (eventCache.has(slug)) return;

  const promise = requestEvent(slug);
  promise.catch(() => eventCache.delete(slug));
  eventCache.set(slug, { at: Date.now(), promise });
}

// ─── Checkout ──────────────────────────────────────────────────────────────

export interface BuyerDetails {
  name: string;
  email: string;
  phone: string;
}

export interface CheckoutBody {
  eventSlug: string;
  items: { tierId: string; quantity: number }[];
  buyer: BuyerDetails;
}

export interface PreviewResponse {
  buyer: BuyerDetails;
  totalCents: number;
  mpesaAmount: number;
  items: {
    tierName: string;
    quantity: number;
    availableNow: number | null;
    sufficient: boolean;
  }[];
  holdMinutes: number;
  /** False when the basket cannot be charged; `issues` says why. */
  chargeable: boolean;
  issues: string[];
}

/**
 * Prices a basket without reserving anything or contacting M-Pesa.
 *
 * Also the only place a buyer sees their phone number as it will actually be
 * stored — `0712 345 678` comes back as `254712345678` — so a typo surfaces
 * before it becomes a prompt sent to a stranger's handset.
 */
export function previewCheckout(body: CheckoutBody): Promise<PreviewResponse> {
  return apiFetch('/api/checkout/preview', { method: 'POST', body });
}

export interface CheckoutResponse {
  orderId: string;
  reference: string;
  status: string;
  totalCents: number;
  currency: string;
  expiresAt: string;
  payment?: { gateway: string; gatewayRef: string; customerMessage: string };
  idempotentReplay: boolean;
}

/**
 * Reserves inventory and pushes the M-Pesa prompt.
 *
 * The idempotency key is the buyer's protection against their own double-tap
 * and against a retry over a flaky connection: the same key returns the same
 * order rather than reserving a second set of seats and charging twice. It must
 * therefore be stable per basket, not regenerated per attempt.
 */
export function createCheckout(
  body: CheckoutBody,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  return apiFetch('/api/checkout', {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

// ─── Orders ────────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'pending'
  | 'awaiting_payment'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface OrderStatusResponse {
  reference: string;
  status: OrderStatus;
  paidAt: string | null;
  expiresAt: string | null;
  ticketCount: number;
  payment: { status: string; receipt: string | null; resultDesc: string | null } | null;
}

export interface OrderTicket {
  id: string;
  code: string;
  /** `code.signature` — what the QR encodes and what the gate verifies. */
  qr: string;
  tierName: string;
  status: 'issued' | 'checked_in' | 'void';
}

export interface OrderDetail {
  reference: string;
  status: OrderStatus;
  event: { slug: string; name: string; startsAt: string; venue: string | null };
  buyer: { name: string; email: string; phone: string };
  items: {
    tierName: string;
    quantity: number;
    unitPriceCents: number;
    subtotalCents: number;
  }[];
  totalCents: number;
  currency: string;
  expiresAt: string | null;
  paidAt: string | null;
  payment: {
    status: string;
    gateway: string;
    receipt: string | null;
    resultDesc: string | null;
  } | null;
  tickets: OrderTicket[];
}

export function fetchOrder(reference: string): Promise<{ order: OrderDetail }> {
  return apiFetch(`/api/orders/${encodeURIComponent(reference)}`);
}

/** The lightweight poll used while a payment is in flight. */
export function fetchOrderStatus(reference: string): Promise<OrderStatusResponse> {
  return apiFetch(`/api/orders/${encodeURIComponent(reference)}/status`);
}

export function cancelOrder(reference: string): Promise<unknown> {
  return apiFetch(`/api/orders/${encodeURIComponent(reference)}/cancel`, {
    method: 'POST',
  });
}

/** Statuses at which polling should stop — the order will not change again. */
export function isTerminal(status: OrderStatus): boolean {
  return (
    status === 'paid' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'expired'
  );
}
