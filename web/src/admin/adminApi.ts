/**
 * The admin API client.
 *
 * Every call carries the operator's key as `x-api-key`, which is what
 * `requireAdmin` compares against `ADMIN_API_KEY`. The key is held in
 * `sessionStorage` rather than `localStorage` deliberately: it is a long-lived
 * credential with full administrative reach, and scoping it to the tab means
 * closing the browser ends the session rather than leaving the key sitting on
 * disk indefinitely.
 *
 * This is the honest limitation of the current design — the API authenticates a
 * shared static key, not a user, so the dashboard can only be as strong as that
 * key. A short-lived token minted by a real login endpoint would be better, and
 * is the natural next step once organisers sign in as themselves.
 */
import { ApiError } from '@/lib/api';

const STORAGE_KEY = 'eventify-admin-key';

export function getAdminKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked outright in private modes. Failing to read is not
    // a reason to break the page; the operator is simply asked to sign in.
    return null;
  }
}

export function setAdminKey(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* Nothing to do — the key stays in memory for this page load only. */
  }
}

export function clearAdminKey(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Fetch against an admin route.
 *
 * `key` is passed explicitly on the sign-in path, where the credential is being
 * tested and is not yet in storage. Everywhere else it is read from storage.
 */
export async function adminFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string } = {},
): Promise<T> {
  const key = options.key ?? getAdminKey();
  if (!key) throw new ApiError(401, 'not_signed_in', 'Sign in to continue.');

  const headers = new Headers({ 'x-api-key': key });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError(
      0,
      'network_unreachable',
      'We could not reach the server. Check your connection and try again.',
      true,
    );
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: Record<string, unknown> } | null)?.error;

    // A rejected key means the stored one is wrong or has been rotated. Drop it
    // so the operator is returned to the gate rather than looping through
    // failures with a credential that will never work.
    if (response.status === 401) clearAdminKey();

    throw new ApiError(
      response.status,
      String(error?.code ?? 'unknown'),
      String(error?.message ?? `Request failed (${response.status})`),
      error?.retryable === true,
      // Zod issues come back here; the form uses them to mark the right field.
      (error?.details as unknown) ?? null,
    );
  }

  return payload as T;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type EventStatus = 'draft' | 'published' | 'closed' | 'cancelled';
export type TierStatus = 'active' | 'paused' | 'hidden' | 'closed';

export interface AdminEvent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  venue: string | null;
  posterUrl: string | null;
  timezone: string;
  currency: string;
  startsAt: string;
  endsAt: string | null;
  status: EventStatus;
  archivedAt: string | null;
}

export interface AdminTier {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  priceCents: number;
  quantityTotal: number | null;
  quantityReserved: number;
  quantitySold: number;
  minPerOrder: number;
  maxPerOrder: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  status: TierStatus;
  sortOrder: number;
}

export interface EventStats {
  inventory: {
    cappedCapacity: number;
    hasUncappedTiers: boolean;
    reserved: number;
    sold: number;
    available: number;
  };
  tiers: {
    tierId: string;
    name: string;
    priceCents: number;
    status: TierStatus;
    capacity: number | null;
    uncapped: boolean;
    reserved: number;
    sold: number;
    issued: number;
    checkedIn: number;
  }[];
  revenue: { paidOrders: number; grossCents: number };
  admissions: { issued: number; checkedIn: number };
  attention: { refundRequired: number };
}

/** The payload shape the admin routes accept. Mirrors `eventFields` exactly. */
export interface EventInput {
  slug: string;
  name: string;
  description?: string;
  venue?: string;
  posterUrl?: string;
  timezone: string;
  currency: string;
  startsAt: string;
  endsAt?: string;
  status: EventStatus;
}

export interface TierInput {
  name: string;
  description?: string;
  priceCents: number;
  quantityTotal?: number | null;
  minPerOrder: number;
  maxPerOrder: number;
  salesStartAt?: string;
  salesEndAt?: string;
  status: TierStatus;
  sortOrder: number;
}

// ─── Calls ─────────────────────────────────────────────────────────────────

export const listEvents = () => adminFetch<{ events: AdminEvent[] }>('/api/admin/events');

export const createEvent = (body: EventInput) =>
  adminFetch<{ event: AdminEvent }>('/api/admin/events', { method: 'POST', body });

export const updateEvent = (id: string, body: Partial<EventInput>) =>
  adminFetch<{ event: AdminEvent }>(`/api/admin/events/${id}`, { method: 'PATCH', body });

export const listTiers = (eventId: string) =>
  adminFetch<{ tiers: AdminTier[] }>(`/api/admin/events/${eventId}/tiers`);

export const createTier = (eventId: string, body: TierInput) =>
  adminFetch<{ tier: AdminTier }>(`/api/admin/events/${eventId}/tiers`, {
    method: 'POST',
    body,
  });

export const updateTier = (tierId: string, body: Partial<TierInput>) =>
  adminFetch<{ tier: AdminTier }>(`/api/admin/tiers/${tierId}`, { method: 'PATCH', body });

export const ACCEPTED_POSTER_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_POSTER_BYTES = 2 * 1024 * 1024;

/**
 * Uploads a poster and returns its public URL.
 *
 * Not routed through `adminFetch`: that sets a JSON content type and stringifies
 * the body, and a multipart request must be left alone so the browser can set
 * its own boundary. The key handling is the same.
 */
export async function uploadPoster(file: File): Promise<{ url: string }> {
  const key = getAdminKey();
  if (!key) throw new ApiError(401, 'not_signed_in', 'Sign in to continue.');

  const form = new FormData();
  form.append('file', file);

  let response: Response;
  try {
    response = await fetch('/api/admin/uploads/poster', {
      method: 'POST',
      headers: { 'x-api-key': key },
      body: form,
    });
  } catch {
    throw new ApiError(0, 'network_unreachable', 'Upload failed — check your connection.');
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: Record<string, unknown> } | null)?.error;
    if (response.status === 401) clearAdminKey();
    throw new ApiError(
      response.status,
      String(error?.code ?? 'unknown'),
      String(error?.message ?? 'That upload failed.'),
    );
  }

  return { url: (payload as { poster: { url: string } }).poster.url };
}

export const getStats = (eventId: string) =>
  adminFetch<EventStats>(`/api/admin/events/${eventId}/stats`);

/**
 * Verifies a key by making a real authenticated request.
 *
 * There is no dedicated "check my credential" endpoint, and inventing one would
 * mean touching the API. Listing events is the cheapest call that genuinely
 * exercises `requireAdmin`, so a success here means the key works for
 * everything else too — no guessing, and no gate that lets someone in only to
 * fail on their first real action.
 */
export async function verifyAdminKey(key: string): Promise<void> {
  await adminFetch<{ events: AdminEvent[] }>('/api/admin/events', { key });
}
