import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, ticketTiers, type Event, type TicketTier } from '../db/schema.js';
import { cacheKeys, remember } from '../lib/cache.js';
import { notFound } from '../lib/errors.js';

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
  available: number;
  soldOut: boolean;
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
  const available = Math.max(
    tier.quantityTotal - tier.quantityReserved - tier.quantitySold,
    0,
  );
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
    soldOut: available <= 0,
    onSale: tier.status === 'active' && started && !ended && available > 0,
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

export async function listPublishedEvents(): Promise<
  Array<Omit<PublicEvent, 'tiers'>>
> {
  return remember(cacheKeys.publicEventList(), 60, async () => {
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.status, 'published'))
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

export async function getPublicEvent(slug: string): Promise<PublicEvent> {
  return remember(cacheKeys.eventBySlug(slug), 15, async () => {
    const event = await getEventRowBySlug(slug);

    if (event.status !== 'published') {
      throw notFound(`No event with slug "${slug}"`);
    }

    const tiers = await db
      .select()
      .from(ticketTiers)
      .where(
        and(eq(ticketTiers.eventId, event.id), eq(ticketTiers.status, 'active')),
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
export async function getAvailability(
  slug: string,
): Promise<Array<{ tierId: string; available: number; soldOut: boolean }>> {
  const event = await getEventRowBySlug(slug);

  return remember(cacheKeys.eventAvailability(event.id), 5, async () => {
    const tiers = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.eventId, event.id));

    return tiers.map((tier) => {
      const available = Math.max(
        tier.quantityTotal - tier.quantityReserved - tier.quantitySold,
        0,
      );
      return { tierId: tier.id, available, soldOut: available <= 0 };
    });
  });
}
