/**
 * The spotlight: one event, given the room to sell itself.
 *
 * A grid where every event carries identical weight makes the buyer do all the
 * work of choosing. The next event on sale gets the top of the page instead.
 *
 * The poster leads the DOM and sits on its own surface with soft elevation —
 * per §Cards, cards float, they don't sink, so there is no border and no
 * gradient wash doing the separating for it. The artwork is shown crisp and
 * whole rather than blurred into a backdrop — it is the promoter's work and the
 * thing being sold, so damaging it to make a texture would be the wrong trade.
 */
import { useState } from 'react';
import type { EventSummary } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { CATEGORY_LABELS } from '@/lib/eventImages';
import { ButtonLink } from './ui';
import { ShareButton } from './ShareSheet';

function CalendarIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 8.5h14M7 3v3M13 3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6v4l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M10 18s6-5 6-9a6 6 0 1 0-12 0c0 4 6 9 6 9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="9" r="2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function longDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(new Date(iso));
}

function time(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(iso));
}

export function FeaturedEvent({ event }: { event: EventSummary }) {
  const [artworkFailed, setArtworkFailed] = useState(false);
  const showArtwork = Boolean(event.posterUrl) && !artworkFailed;

  return (
    <section className="relative mb-(--space-section-sm) overflow-hidden rounded-lg bg-surface-container-lowest md-elevation-1 sm:mb-(--space-section)">
      {/* The second column only exists when there is a poster to put in it —
          a grid that keeps a 320px track for a child that never renders is
          how an artwork-less event ends up with its text crushed into a third
          of the card and the rest of it blank. */}
      <div
        className={`relative grid gap-0 ${showArtwork ? 'sm:grid-cols-[minmax(0,320px)_1fr]' : ''}`}
      >
        {showArtwork && (
          <div className="relative aspect-4/5 w-full overflow-hidden sm:aspect-auto">
            <img
              src={event.posterUrl!}
              alt={`Poster for ${event.name}`}
              onError={() => setArtworkFailed(true)}
              loading="lazy"
              decoding="async"
              className="size-full object-cover object-top"
            />
          </div>
        )}

        <div className="min-w-0 p-6 sm:p-10">
          <div className="flex items-start justify-between gap-3">
            <span className="md-label-small inline-flex rounded-xs bg-primary-container px-2.5 py-1 text-on-primary-container uppercase">
              {event.category ? CATEGORY_LABELS[event.category] : 'Next up'}
            </span>
            <ShareButton event={event} className="-mt-1 -mr-1 size-8 shrink-0" />
          </div>

          <h2 className="md-display-small mt-3">{event.name}</h2>

          <div className="md-data-medium mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-on-surface-variant">
            <span className="flex items-center gap-1.5">
              <CalendarIcon />
              {longDate(event.startsAt, event.timezone)}
            </span>
            <span className="flex items-center gap-1.5 tabular-nums">
              <ClockIcon />
              {time(event.startsAt, event.timezone)}
            </span>
            {event.venue && (
              <span className="flex min-w-0 items-center gap-1.5">
                <PinIcon />
                <span className="truncate">{event.venue}</span>
              </span>
            )}
          </div>

          {event.description && (
            // Clamped. The promoter's full pitch belongs on the event page; a
            // hero that scrolls is a hero nobody finishes reading.
            <p className="md-body-large mt-5 line-clamp-3 max-w-xl text-on-surface-variant">
              {event.description}
            </p>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-4">
            <ButtonLink to={`/events/${event.slug}`} viewTransition>
              Get tickets
            </ButtonLink>

            {event.fromPriceCents !== null && (
              <span className="md-data-medium">
                <span className="text-on-surface-variant">From </span>
                <span className="font-medium text-on-surface">
                  {formatMoney(event.fromPriceCents, event.currency)}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
