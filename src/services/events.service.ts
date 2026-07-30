import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, ticketTiers, type Event, type TicketTier } from '../db/schema.js';
import { cacheKeys, remember } from '../lib/cache.js';
import { notFound } from '../lib/errors.js';
import { availableSeats } from './inventory.service.js';

// ---------------------------------------------------------------------------
// Public read models.
//
// These are the endpoints a flash sale hammers, so they are cache-aside with a
// short TTL. The TTL is deliberately short and `available` is presented as
// indicative: the authoritative check happens inside the checkout transaction,
// and the UI should treat a 409 at checkout as normal, not exceptional.
// ---------------------------------------------------------------------------

export interface PublicTier {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  minPerOrder: number;
  maxPerOrder: number;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  /** Seats left, or `null` when the tier sells without a capacity limit. */
  available: number | null;
  uncapped: boolean;
  soldOut: boolean;
  closedByOrganiser: boolean;
  onSale: boolean;
}

export interface PublicEvent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  venue: string | null;
  timezone: string;
  currency: string;
  startsAt: Date;
  endsAt: Date | null;
  tiers: PublicTier[];
}

function toPublicTier(tier: TicketTier, currency: string): PublicTier {
  const remaining = availableSeats(tier);
  // `null` means uncapped, and stays null in the response so a storefront can
  // tell "unlimited" from "none left" rather than guessing from a zero.
  const available = remaining === null ? null : Math.max(remaining, 0);

  // Sold out two ways: capacity exhausted, or the organiser closed the sale.
  // The second is the only way an uncapped tier can ever be sold out, and it is
  // the whole point of the `closed` status.
  const closed = tier.status === 'closed';
  const soldOut = closed || (available !== null && available <= 0);

  const now = Date.now();
  const started = !tier.salesStartAt || tier.salesStartAt.getTime() <= now;
  const ended = Boolean(tier.salesEndAt && tier.salesEndAt.getTime() <= now);

  return {
    id: tier.id,
    name: tier.name,
    description: tier.description,
    priceCents: tier.priceCents,
    currency,
    minPerOrder: tier.minPerOrder,
    maxPerOrder: tier.maxPerOrder,
    salesStartAt: tier.salesStartAt,
    salesEndAt: tier.salesEndAt,
    available,
    /** True when this tier sells without a capacity limit. */
    uncapped: tier.quantityTotal === null,
    soldOut,
    /** True when sales were closed by the organiser rather than by capacity. */
    closedByOrganiser: closed,
    onSale: tier.status === 'active' && started && !ended && !soldOut,
  };
}

/** Raw event row by slug, uncached — used by checkout, which must not read stale. */
export async function getEventRowBySlug(slug: string): Promise<Event> {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.slug, slug))
    .limit(1);

  if (!event) throw notFound(`No event with slug "${slug}"`);
  return event;
}

/**
 * When an event is over.
 *
 * `ends_at` is optional, so a single-session event with only a start time is
 * treated as finishing then. Every "is this in the past" decision in the codebase
 * goes through this expression so the listing, the archive sweep and the delete
 * guard cannot disagree about whether an event has happened.
 */
const eventEndsAt = sql`coalesce(${events.endsAt}, ${events.startsAt})`;

/** Current events: published, not archived, and not yet finished. */
export async function listPublishedEvents(): Promise<
  Array<Omit<PublicEvent, 'tiers'>>
> {
  return remember(cacheKeys.publicEventList(), 60, async () => {
    const rows = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.status, 'published'),
          isNull(events.archivedAt),
          sql`${eventEndsAt} >= now()`,
        ),
      )
      .orderBy(asc(events.startsAt));

    return rows.map((event) => ({
      id: event.id,
      slug: event.slug,
      name: event.name,
      description: event.description,
      venue: event.venue,
      timezone: event.timezone,
      currency: event.currency,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
    }));
  });
}

export interface PastEvent extends Omit<PublicEvent, 'tiers'> {
  archived: boolean;
  archivedAt: Date | null;
}

/**
 * Events that have already happened, newest first.
 *
 * Archived events appear here — archiving moves an event into this list rather
 * than removing it. Anything that has finished is included whether or not the
 * sweep has reached it yet, so the two lists are complementary with no window in
 * which a just-finished event belongs to neither.
 */
export async function listPastEvents(limit = 50): Promise<PastEvent[]> {
  return remember(cacheKeys.pastEventList(), 300, async () => {
    const rows = await db
      .select()
      .from(events)
      .where(
        and(
          inArray(events.status, ['published', 'closed']),
          sql`${eventEndsAt} < now()`,
        ),
      )
      .orderBy(desc(sql`coalesce(${events.endsAt}, ${events.startsAt})`))
      .limit(Math.min(limit, 200));

    return rows.map((event) => ({
      id: event.id,
      slug: event.slug,
      name: event.name,
      description: event.description,
      venue: event.venue,
      timezone: event.timezone,
      currency: event.currency,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      archived: event.archivedAt !== null,
      archivedAt: event.archivedAt,
    }));
  });
}

/**
 * Archives every event that finished more than `afterDays` ago.
 *
 * Idempotent: `archived_at IS NULL` means a second run touches nothing, so the
 * repeatable sweep can overlap a manual archive harmlessly.
 */
export async function archivePastEvents(
  afterDays: number,
): Promise<Array<{ id: string; slug: string }>> {
  const archived = await db
    .update(events)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        isNull(events.archivedAt),
        sql`${eventEndsAt} < now() - ${`${afterDays} days`}::interval`,
      ),
    )
    .returning({ id: events.id, slug: events.slug });

  return archived;
}

export async function getPublicEvent(slug: string): Promise<PublicEvent> {
  return remember(cacheKeys.eventBySlug(slug), 15, async () => {
    const event = await getEventRowBySlug(slug);

    if (event.status !== 'published') {
      throw notFound(`No event with slug "${slug}"`);
    }

    // `closed` tiers are returned, not filtered out. The point of closing a sale
    // is that buyers see "sold out" — a tier that silently disappears looks like
    // a mistake, and a buyer holding a link to it gets no explanation. Only
    // `hidden` and `paused` are withheld.
    const tiers = await db
      .select()
      .from(ticketTiers)
      .where(
        and(
          eq(ticketTiers.eventId, event.id),
          inArray(ticketTiers.status, ['active', 'closed']),
        ),
      )
      .orderBy(asc(ticketTiers.sortOrder), asc(ticketTiers.priceCents));

    return {
      id: event.id,
      slug: event.slug,
      name: event.name,
      description: event.description,
      venue: event.venue,
      timezone: event.timezone,
      currency: event.currency,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      tiers: tiers.map((tier) => toPublicTier(tier, event.currency)),
    };
  });
}

/** Live counters, cached for only a few seconds — polled by the sale page. */
export async function getAvailability(slug: string): Promise<
  Array<{
    tierId: string;
    available: number | null;
    uncapped: boolean;
    soldOut: boolean;
    closedByOrganiser: boolean;
  }>
> {
  const event = await getEventRowBySlug(slug);

  return remember(cacheKeys.eventAvailability(event.id), 5, async () => {
    const tiers = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.eventId, event.id));

    return tiers.map((tier) => {
      const remaining = availableSeats(tier);
      const available = remaining === null ? null : Math.max(remaining, 0);
      const closed = tier.status === 'closed';
      return {
        tierId: tier.id,
        available,
        uncapped: remaining === null,
        soldOut: closed || (available !== null && available <= 0),
        closedByOrganiser: closed,
      };
    });
  });
}
