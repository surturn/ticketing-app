/**
 * The masthead, as a photograph.
 *
 * This replaces a drawn SVG of a lit stage. The drawing was careful work and
 * cost about a kilobyte, but §Photography is unambiguous: heroes are real event
 * photography, never illustrations or vector graphics, because the job of this
 * band is to make someone want to be in the room — and a diagram of a room does
 * not do that.
 *
 * The search sits inside the hero rather than below it. It is the most
 * important interaction on the page and §Search rules out hiding it; putting it
 * over the photograph also means the first thing a visitor sees is a picture of
 * a night out with a box asking which one they want.
 */
import type { EventSummary } from '@/lib/api';
import { DEFAULT_HERO } from '@/lib/eventImages';
import { Hero } from './Hero';
import { SearchField } from './SearchField';
import { Ticker } from './Ticker';
import { TrustBar, BUYER_TRUST } from './TrustBar';

export function HomeHero({
  events,
  query,
  onQueryChange,
}: {
  events: EventSummary[];
  query: string;
  onQueryChange: (next: string) => void;
}) {
  return (
    <div className="-mx-4 -mt-8 sm:-mx-6 sm:-mt-12">
      <Hero src={DEFAULT_HERO} alt="" eager>
        {/* `dvh`, not `vh`: with `vh` the hero is sized against the viewport
            *without* browser chrome, so it overshoots by the height of the
            address bar until the user scrolls and it collapses. */}
        <div className="flex min-h-[68dvh] flex-col justify-end px-4 pt-24 pb-10 sm:px-6 sm:pb-14 lg:min-h-[72dvh]">
          <div className="mx-auto w-full max-w-[1440px]">
            {/* White on the scrim, not a token role. This is the one place type
                sits over a photograph rather than over a surface, so it cannot
                take its colour from the theme — the scrim is what guarantees
                contrast, and it is dark in both themes. */}
            <p className="md-eyebrow text-[var(--blue-70)]">Nairobi</p>

            <h1 className="md-display-large mt-3 max-w-3xl text-white">
              Every night out
              <br />
              starts here
            </h1>

            <p className="md-body-large mt-5 max-w-md text-white/85">
              Discover concerts, festivals, comedy shows and experiences across
              Kenya.
            </p>

            <SearchField
              value={query}
              onChange={onQueryChange}
              className="mt-8 max-w-xl"
            />

            <div className="mt-8">
              <TrustBar items={BUYER_TRUST} variant="hero" />
            </div>
          </div>
        </div>
      </Hero>

      <Ticker events={events} />
    </div>
  );
}
