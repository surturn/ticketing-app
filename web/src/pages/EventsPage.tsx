/**
 * The homepage: a listing pitch, then what's on.
 *
 * The order is the whole argument. Almost nobody arrives here to browse — a
 * buyer taps an event link from a WhatsApp group and lands on the event page,
 * never on this one. The person who *does* type the domain in is usually
 * deciding where to list. So the organiser pitch takes the top of the page and
 * discovery sits below it, growing in prominence as listing volume grows.
 *
 * Below the fold, the artwork is the product photo — promotion in this market
 * runs on posters — so that half of the page's job is to show it undamaged,
 * state the price before anyone has to click, and let search narrow it
 * instantly.
 *
 * Events without artwork fall back to the ticket's own language rather than a
 * grey box, so a poster-less event reads as deliberate.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchEvents, fetchMyOrders, type AccountOrder } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/auth/AuthProvider';
import { selectUpcoming, UpcomingTickets } from '@/components/UpcomingTickets';
import { EventPoster } from '@/components/EventPoster';
import { FeaturedEvent } from '@/components/FeaturedEvent';
import { EventRail } from '@/components/EventRail';
import { HomeHero } from '@/components/HomeHero';
import { OrganiserBand } from '@/components/OrganiserBand';
import { Section } from '@/components/Section';
import { TrustBar, BUYER_TRUST } from '@/components/TrustBar';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/eventImages';
import {
  applyFilters,
  DEFAULT_FILTERS,
  EventFilters,
  type FilterState,
} from '@/components/EventFilters';
import { Button, ButtonLink, EmptyState, ErrorState, Skeleton } from '@/components/ui';

function PosterSkeleton() {
  return (
    <div>
      {/* Matches the poster frame exactly, so nothing moves when artwork lands. */}
      <Skeleton className="aspect-4/5 w-full rounded-md" />
      <Skeleton className="mt-3 h-4 w-4/5" />
      <Skeleton className="mt-2 h-3 w-3/5" />
    </div>
  );
}

export function EventsPage() {
  const { data, loading, error, reload } = useAsync(fetchEvents);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const { status, user, session } = useAuth();

  const signedIn = status === 'signed-in';

  /**
   * The buyer's own orders, fetched only once they are known to be signed in.
   *
   * Deliberately not part of the page's main `useAsync`: a failure here must
   * not take the event listing down with it. Someone whose orders will not load
   * should still be able to browse and buy — so this fails quietly to an empty
   * list, and the personal module simply does not appear.
   */
  const [orders, setOrders] = useState<AccountOrder[]>([]);

  useEffect(() => {
    if (!signedIn) {
      setOrders([]);
      return;
    }

    let cancelled = false;
    fetchMyOrders()
      .then((r) => !cancelled && setOrders(r.orders))
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const events = data?.events ?? [];

  const upcoming = useMemo(
    () => (signedIn ? selectUpcoming(orders, events) : []),
    [signedIn, orders, events],
  );
  const filtered = useMemo(() => applyFilters(events, filters), [events, filters]);

  // The spotlight is the soonest event, and only while the buyer is browsing
  // unfiltered. Once they search, they have told us what they want and a
  // feature slot for something else is just an obstacle above the results.
  // A chosen category counts as narrowing too: it also gates the category
  // rails below, and a buyer who just tapped "Music" should not see a Comedy
  // rail sitting above a grid that is already narrowed to Music — that reads
  // as the page ignoring what they asked for.
  const isBrowsing =
    filters.query.trim() === '' &&
    filters.window === 'any' &&
    filters.sort === 'soonest' &&
    filters.category === null;
  const featured = isBrowsing ? filtered[0] : undefined;

  return (
    <div>
      {/* The landing page is what's on, and nothing else.
          The listing pitch lives at /host rather than here: a visitor arriving
          at the domain is looking for something to go to, and a sales page for
          organisers above the grid put the wrong audience's screen first. The
          organiser door stays in the app bar and the footer, where someone
          looking for it will look. */}
      {signedIn ? (
        <UpcomingTickets
          tickets={upcoming}
          name={
            (session?.user.displayName ?? user?.displayName)?.split(' ')[0] ?? null
          }
        />
      ) : (
        <HomeHero
          events={events}
          query={filters.query}
          onQueryChange={(query) => setFilters((f) => ({ ...f, query }))}
        />
      )}

      <div className="mb-(--space-section-sm) sm:mb-(--space-section)">
        <TrustBar items={BUYER_TRUST} />
      </div>

      {/* A rail of what is closest, above the full grid.
          Only worth the space once there is enough behind it to scroll — with
          three events it would just be the grid again, rotated. */}
      {!loading && !error && events.length >= 4 && (
        <EventRail title="Happening soon" events={events.slice(0, 10)} />
      )}

      {/* One rail per category that has enough behind it to be worth scrolling.
          Three is the floor: with two, a rail is a grid of two rotated ninety
          degrees, and a section heading over almost nothing reads as a category
          that is failing rather than one that is starting. */}
      {!loading &&
        !error &&
        isBrowsing &&
        CATEGORY_ORDER.map((category) => {
          const inCategory = events.filter((e) => e.category === category);
          if (inCategory.length < 3) return null;

          return (
            <Section
              key={category}
              id={`category-${category}`}
              title={CATEGORY_LABELS[category]}
              action={{ to: '#whats-on', label: 'View all' }}
            >
              <EventRail
                title={CATEGORY_LABELS[category]}
                events={inCategory.slice(0, 10)}
                headed={false}
              />
            </Section>
          );
        })}

      {/* Discovery starts here. Headed and anchored so the section is navigable
          rather than being an unlabelled grid hanging off the bottom. */}
      <h2 id="whats-on" className="md-headline-medium mb-6 scroll-mt-20">
        What&rsquo;s on
      </h2>

      {loading && (
        <>
          <Skeleton className="mb-14 h-64 w-full rounded-md" />
          <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            <PosterSkeleton />
            <PosterSkeleton />
            <PosterSkeleton />
            <PosterSkeleton />
          </div>
        </>
      )}

      {!loading && error && (
        <ErrorState title="We could not load the events" body={error} onRetry={reload} />
      )}

      {!loading && !error && events.length === 0 && (
        <EmptyState
          title="Nothing on sale right now"
          body="No events are open for booking. New shows go up regularly — check back soon."
          action={
            <ButtonLink to="/account" variant="outlined">
              See my tickets
            </ButtonLink>
          }
        />
      )}

      {!loading && !error && events.length > 0 && (
        <>
          {featured && <FeaturedEvent event={featured} />}

          <EventFilters
            filters={filters}
            onChange={setFilters}
            resultCount={filtered.length}
          />

          {/* The empty state keys off `filtered`, not `rest`.
              Keying it off `rest` meant a single event was promoted into the
              featured card, leaving the grid empty, and the page then announced
              "No events match that" directly beneath the event it was
              displaying. Nothing matching is a statement about the filter, and
              the filter matched one. */}
          {filtered.length === 0 ? (
            <EmptyState
              title="No events match that"
              body="Try a different search, or widen the date range."
              action={
                <Button
                  variant="outlined"
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            /* Every matching event, including the featured one.
               It used to be sliced out on the grounds that showing it twice is
               redundant — but the spotlight is a recommendation and the grid is
               the catalogue, and something missing from the catalogue reads as
               unavailable. With a single event it also left the grid empty,
               which is how this surfaced. */
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
              {filtered.map((event, index) => (
                <EventPoster key={event.id} event={event} index={index} />
              ))}
            </div>
          )}
        </>
      )}

      <OrganiserBand />
    </div>
  );
}
