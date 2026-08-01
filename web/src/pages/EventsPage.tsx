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
import { OrganiserPitch } from '@/components/OrganiserPitch';
import { StageHero } from '@/components/StageHero';
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
  const isBrowsing =
    filters.query.trim() === '' && filters.window === 'any' && filters.sort === 'soonest';
  const featured = isBrowsing ? filtered[0] : undefined;
  const rest = featured ? filtered.slice(1) : filtered;

  return (
    <div>
      {/* Two homepages, one route.
          A signed-out visitor who typed the domain is usually deciding where to
          list, so they get the pitch. A signed-in buyer is not — they already
          chose. Leading their own home with a sales page aimed at somebody else
          is what made going back from the account feel like leaving. */}
      {signedIn ? (
        <UpcomingTickets
          tickets={upcoming}
          name={
            (session?.user.displayName ?? user?.displayName)?.split(' ')[0] ?? null
          }
        />
      ) : (
        <>
          <StageHero events={events} />
          <OrganiserPitch />
        </>
      )}

      {/* Discovery starts here. Headed and anchored so the hero's "See what's
          on" has somewhere to land, and so the section is navigable rather than
          being an unlabelled grid hanging off the bottom of a pitch. */}
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

          {rest.length === 0 ? (
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
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
              {rest.map((event, index) => (
                <EventPoster key={event.id} event={event} index={index} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
