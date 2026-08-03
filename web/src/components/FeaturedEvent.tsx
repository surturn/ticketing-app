/**
 * The spotlight: one event, given the room to sell itself.
 *
 * A grid where every event carries identical weight makes the buyer do all the
 * work of choosing. The next event on sale gets the top of the page instead.
 *
 * Ink and paper, not glass: a solid panel, a hairline border, paper grain and
 * one rule of colour down the leading edge. The poster is shown crisp and
 * whole rather than blurred into a backdrop — it is the promoter's work and the
 * thing being sold, so damaging it to make a texture would be the wrong trade.
 */
import { useState } from 'react';
import type { EventSummary } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { ButtonLink } from './ui';

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
    <section className="relative mb-14 overflow-hidden rounded-lg border border-primary/25 bg-surface-container">

      {/* A wash of the primary across the panel — dark mode only. On white the
          same gradient lands within a few percent of the page behind it, so it
          reads as a printing fault rather than a spotlight; there the container
          step and the left rule carry the separation on their own. */}
      <div
        className="pointer-events-none absolute inset-0 hidden bg-gradient-to-br from-primary/18 via-primary/5 to-transparent dark:block"
        aria-hidden="true"
      />

      {/* A rule of ink down the leading edge, the way a printed bill is trimmed.
          This is the whole decorative budget for the section — the poster and
          the type do the rest. */}
      <div className="absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden="true" />

      <div className="relative grid items-center gap-8 p-6 sm:p-10 lg:grid-cols-[1fr_auto] lg:gap-12">
        <div className="min-w-0">
          <p className="md-eyebrow text-primary">Next up</p>

          <h2 className="md-display-small mt-3">{event.name}</h2>

          <div className="md-data-medium mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-on-surface-variant">
            <span>{longDate(event.startsAt, event.timezone)}</span>
            <span className="text-on-surface-variant" aria-hidden="true">
              ·
            </span>
            <span className="tabular-nums">{time(event.startsAt, event.timezone)}</span>
            {event.venue && (
              <>
                <span className="text-on-surface-variant" aria-hidden="true">
                  ·
                </span>
                <span className="truncate">{event.venue}</span>
              </>
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

        {/* The poster, at the size a poster deserves. Full width and first in
            the stack below `lg`, so it reads as a hero the way a promoter's
            artwork should — a 90px thumbnail sells nothing, but a phone-width
            one does the same job the grid card does. Fixed and second beside
            the text once there is room for both side by side. */}
        {showArtwork && (
          <div className="order-first lg:order-none">
            <img
              src={event.posterUrl!}
              alt={`Poster for ${event.name}`}
              onError={() => setArtworkFailed(true)}
              className="aspect-4/5 w-full border border-primary/30 object-cover object-top shadow-2xl shadow-primary/10 lg:w-56"
            />
          </div>
        )}
      </div>
    </section>
  );
}
