/**
 * A horizontally-scrolling rail of posters.
 *
 * The grid below answers "what is on"; this answers "what is on *soon*", which
 * is the question someone deciding what to do this week is actually asking. It
 * earns its place by being scannable in one gesture rather than a scroll —
 * which is also why it is a rail and not a second grid.
 *
 * Native scroll with snap points, no carousel library and no autoplay. A rail
 * that moves on its own fights the reader, and a JavaScript carousel on a
 * mid-range Android costs more than the whole rest of this page.
 */
import { Link, useViewTransitionState } from 'react-router-dom';
import { prefetchEvent, type EventSummary } from '@/lib/api';
import { formatMoney } from '@/lib/format';

function railDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(new Date(iso));
}

function RailCard({ event }: { event: EventSummary }) {
  const to = `/events/${event.slug}`;
  const transitioning = useViewTransitionState(to);
  const soldOut = event.fromPriceCents === null;

  return (
    <li
      /* Each card is a snap target, so a flick lands on a card rather than
         halfway between two. */
      className="w-40 shrink-0 snap-start sm:w-44"
    >
      <Link
        to={to}
        viewTransition
        onPointerEnter={() => prefetchEvent(event.slug)}
        onTouchStart={() => prefetchEvent(event.slug)}
        onFocus={() => prefetchEvent(event.slug)}
        className="group block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      >
        <div
          style={transitioning ? { viewTransitionName: 'poster' } : undefined}
          className={`md-elevation-1 relative aspect-4/5 overflow-hidden rounded-md transition-shadow duration-(--dur-medium) ${
            soldOut ? 'opacity-60' : ''
          }`}
        >
          {event.posterUrl ? (
            <img
              src={event.posterUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover object-top"
            />
          ) : (
            <div className="flex size-full items-end bg-surface-container-high p-3">
              <span className="font-display text-base leading-tight font-extrabold text-on-surface-variant">
                {event.name}
              </span>
            </div>
          )}

          {soldOut && (
            <span className="md-label-medium absolute right-2 bottom-2 rounded-xs bg-surface-container-highest px-2 py-0.5 text-on-surface-variant">
              Sold out
            </span>
          )}
        </div>

        <p className="md-title-medium mt-2 line-clamp-2 text-on-surface transition-colors group-hover:text-primary">
          {event.name}
        </p>
        <p className="md-data-small mt-1 truncate text-on-surface-variant">
          {railDate(event.startsAt, event.timezone)}
          {event.fromPriceCents !== null &&
            event.fromPriceCents > 0 &&
            ` · ${formatMoney(event.fromPriceCents, event.currency)}`}
        </p>
      </Link>
    </li>
  );
}

export function EventRail({
  title,
  events,
  headed = true,
}: {
  title: string;
  events: EventSummary[];
  /** False when the rail sits inside a `Section` that already titles it. */
  headed?: boolean;
}) {
  if (events.length === 0) return null;

  // Derived from the title rather than hardcoded: with one rail per category
  // now possible on the same page, a fixed "rail-heading" id would collide
  // across every rail after the first, which is invalid HTML and leaves the
  // accessible name pointing at whichever heading happened to render last.
  const headingId = `rail-${title.toLowerCase().replace(/\W+/g, '-')}`;

  return (
    <section className="mb-12" aria-labelledby={headed ? headingId : undefined}>
      {/* Gold rule and eyebrow. This rail is a curated pick rather than the
          full listing, and warmth is how that reads as a recommendation
          instead of another grid — the same "worth your attention" register
          gold already carries on a VIP tier or a nearly-sold-out show. */}
      {headed && (
        <div className="mb-4 flex items-center gap-3">
          <span className="h-5 w-[3px] shrink-0 bg-tertiary" aria-hidden="true" />
          <h2 id={headingId} className="md-title-large">
            {title}
          </h2>
        </div>
      )}

      {/* Bleeds to the viewport edge so the last card is visibly cut off rather
          than ending flush with the margin — the clipped card is what tells a
          reader there is more to the right, without a scrollbar or an arrow. */}
      <ul className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
        {events.map((event) => (
          <RailCard key={event.id} event={event} />
        ))}
      </ul>
    </section>
  );
}
