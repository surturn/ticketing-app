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
    <section className="relative mb-(--space-section-sm) overflow-hidden rounded-lg bg-surface-container-lowest md-elevation-1 sm:mb-(--space-section)">
      <div className="relative grid gap-0 sm:grid-cols-[minmax(0,320px)_1fr]">
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
      </div>
    </section>
  );
}
