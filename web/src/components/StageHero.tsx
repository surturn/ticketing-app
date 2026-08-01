/**
 * The masthead, as a lit stage — pointed at organisers.
 *
 * Nobody browses a ticketing homepage in this market. Discovery happens in
 * Instagram stories and WhatsApp groups, and a buyer arrives on an event page
 * from a link somebody posted. So the homepage is not a shop window: it is a
 * landing page for the person deciding where to list, and its job is to answer
 * "will you sell my tickets and pay me quickly". Discovery sits below it.
 *
 * Everything else on this page belongs to the promoters — their posters, their
 * copy. This is the one piece of artwork the product draws itself, so it is
 * drawn from the subject rather than from a gradient generator: light beams
 * falling from above, a row of marquee bulbs along the header edge, and a
 * ticker of what is actually on.
 *
 * All of it is SVG and CSS. There is no image to request, it resizes to any
 * width without a second asset, and it costs about a kilobyte.
 */
import { useMemo } from 'react';
import type { EventSummary } from '@/lib/api';

/**
 * Beams from the lighting rig.
 *
 * Trapezoids rather than cones — a par can throws a hard-edged shaft, and the
 * softness comes from the blur behind it, not from the shape. Angles are
 * deliberately uneven: a rig aimed in perfect symmetry reads as wallpaper.
 */
function StageLights() {
  return (
    <svg
      className="absolute inset-x-0 top-0 h-full w-full"
      viewBox="0 0 1200 420"
      preserveAspectRatio="xMidYMin slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="beam-cool" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--blue-60)' }} stopOpacity="0.5" />
          <stop offset="55%" style={{ stopColor: 'var(--blue-50)' }} stopOpacity="0.14" />
          <stop offset="100%" style={{ stopColor: 'var(--blue-50)' }} stopOpacity="0" />
        </linearGradient>
        {/* The house light. Neutral rather than pure white so it stays a beam
            in light mode instead of vanishing into the page. */}
        <linearGradient id="beam-white" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--neutral-99)' }} stopOpacity="0.42" />
          <stop offset="60%" style={{ stopColor: 'var(--neutral-99)' }} stopOpacity="0.08" />
          <stop offset="100%" style={{ stopColor: 'var(--neutral-99)' }} stopOpacity="0" />
        </linearGradient>
        {/* A tungsten wash.
            Real rigs are not lit in a single colour temperature — a cool key
            against a warm fill is what stops a stage reading as flat, and it is
            why a photograph of an all-blue stage looks like a screensaver.
            Decorative, so it carries no meaning and costs nothing: gold means
            "organiser" where it labels something, and this labels nothing. */}
        <linearGradient id="beam-warm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--gold-70)' }} stopOpacity="0.32" />
          <stop offset="55%" style={{ stopColor: 'var(--gold-80)' }} stopOpacity="0.10" />
          <stop offset="100%" style={{ stopColor: 'var(--gold-80)' }} stopOpacity="0" />
        </linearGradient>
        <filter id="haze" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
      </defs>

      {/* Warm on the left, cool through the middle, warm again at the right
          edge — uneven on purpose. A rig aimed in perfect symmetry reads as
          wallpaper, and matched colour temperatures read as a gradient. */}
      <g filter="url(#haze)">
        <polygon points="150,-40 230,-40 470,430 30,430" fill="url(#beam-warm)" />
        <polygon points="600,-40 660,-40 810,430 470,430" fill="url(#beam-white)" />
        <polygon points="980,-40 1060,-40 1190,430 830,430" fill="url(#beam-cool)" />
        <polygon points="1120,-40 1170,-40 1280,430 1040,430" fill="url(#beam-warm)" />
      </g>
    </svg>
  );
}

/**
 * The bulb strip along the top edge, as on a theatre marquee.
 *
 * Spacing is fixed in pixels and the row simply clips at the viewport edge —
 * a real marquee is built to the frontage and does not redistribute its bulbs
 * to fit, and evenly-spaced-to-fill would have made it read as a progress bar.
 */
function MarqueeBulbs() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 flex gap-6 overflow-hidden px-2"
      aria-hidden="true"
    >
      {Array.from({ length: 60 }).map((_, index) => {
        // Every fourth bulb is tungsten. A marquee strip is incandescent, not
        // LED, and a run of identical cool bulbs is the one detail that gives
        // away a drawing of one. Purely decorative, so the warm tone carries no
        // organiser meaning here.
        const warm = index % 4 === 1;
        const tone = warm ? 'var(--gold-70)' : 'var(--blue-60)';
        return (
          <span
            key={index}
            className="mt-[-4px] size-[7px] shrink-0 rounded-full"
            style={{
              backgroundColor: `color-mix(in srgb, ${tone} 70%, transparent)`,
              boxShadow: `0 0 8px 2px color-mix(in srgb, ${tone} 45%, transparent)`,
              // Every third is dimmer. Real strips have dead bulbs, and the
              // irregularity is what stops this reading as a dotted border.
              opacity: index % 3 === 0 ? 0.35 : 0.9,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * A ticker of what is on.
 *
 * Real content, not decoration: it names the events the page is already
 * showing. On an organiser landing page it is also the proof — these are shows
 * already selling here. Duplicated once so the loop has something to scroll
 * into, with the copy hidden from assistive technology so the list is not
 * announced twice.
 */
function Ticker({ events }: { events: EventSummary[] }) {
  const line = useMemo(() => {
    const names = events.slice(0, 8).map((event) => event.name.toUpperCase());
    return names.length > 0 ? names : ['TICKETS ON SALE NOW'];
  }, [events]);

  /**
   * How many copies of the list to lay end to end.
   *
   * The loop works by translating the strip left by half its own width and
   * starting over, which is seamless only while the strip is at least twice the
   * viewport wide. Two events make a short line, so two copies of it do not
   * span the screen and the strip visibly empties before it snaps back.
   *
   * Estimating from the character count rather than measuring: a measured
   * version needs a layout read on mount and a resize observer to stay correct,
   * and this only has to be generous, not exact. Over-repeating costs a few
   * spans of text.
   */
  const copies = useMemo(() => {
    const characters = line.join('').length + line.length * 6;
    // ~11px per character at this size and tracking, against the widest phone
    // and desktop we care about. Doubled so the -50% translation always has a
    // full screen of content behind it, then clamped to something sane.
    const estimatedWidth = characters * 11;
    const needed = Math.ceil(2400 / Math.max(estimatedWidth, 1)) * 2;
    return Math.min(Math.max(needed, 2), 12);
  }, [line]);

  const Run = ({ hidden }: { hidden?: boolean }) => (
    <span
      className="flex shrink-0 items-center gap-8 pr-8"
      aria-hidden={hidden || undefined}
    >
      {line.map((name, index) => (
        <span key={`${name}-${index}`} className="flex items-center gap-8">
          {/* Body font, not mono: an event name is a title, not a fact the
              door will check. The wide tracking carries the ticker-tape read
              on its own. */}
          <span className="md-label-medium tracking-[0.25em] text-on-surface-variant">
            {name}
          </span>
          {/* Tungsten, matching the bulbs above it — the separator belongs to
              the marquee rather than to the interface. */}
          <span className="text-tertiary" aria-hidden="true">
            ●
          </span>
        </span>
      ))}
    </span>
  );

  return (
    <div className="relative flex overflow-hidden border-y border-outline-variant/70 py-2.5">
      {/* An even number of copies, half of which the -50% translation consumes.
          Only the first is announced; the rest are the same names again and
          would otherwise be read out repeatedly. */}
      <div className="ticker flex">
        {Array.from({ length: copies }).map((_, index) => (
          <Run key={index} hidden={index > 0} />
        ))}
      </div>

      {/* Faded ends, so the text arrives and leaves rather than being cut off
          mid-letter against the edge. */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-surface to-transparent"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-surface to-transparent"
        aria-hidden="true"
      />
    </div>
  );
}

export function StageHero({ events }: { events: EventSummary[] }) {
  return (
    <section className="relative -mx-4 mb-10 overflow-hidden sm:-mx-6">
      <MarqueeBulbs />
      <StageLights />

      {/* Capped so the first real module clears the fold on a phone. `dvh`,
          not `vh`: with `vh` the hero is sized against the viewport *without*
          browser chrome, so it overshoots by the height of the address bar
          until the user scrolls and it collapses. */}
      <div className="relative flex max-h-[60dvh] flex-col justify-center px-4 pt-10 pb-8 sm:px-6 sm:pt-14 sm:pb-10">
        {/* Blue, and consumer-facing. The landing page belongs to the person
            looking for something to go to; the organiser pitch has its own
            route. */}
        <p className="md-eyebrow text-primary">Nairobi</p>

        <h1 className="md-display-large mt-3 max-w-3xl">
          Every night out
          <br />
          starts here
        </h1>

        <p className="md-body-large mt-5 max-w-md text-on-surface-variant">
          Pay with M-Pesa. Your ticket arrives by email and scans at the door.
        </p>
      </div>

      <Ticker events={events} />
    </section>
  );
}
