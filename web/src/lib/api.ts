/**
 * The API client.
 *
 * Same origin in production and proxied to the same path in development, so
 * every request here is a bare `/api/...` with no base URL to configure and no
 * CORS in the buyer's path.
 */
import { getFirebaseAuth } from './firebase';

/** The API's error envelope: `{ error: { code, message, details?, retryable } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    /**
     * The envelope's `details`, when it carries one.
     *
     * For a validation failure this is the list of Zod issues, which is what
     * lets a form put the message against the field that caused it rather than
     * showing one banner for the whole submission.
     */
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Pulls per-field messages out of a validation failure.
 *
 * The API's `details` on a 400 is the list of Zod issues, each with a `path`
 * like `buyer.email` — it is shaped this way precisely so a form can put the
 * message against the field that caused it rather than showing one banner for
 * the whole submission. Without this the buyer is told "the request is not
 * valid" and left to guess which of five inputs to look at.
 *
 * Keyed on the last path segment, because the form's field names are flat
 * (`email`) while the request nests them (`buyer.email`).
 */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  if (!Array.isArray(error.details)) return {};

  const out: Record<string, string> = {};

  for (const issue of error.details) {
    const { path, message } =
      (issue as { path?: unknown; message?: unknown }) ?? {};
    if (typeof path !== 'string' || typeof message !== 'string') continue;

    const field = path.split('.').pop();
    // First message per field wins. Zod can report several for one input, and
    // stacking them under a text box is less useful than the first thing wrong.
    if (field && !(field in out)) out[field] = message;
  }

  return out;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /**
   * Attach the buyer's ID token. Off by default so public endpoints — events,
   * checkout — cannot accidentally become authenticated ones.
   */
  auth?: boolean;
  /**
   * Attach the buyer's ID token when there is one, and proceed without it when
   * there is not.
   *
   * For endpoints that answer either way and answer *more* when they know who
   * is asking — the order page above all, where a guest sees their order and a
   * signed-in owner also gets the scannable tickets. `auth: true` is wrong
   * there: it would refuse a guest their own order rather than showing them the
   * part they are entitled to.
   */
  optionalAuth?: boolean;
}

export async function apiFetch<T>(
  path: string,
  { body, auth = false, optionalAuth = false, headers, ...init }: RequestOptions = {},
): Promise<T> {
  const finalHeaders = new Headers(headers);

  if (optionalAuth && !auth) {
    // Inside the branch, not hoisted above it: a guest request — the common
    // case for events, checkout, an order opened from a shared link — must
    // never touch Firebase at all. Awaiting `getFirebaseAuth()` unconditionally
    // here would load the SDK for every request regardless of whether anyone
    // is signed in, which is exactly the download this branch exists to avoid.
    //
    // The whole thing — the load and the token fetch — sits inside one
    // try/catch now, not just the token fetch. `getFirebaseAuth()` can reject:
    // a chunk 404 from a tab left open across a deploy, or any other transient
    // network failure fetching the SDK. This is `optionalAuth`, so that must
    // degrade exactly like a failed `getIdToken()` already does — the request
    // proceeds unauthenticated — rather than throwing out of a call that has
    // no business requiring Firebase to have loaded at all. That distinction
    // matters most on the order page: it is reached by `fetchOrder`, the page
    // a buyer opens at the gate to show their ticket, and a Firebase hiccup
    // must not be able to break that for someone who was never signed in to
    // begin with.
    try {
      const user = (await getFirebaseAuth()).currentUser;
      if (user) {
        finalHeaders.set('Authorization', `Bearer ${await user.getIdToken()}`);
      }
    } catch {
      /* proceed unauthenticated */
    }
  }

  if (auth) {
    const user = (await getFirebaseAuth()).currentUser;
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
  /** Only `true` is meaningful — consent is withdrawn by closing the account. */
  acceptTerms?: true;
}): Promise<{ user: { displayName: string | null; phone: string | null } }> {
  return apiFetch('/api/account/me', { method: 'PATCH', auth: true, body: fields });
}

/**
 * Ask to hear about new events.
 *
 * Public and unauthenticated, and double opt-in at the far end: this sends a
 * confirmation the person still has to act on, so nobody is added to a list by
 * this call alone.
 */
export function subscribeToAnnouncements(email: string): Promise<unknown> {
  return apiFetch('/api/subscribe', { method: 'POST', body: { email } });
}

// ─── Events ────────────────────────────────────────────────────────────────

export type EventCategory =
  | 'music'
  | 'comedy'
  | 'business'
  | 'sports'
  | 'festival'
  | 'arts'
  | 'other';

export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  venue: string | null;
  /** The promoter's artwork. Null is normal — every surface must cope. */
  posterUrl: string | null;
  /**
   * The 16:9 banner. Null is normal and every surface must cope — see
   * `heroFor`, which is the only place the fallback is decided.
   */
  heroUrl: string | null;
  category: EventCategory | null;
  /**
   * Who is running it. Always present — an event cannot exist without an owner.
   * `verified` means the platform has vetted them; there is no counter-badge
   * for false, because absence is the signal.
   */
  organiser: { name: string; slug: string; verified: boolean };
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
  /**
   * Explicit acceptance of the terms and privacy notice.
   *
   * Only sent by the checkout call. The preview endpoint prices a basket and
   * reserves nothing, so it must stay usable before the buyer has been shown
   * what they would be agreeing to.
   */
  acceptedTerms?: true;
  /** Separate from the above, and never inferred from it. */
  marketingOptIn?: boolean;
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
  /** `null` when the viewer does not own this order — see `ticketsRedacted`. */
  code: string | null;
  /**
   * `code.signature` — what the QR encodes and what the gate verifies.
   *
   * `null` for anyone but the order's owner. The reference alone is enough to
   * read an order, and it travels through forwarded links and screenshots, so
   * the part that opens a gate is not handed out with it.
   */
  qr: string | null;
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
  // Optional auth: the reference alone returns the order, and a signed-in owner
  // additionally gets the scannable ticket payloads.
  return apiFetch(`/api/orders/${encodeURIComponent(reference)}`, { optionalAuth: true });
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
