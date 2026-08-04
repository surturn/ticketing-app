import { useMemo } from 'react';
import type { EventSummary } from '@/lib/api';

/**
 * A ticker of what is on.
 *
 * Real content, not decoration: it names the events the page is already
 * showing. On an organiser landing page it is also the proof — these are shows
 * already selling here. Duplicated once so the loop has something to scroll
 * into, with the copy hidden from assistive technology so the list is not
 * announced twice.
 */
export function Ticker({ events }: { events: EventSummary[] }) {
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
