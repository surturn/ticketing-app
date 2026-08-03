/**
 * An event, as its poster.
 *
 * Promotion in this market runs on artwork: the poster is the product photo,
 * and the job of the card is to show it as large and as undamaged as possible
 * and then get out of the way. Everything the interface adds — date, price —
 * is set in the box-office face so it reads as printed onto the listing rather
 * than as part of the artwork.
 *
 * Two things the competition does not do, and both are cheap: state the price
 * before the buyer clicks, and keep every card the same height so the grid does
 * not comb.
 */
import { useState } from 'react';
import { Link, useViewTransitionState } from 'react-router-dom';
import { motion } from 'framer-motion';
import { prefetchEvent, type EventSummary } from '@/lib/api';
import { formatMoney } from '@/lib/format';

function posterDate(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-KE', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).formatToParts(new Date(iso));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday').toUpperCase(),
    day: get('day'),
    month: get('month').toUpperCase(),
    time: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Shown when there is no artwork, and when the artwork fails to load.
 *
 * Not a grey box: the fallback borrows the ticket's own language — punched
 * edge, box-office type — so a poster-less event reads as deliberate rather
 * than broken. It also means a dead image URL degrades to something presentable
 * instead of a browser's broken-image glyph.
 */
function PosterFallback({ event }: { event: EventSummary }) {
  return (
    <div className="absolute inset-0 flex flex-col justify-between bg-surface-container-high p-5">
      {/* Ticket-stub register, and correctly so: `ADMIT ONE` is printed
          language, not a heading. */}
      <span className="md-data-small tracking-[0.3em] text-on-surface-variant">
        ADMIT ONE
      </span>

      {/* The name is a title, so it stays in the display face — mono is spent
          only on facts the door will check, never on headings. Sized against
          the card's own width rather than the viewport's, so the fallback
          holds up in a narrow rail as well as in the grid. */}
      <span className="font-display text-[clamp(1.125rem,9cqi,1.75rem)] leading-[1.05] font-extrabold tracking-tight text-on-surface-variant">
        {event.name}
      </span>

      <span className="md-data-small tracking-[0.3em] text-on-surface-variant">
        {event.venue?.toUpperCase() ?? 'VENUE TBC'}
      </span>
    </div>
  );
}

export function EventPoster({
  event,
  index = 0,
}: {
  event: EventSummary;
  index?: number;
}) {
  const [artworkFailed, setArtworkFailed] = useState(false);
  const date = posterDate(event.startsAt, event.timezone);
  const showArtwork = Boolean(event.posterUrl) && !artworkFailed;

  /**
   * True only while *this* card's link is the one being navigated.
   *
   * The shared name has to be unique in the document at the moment the
   * transition is captured — if every card in the grid claimed `poster` at
   * once the browser would find duplicates and silently skip the animation
   * altogether. Naming it on the way out and nowhere else is what makes the
   * poster morph into the event header instead of the page cross-fading.
   */
  const to = `/events/${event.slug}`;
  const transitioning = useViewTransitionState(to);
  // Null price means nothing is left on sale — the card stays, dimmed and
  // badged, rather than disappearing. A show vanishing from the grid reads as
  // a bug to someone who was sent the link.
  const soldOut = event.fromPriceCents === null;
  const free = event.fromPriceCents === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.05, ease: 'easeOut' }}
      /* Cards below the fold skip layout and paint until they scroll close.
         The intrinsic size is the card's real height, so the scrollbar stays
         honest and nothing jumps as they come into range. */
      /* A container, so the card sizes its type against its own slot rather
         than the viewport — the same component then works in the grid, in a
         rail, and in the organiser's publish preview without a variant. */
      className="[container-type:inline-size] [content-visibility:auto] [contain-intrinsic-size:auto_420px]"
    >
      <Link
        to={to}
        viewTransition
        /* Tap-intent, not tap. Pointer-enter covers a mouse, touch-start covers
           a finger on the way down, and focus covers the keyboard — between
           them the payload is usually already arriving by the time the route
           mounts. Speculative and failure-tolerant: nothing here is on the
           critical path. */
        onPointerEnter={() => prefetchEvent(event.slug)}
        onTouchStart={() => prefetchEvent(event.slug)}
        onFocus={() => prefetchEvent(event.slug)}
        className="group block rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      >
        {/* Fixed 4:5 frame, the ratio posters are actually designed at. Every
            card is therefore the same height whatever it is given, which is
            what stops the grid from combing — and, because the box is sized
            before the image arrives, what keeps CLS at zero. */}
        <div
          style={transitioning ? { viewTransitionName: 'poster' } : undefined}
          className={`md-elevation-1 relative aspect-4/5 overflow-hidden rounded-md transition-shadow duration-(--dur-medium) ease-(--ease-standard) group-hover:md-elevation-2 ${
            soldOut ? 'opacity-60' : ''
          }`}
        >
          {showArtwork ? (
            <img
              src={event.posterUrl!}
              alt=""
              loading={index < 4 ? 'eager' : 'lazy'}
              decoding="async"
              onError={() => setArtworkFailed(true)}
              // Cover, so a poster of any ratio fills the frame rather than
              // letterboxing. Centre-weighted: poster titles sit high, so the
              // crop takes from the bottom.
              className="size-full object-cover object-top transition duration-500 group-hover:scale-[1.04]"
            />
          ) : (
            <PosterFallback event={event} />
          )}

          {/* Date, as a solid block of ink laid over the corner of the poster —
              the way a venue stamps a date onto printed artwork. Opaque on
              purpose: a translucent chip takes its legibility from whatever
              happens to be behind it, which on unpredictable promoter artwork
              is a guess. This one reads the same over every poster. */}
          <div className="absolute top-0 left-4 rounded-b-xs bg-surface-container-lowest/92 px-2.5 pt-2 pb-2 text-center">
            <p className="md-data-small leading-none text-primary">{date.weekday}</p>
            <p className="md-title-medium mt-1 leading-none tabular-nums">{date.day}</p>
            <p className="md-data-small mt-0.5 leading-none text-on-surface-variant">
              {date.month}
            </p>
          </div>

          {/* Colour never carries the meaning on its own — the dimmed poster is
              paired with a badge that says so in words. */}
          {soldOut && (
            <div className="absolute right-3 bottom-3 rounded-xs bg-surface-container-highest px-2 py-1">
              <span className="md-label-medium text-on-surface-variant">Sold out</span>
            </div>
          )}

          {/* Ring on approach, contained inside the frame so nothing shifts. */}
          <div
            className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-transparent transition duration-200 group-hover:ring-primary/60"
            aria-hidden="true"
          />
        </div>

        {/* Below the artwork, never on top of it — a promoter's poster is
            composed, and typesetting over it damages the thing being sold. */}
        <div className="px-0.5 pt-3">
          <h3 className="md-title-medium line-clamp-2 text-on-surface transition-colors group-hover:text-primary">
            {event.name}
          </h3>

          <p className="md-data-small mt-1.5 truncate text-on-surface-variant">
            {date.time}
            {event.venue && ` · ${event.venue.toUpperCase()}`}
          </p>

          <p className="md-data-medium mt-2">
            {soldOut ? (
              <span className="text-on-surface-variant">Sold out</span>
            ) : free ? (
              <span className="font-medium text-tertiary">Free</span>
            ) : (
              <>
                <span className="text-on-surface-variant">From </span>
                <span className="font-medium text-on-surface">
                  {formatMoney(event.fromPriceCents!, event.currency)}
                </span>
              </>
            )}
          </p>
        </div>
      </Link>
    </motion.div>
  );
}
