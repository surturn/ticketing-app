import { and, eq, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, organisationMembers, organisations } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Who is allowed to see which events.
//
// Everything in the schema reaches an owner through `events.organisation_id`,
// so this is the only place tenancy has to be decided — and the reason it lives
// in one module rather than as a `WHERE` clause remembered in each of the
// twenty-odd admin handlers. The failure mode being designed out is not "the
// filter is wrong" but "the filter is missing from the one route nobody
// reviewed".
// ---------------------------------------------------------------------------

/**
 * The scope an administrative request runs in.
 *
 * `platform` is the shared API key, which is how the dashboard has always
 * worked and still sees everything. It is a deliberate exemption rather than an
 * oversight: removing it would break the running deployment, and it is
 * attributable in the ledger as `admin:api-key`.
 *
 * `organisation` is an allowlisted account, which sees only what its
 * organisation owns. That path is what makes a second organiser safe, and it is
 * the one that grows.
 */
export type AdminScope =
  | { kind: 'platform' }
  | { kind: 'organisation'; organisationId: string };

/** The slug the single pre-existing organisation is created under. */
export const DEFAULT_ORGANISATION_SLUG = 'eventify';

/**
 * Resolves an authenticated admin account to the organisation it administers.
 *
 * Returns null when the account belongs to none, which is not the same as being
 * unauthenticated: an allowlisted address with no membership has proved who it
 * is and has nothing to manage, and the caller turns that into a 403 rather
 * than a 401.
 */
export async function scopeForUser(uid: string): Promise<AdminScope | null> {
  const [membership] = await db
    .select({ organisationId: organisationMembers.organisationId })
    .from(organisationMembers)
    .where(eq(organisationMembers.userId, uid))
    .limit(1);

  if (!membership) return null;
  return { kind: 'organisation', organisationId: membership.organisationId };
}

/**
 * The mandatory filter for any query over `events`.
 *
 * Returns `undefined` for the platform scope so it can be spread into an
 * `and(...)` unchanged — Drizzle drops undefined conditions, so the caller does
 * not branch and cannot accidentally write the filter only in the `if`.
 */
export function eventScopeFilter(scope: AdminScope): SQL | undefined {
  return scope.kind === 'platform'
    ? undefined
    : eq(events.organisationId, scope.organisationId);
}

/**
 * Loads an event, or refuses.
 *
 * Every admin route that takes an `:id` goes through this rather than selecting
 * the event itself, which is what makes the check structural: a handler cannot
 * obtain an event without stating the scope it is allowed to see it in.
 *
 * **A row outside the scope is reported as absent, not forbidden.** Answering
 * 403 would confirm the id exists, which turns this endpoint into a way for one
 * organiser to enumerate another's events by watching which ids come back 403
 * and which 404 — the difference between "you may not" and "there is nothing
 * here" is itself information.
 */
export async function loadScopedEvent(scope: AdminScope, eventId: string) {
  const [event] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eventScopeFilter(scope)))
    .limit(1);

  if (!event) throw notFound(`No event with id ${eventId}`);
  return event;
}

/**
 * Asserts that an event is in scope without loading the whole row.
 *
 * For the reporting routes, which already select what they need and only want
 * the ownership question answered first.
 */
export async function assertEventInScope(
  scope: AdminScope,
  eventId: string,
): Promise<void> {
  await loadScopedEvent(scope, eventId);
}

/**
 * The organisation a newly created event belongs to.
 *
 * An organisation-scoped admin creates within their own. The platform key has
 * no organisation of its own, so it falls back to the default one — which is
 * the behaviour that keeps the current dashboard working unchanged, and the
 * line to revisit the day the platform key is expected to create on behalf of
 * someone else.
 */
export async function organisationForNewEvent(scope: AdminScope): Promise<string> {
  if (scope.kind === 'organisation') return scope.organisationId;

  const [fallback] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, DEFAULT_ORGANISATION_SLUG))
    .limit(1);

  if (!fallback) {
    // The migration creates this row, so its absence means the database is not
    // the one the code expects. Failing loudly beats writing an event with an
    // owner nobody chose.
    throw forbidden(
      `No default organisation ("${DEFAULT_ORGANISATION_SLUG}") exists to own this event`,
    );
  }

  return fallback.id;
}
