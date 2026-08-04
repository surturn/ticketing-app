/**
 * The event page's opening: a photograph, with the poster resting on it.
 *
 * This inverts what the page used to do. The poster was the header — set beside
 * the title in a bordered box — and the brand is explicit that this is
 * backwards: the hero represents the *event*, the poster represents the
 * *branding*, and the hero always receives greater emphasis. A buyer deciding
 * whether to go should see the room before they see the flyer.
 *
 * The poster is not discarded. It sits inside the photograph's own frame,
 * vertically centred and pinned to the trailing edge, and it keeps the
 * view-transition name so the card-to-page morph from the listing still lands
 * on it.
 */
import type { EventDetail } from '@/lib/api';
import { CATEGORY_LABELS, heroFor } from '@/lib/eventImages';
import { formatMoney } from '@/lib/format';
import { Hero } from './Hero';

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

/** `Fri, 2 Oct 2026`, in the event's own time zone. */
function datePart(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(iso));
}

/** `2:00 PM`, or `2:00 PM – 8:00 PM` when the event states an end time. */
function timePart(startsAt: string, endsAt: string | null, timezone: string): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-KE', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    }).format(new Date(iso));

  return endsAt ? `${fmt(startsAt)} – ${fmt(endsAt)}` : fmt(startsAt);
}

export function EventHero({
  event,
  posterVisible,
  onPosterError,
}: {
  event: EventDetail;
  posterVisible: boolean;
  onPosterError: () => void;
}) {
  const hero = heroFor(event);
  // Server-computed, not re-derived here. "Cheapest ticket currently on sale"
  // sounds like a simple filter over tiers, but a tier can be `onSale: true`
  // and not `soldOut` while still being closed by the organiser — the API is
  // the one place that already accounts for every reason a tier isn't
  // purchasable, and a second, client-side definition of "available" would
  // drift from it the next time a new reason gets added there.
  const fromPrice = event.fromPriceCents;

  return (
    <div className="relative -mx-4 mb-10 sm:-mx-6">
      <Hero src={hero.src} alt="" eager blurred={hero.blurred}>
        <div className="flex min-h-[52dvh] flex-col justify-end px-4 pt-24 pb-10 sm:min-h-[58dvh] sm:px-6 sm:pb-12">
          {/* Room on the right for the poster, so a long title never runs
              underneath it. */}
          <div className="mx-auto w-full max-w-[1440px] sm:pr-56 lg:pr-72">
            {event.category && (
              <span className="md-eyebrow inline-flex rounded-xs bg-[var(--blue-10)]/70 px-2.5 py-1 text-white">
                {CATEGORY_LABELS[event.category]}
              </span>
            )}

            <h1 className="md-display-medium mt-4 max-w-3xl text-white">{event.name}</h1>

            <div className="md-data-medium mt-5 flex flex-col gap-2 text-white/85">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                <span className="flex items-center gap-1.5">
                  <CalendarIcon />
                  {datePart(event.startsAt, event.timezone)}
                </span>
                <span className="flex items-center gap-1.5">
                  <ClockIcon />
                  {timePart(event.startsAt, event.endsAt, event.timezone)}
                </span>
              </div>

              {event.venue && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <PinIcon />
                  <span className="truncate">{event.venue}</span>
                </span>
              )}
            </div>

            {fromPrice !== null && (
              <p className="md-data-large mt-4 text-white">
                <span className="text-white/70">From </span>
                {formatMoney(fromPrice, event.currency)}
              </p>
            )}
          </div>
        </div>
      </Hero>

      {/* The poster, inside the photograph's own frame — vertically centred
          and pinned to the trailing edge rather than overhanging the bottom.
          A sibling of `Hero`, not a child of it: `Hero` wraps its children in
          a content-height div, and this needs to size against the *whole*
          photograph, which only the outer wrapper (matched to `Hero`'s own
          height) actually spans.

          Desktop only: at phone width it would either cover the title or
          shrink to a thumbnail that sells nothing while costing the full
          download. It isn't lost on mobile — EventPage renders the same
          poster, unclipped and view-transition-free, inside the "About this
          event" section below the hero. */}
      {posterVisible && (
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden items-center pr-4 sm:flex sm:pr-6 lg:pr-10">
          <img
            src={event.posterUrl!}
            alt={`Poster for ${event.name}`}
            onError={onPosterError}
            /* The receiving half of the card → page morph. The grid card
               claims the same name on its way out, so the browser treats the
               two as one object opening rather than two pages swapping. */
            style={{ viewTransitionName: 'poster' }}
            className="md-elevation-float aspect-4/5 w-40 rounded-md object-cover lg:w-52"
          />
        </div>
      )}
    </div>
  );
}
