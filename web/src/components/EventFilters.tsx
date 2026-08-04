/**
 * Search, date and sort — applied as you type.
 *
 * Filtering happens in the browser over the already-loaded listing, so there is
 * no Apply button and no round-trip: results narrow on each keystroke. That is
 * the right trade while a city's worth of events fits in one response; if the
 * listing ever outgrows that, this moves server-side behind the same props.
 *
 * The category control filters on the event's own category. Events created
 * before categories existed have none, and are reachable through every other
 * control rather than being hidden behind a chip they can never match.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { EventCategory, EventSummary } from '@/lib/api';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/eventImages';

export type DateWindow = 'any' | 'weekend' | 'month';
export type SortOrder = 'soonest' | 'cheapest';

export interface FilterState {
  query: string;
  window: DateWindow;
  sort: SortOrder;
  /**
   * A specific day, as `YYYY-MM-DD`, or empty for none.
   *
   * Held as the calendar's own string rather than a Date. Parsing it to a Date
   * here would anchor it to the browser's zone, and "Saturday" to someone
   * picking a date means the day as written, not an instant that shifts by a
   * few hours depending on where they are standing.
   */
  onDate: string;
  /** null means every category. */
  category: EventCategory | null;
}

export const DEFAULT_FILTERS: FilterState = {
  query: '',
  window: 'any',
  sort: 'soonest',
  onDate: '',
  category: null,
};

/** The event's calendar day *in its own time zone*, as `YYYY-MM-DD`. */
function eventDay(event: EventSummary): string {
  // `en-CA` formats as YYYY-MM-DD, which is the same shape the date input uses
  // — so the comparison is a string equality rather than date arithmetic.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: event.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(event.startsAt));
}

/** Saturday and Sunday of the current week, in local time. */
function weekendBounds(now = new Date()): [Date, Date] {
  const saturday = new Date(now);
  // 6 = Saturday. If today is already the weekend, the window starts now.
  const untilSaturday = (6 - saturday.getDay() + 7) % 7;
  saturday.setDate(saturday.getDate() + untilSaturday);
  saturday.setHours(0, 0, 0, 0);

  const monday = new Date(saturday);
  monday.setDate(monday.getDate() + 2);

  return [now > saturday ? now : saturday, monday];
}

export function applyFilters(
  events: EventSummary[],
  filters: FilterState,
): EventSummary[] {
  const needle = filters.query.trim().toLowerCase();

  const matched = events.filter((event) => {
    if (needle) {
      // Venue is included deliberately — "KICC" is how people search for a
      // show whose name they cannot remember.
      const haystack = [event.name, event.venue, event.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (filters.category && event.category !== filters.category) return false;

    // A picked day wins over the window chips: it is the more specific answer,
    // and honouring both would let "This weekend" silently empty a search for
    // a Tuesday.
    if (filters.onDate) {
      if (eventDay(event) !== filters.onDate) return false;
    } else if (filters.window !== 'any') {
      const starts = new Date(event.startsAt);
      if (filters.window === 'weekend') {
        const [from, to] = weekendBounds();
        if (starts < from || starts >= to) return false;
      } else {
        const limit = new Date();
        limit.setMonth(limit.getMonth() + 1);
        if (starts > limit) return false;
      }
    }

    return true;
  });

  return matched.sort((a, b) => {
    if (filters.sort === 'cheapest') {
      // Events with nothing on sale sort last rather than first — a null price
      // means sold out, which is the least useful thing to show someone
      // shopping by price.
      if (a.fromPriceCents === null) return 1;
      if (b.fromPriceCents === null) return -1;
      return a.fromPriceCents - b.fromPriceCents;
    }
    return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  });
}

const WINDOWS: { value: DateWindow; label: string }[] = [
  { value: 'any', label: 'All Events' },
  { value: 'weekend', label: 'This Weekend' },
  { value: 'month', label: 'This Month' },
];

/** How many categories the row shows before folding the rest behind "More". */
const INLINE_CATEGORY_COUNT = 3;

function CalendarGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 8.5h14M7 3v3M13 3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** One glyph per category, so the row reads at a glance rather than by label alone. */
const CATEGORY_ICONS: Record<EventCategory, ReactNode> = {
  music: (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <circle cx="6" cy="15" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="13" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.2 15V5.5L17.2 4v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  comedy: (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.8 12.2c.9 1 2 1.5 3.2 1.5s2.3-.5 3.2-1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7.3 8h.01M12.7 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  business: (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4h3A1.5 1.5 0 0 1 13 5.5V7" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  festival: (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <path d="M4 16 8.5 5.5 13 16H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M13 16h3l-2.3-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  sports: (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 3v14M3 10h14M5 5.5c2 1.5 8 1.5 10 0M5 14.5c2-1.5 8-1.5 10 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  arts: (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M10 3a7 7 0 1 0 0 14c.9 0 1.5-.6 1.5-1.4 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.7.6-1.3 1.3-1.3H13a3.5 3.5 0 0 0 3.5-3.5C16.5 5.7 13.6 3 10 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="6.7" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="6.3" r="1" fill="currentColor" />
      <circle cx="12.3" cy="7" r="1" fill="currentColor" />
    </svg>
  ),
  other: (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M10 3.5 12 8l4.5.6-3.3 3.2.8 4.5L10 14.2l-4 2.1.8-4.5-3.3-3.2L8 8l2-4.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

function ChevronDownGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chip({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      /* The pill stays 32px so the row reads as one line of chrome, but the
         `before` pseudo-element widens the hit area to the 48px minimum
         without adding 16px of vertical space to the layout. */
      className={`md-label-large md-state relative inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 trimmed border px-4 whitespace-nowrap transition-colors duration-(--dur-medium) ease-(--ease-standard) before:absolute before:inset-x-0 before:top-1/2 before:h-12 before:-translate-y-1/2 before:content-[''] ${
        active
          ? 'border-primary-container bg-primary-container text-on-primary-container'
          : 'border-outline-variant text-on-surface-variant'
      }`}
    >
      <span className="md-state-layer" aria-hidden="true" />
      {icon}
      {children}
    </button>
  );
}

/**
 * The categories beyond the first `INLINE_CATEGORY_COUNT`, tucked behind one
 * chip rather than letting the row grow with every category the platform
 * adds. A plain disclosure, not `role="menu"` — see the same call in the
 * masthead's own "More" control for why.
 */
function MoreCategories({
  categories,
  active,
  onSelect,
}: {
  categories: EventCategory[];
  active: EventCategory | null;
  onSelect: (category: EventCategory) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const activeInFlyout = active !== null && categories.includes(active);

  useEffect(() => {
    if (!open) return;

    function handlePointer(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', handlePointer);
    return () => document.removeEventListener('pointerdown', handlePointer);
  }, [open]);

  if (categories.length === 0) return null;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <Chip active={activeInFlyout} onClick={() => setOpen((o) => !o)} icon={<ChevronDownGlyph />}>
        {activeInFlyout ? CATEGORY_LABELS[active!] : 'More'}
      </Chip>

      {open && (
        <div
          id={panelId}
          className="md-elevation-2 absolute left-0 z-50 mt-2 w-44 rounded-md p-2"
        >
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => {
                onSelect(category);
                setOpen(false);
              }}
              className={`md-state md-body-medium relative flex w-full cursor-pointer items-center gap-2 rounded-sm px-3 py-2.5 text-left transition-colors ${
                active === category ? 'text-primary' : 'text-on-surface'
              }`}
            >
              <span className="md-state-layer" aria-hidden="true" />
              <span className="relative flex items-center gap-2">
                {CATEGORY_ICONS[category]}
                {CATEGORY_LABELS[category]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EventFilters({
  filters,
  onChange,
  showSearch = true,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  /** False when a search field elsewhere already writes to the same state —
      the hero's own search does this for a signed-out visitor, and showing
      both is a second box asking the same question the first already did. */
  showSearch?: boolean;
}) {
  return (
    <div className="mb-6 space-y-4">
      {showSearch && (
        <div className="relative">
          <svg
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-on-surface-variant"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="m13.5 13.5 3 3"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>

          <input
            type="search"
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="Search events, venues"
            aria-label="Search events"
            className="min-h-11 w-full rounded-xl border border-outline-variant bg-surface-container py-3 pr-4 pl-11 text-on-surface transition placeholder:text-on-surface-variant focus:border-primary focus:ring-4 focus:ring-primary/20 focus:outline-none"
          />
        </div>
      )}

      {/* One row, always. Wrapping to a second line pushes the grid down on
          exactly the screens with least room; scrolling costs nothing and the
          mask tells you there is more to the right. */}
      <div
        className="-mx-1 flex min-w-0 items-center gap-2 overflow-x-auto px-1 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          maskImage:
            'linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 24px), transparent 100%)',
        }}
      >
        {WINDOWS.map((option) => (
          <Chip
            key={option.value}
            active={filters.window === option.value}
            onClick={() => onChange({ ...filters, window: option.value })}
            icon={<CalendarGlyph />}
          >
            {option.label}
          </Chip>
        ))}

        {CATEGORY_ORDER.slice(0, INLINE_CATEGORY_COUNT).map((category) => (
          <Chip
            key={category}
            active={filters.category === category}
            onClick={() =>
              onChange({
                ...filters,
                category: filters.category === category ? null : category,
              })
            }
            icon={CATEGORY_ICONS[category]}
          >
            {CATEGORY_LABELS[category]}
          </Chip>
        ))}

        <MoreCategories
          categories={CATEGORY_ORDER.slice(INLINE_CATEGORY_COUNT)}
          active={filters.category}
          onSelect={(category) =>
            onChange({
              ...filters,
              category: filters.category === category ? null : category,
            })
          }
        />
      </div>
    </div>
  );
}
