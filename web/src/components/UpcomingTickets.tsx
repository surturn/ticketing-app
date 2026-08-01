/**
 * What the signed-in buyer already holds, at the top of their own home.
 *
 * Only events still to come, and only paid ones. A ticket to something that has
 * already happened is a receipt, not a plan, and belongs on the account page
 * with the rest of the history — leading the homepage with it would push the
 * thing they actually need today below a list of things they have already done.
 *
 * The order payload carries an `eventId` but no event name, so the name and
 * date are joined client-side against the listing the page has already fetched.
 * That join is also the filter: an event missing from the public listing has
 * been archived or unpublished, which is precisely the set that should not
 * appear under "coming up".
 */
import { Link } from 'react-router-dom';
import type { AccountOrder, EventSummary } from '@/lib/api';

function dayAndTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(iso));
}

export interface UpcomingTicket {
  order: AccountOrder;
  event: EventSummary;
}

/** Pairs paid orders with their event, keeping only what is still ahead. */
export function selectUpcoming(
  orders: AccountOrder[],
  events: EventSummary[],
  now = Date.now(),
): UpcomingTicket[] {
  const byId = new Map(events.map((event) => [event.id, event]));

  return orders
    .filter((order) => order.status === 'paid')
    .map((order) => ({ order, event: byId.get(order.eventId) }))
    .filter((pair): pair is UpcomingTicket => pair.event !== undefined)
    .filter((pair) => new Date(pair.event.startsAt).getTime() > now)
    .sort(
      (a, b) =>
        new Date(a.event.startsAt).getTime() - new Date(b.event.startsAt).getTime(),
    );
}

export function UpcomingTickets({
  tickets,
  name,
}: {
  tickets: UpcomingTicket[];
  name?: string | null;
}) {
  const greeting = name ? `Welcome back, ${name}` : 'Welcome back';

  if (tickets.length === 0) {
    return (
      <section className="mb-12">
        <h1 className="md-headline-large">{greeting}</h1>
        <p className="md-body-large mt-2 max-w-md text-on-surface-variant">
          You have no upcoming tickets. Here is what is on.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-12" aria-labelledby="upcoming-heading">
      <h1 className="md-headline-large">{greeting}</h1>

      <h2 id="upcoming-heading" className="md-eyebrow mt-6 text-primary">
        {tickets.length === 1 ? 'Your next event' : 'Coming up'}
      </h2>

      {/* Capped at three. This is a reminder of what is next, not an archive;
          the account page is where the full list lives. */}
      <ul className="mt-3 space-y-3">
        {tickets.slice(0, 3).map(({ order, event }) => (
          <li key={order.reference}>
            <Link
              to={`/orders/${order.reference}`}
              /* The leading rule marks this as the featured, personal item —
                 the same device the "Next up" card uses. */
              className="md-state group relative flex items-center gap-4 overflow-hidden rounded-md border border-primary/25 bg-surface-container p-4 transition-colors"
            >
              <span className="md-state-layer" aria-hidden="true" />
              <span
                className="absolute inset-y-0 left-0 w-[3px] bg-primary"
                aria-hidden="true"
              />

              {event.posterUrl && (
                <img
                  src={event.posterUrl}
                  alt=""
                  loading="lazy"
                  className="relative aspect-4/5 w-12 shrink-0 rounded-xs object-cover object-top"
                />
              )}

              <span className="relative min-w-0 flex-1">
                <span className="md-title-medium block truncate text-on-surface">
                  {event.name}
                </span>
                <span className="md-data-small mt-0.5 block truncate text-on-surface-variant">
                  {dayAndTime(event.startsAt, event.timezone)}
                  {event.venue && ` · ${event.venue}`}
                </span>
              </span>

              <span className="md-label-large relative shrink-0 text-primary">
                View ticket
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {tickets.length > 3 && (
        <Link
          to="/account"
          className="md-label-large mt-3 inline-block text-primary"
        >
          All {tickets.length} tickets
        </Link>
      )}
    </section>
  );
}
