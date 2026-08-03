/**
 * The event page's opening: a photograph, with the poster resting on its edge.
 *
 * This inverts what the page used to do. The poster was the header — set beside
 * the title in a bordered box — and the brand is explicit that this is
 * backwards: the hero represents the *event*, the poster represents the
 * *branding*, and the hero always receives greater emphasis. A buyer deciding
 * whether to go should see the room before they see the flyer.
 *
 * The poster is not discarded. It overlaps the hero's lower edge, which is what
 * "floating" means here — it belongs to the photograph rather than sitting in a
 * panel below it, and it keeps the view-transition name so the card-to-page
 * morph from the listing still lands on it.
 */
import type { EventDetail } from '@/lib/api';
import { CATEGORY_LABELS, heroFor } from '@/lib/eventImages';
import { formatEventDate, formatMoney } from '@/lib/format';
import { Hero } from './Hero';

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
          <div className="mx-auto w-full max-w-6xl sm:pr-56 lg:pr-72">
            {event.category && (
              <span className="md-eyebrow inline-flex rounded-xs bg-white/15 px-2.5 py-1 text-white">
                {CATEGORY_LABELS[event.category]}
              </span>
            )}

            <h1 className="md-display-medium mt-4 max-w-3xl text-white">{event.name}</h1>

            <div className="md-data-medium mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-white/85">
              <span>{formatEventDate(event.startsAt, event.timezone)}</span>
              {event.venue && <span className="truncate">{event.venue}</span>}
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

      {/* The floating poster. Desktop only: at phone width it would either
          cover the title or shrink to a thumbnail that sells nothing while
          costing the full download. It isn't lost on mobile — EventPage
          renders the same poster, unclipped and view-transition-free, inside
          the "About this event" section below the hero. */}
      {posterVisible && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden sm:block">
          <div className="mx-auto flex max-w-6xl justify-end px-6">
            <img
              src={event.posterUrl!}
              alt={`Poster for ${event.name}`}
              onError={onPosterError}
              /* The receiving half of the card → page morph. The grid card
                 claims the same name on its way out, so the browser treats the
                 two as one object opening rather than two pages swapping. */
              style={{ viewTransitionName: 'poster' }}
              className="md-elevation-float aspect-4/5 w-40 translate-y-12 rounded-md object-cover lg:w-52"
            />
          </div>
        </div>
      )}
    </div>
  );
}
