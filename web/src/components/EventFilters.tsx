/**
 * Search, date and sort — applied as you type.
 *
 * Filtering happens in the browser over the already-loaded listing, so there is
 * no Apply button and no round-trip: results narrow on each keystroke. That is
 * the right trade while a city's worth of events fits in one response; if the
 * listing ever outgrows that, this moves server-side behind the same props.
 *
 * There is no "event type" control. The API has no category field, and a filter
 * that silently matched nothing would be worse than its absence.
 */
import type { EventSummary } from '@/lib/api';

export type DateWindow = 'any' | 'weekend' | 'month';
export type SortOrder = 'soonest' | 'cheapest';

export interface FilterState {
  query: string;
  window: DateWindow;
  sort: SortOrder;
}

export const DEFAULT_FILTERS: FilterState = {
  query: '',
  window: 'any',
  sort: 'soonest',
};

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

    if (filters.window !== 'any') {
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
  { value: 'any', label: 'Any date' },
  { value: 'weekend', label: 'This weekend' },
  { value: 'month', label: 'This month' },
];

const SORTS: { value: SortOrder; label: string }[] = [
  { value: 'soonest', label: 'Soonest' },
  { value: 'cheapest', label: 'Lowest price' },
];

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
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
      className={`md-label-large md-state relative inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-4 whitespace-nowrap transition-colors duration-[--dur-medium] ease-[--ease-standard] before:absolute before:inset-x-0 before:top-1/2 before:h-12 before:-translate-y-1/2 before:content-[''] ${
        active
          ? 'border-primary-container bg-primary-container text-on-primary-container'
          : 'border-outline-variant text-on-surface-variant'
      }`}
    >
      <span className="md-state-layer" aria-hidden="true" />
      {active && (
        <svg
          className="-ml-1 size-4 shrink-0"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m4.5 10.5 3.5 3.5 7.5-8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {children}
    </button>
  );
}

export function EventFilters({
  filters,
  onChange,
  resultCount,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  resultCount: number;
}) {
  return (
    <div className="mb-6 space-y-4">
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

      <div className="flex items-center gap-3">
        {/* One row, always. Wrapping to a second line pushes the grid down on
            exactly the screens with least room; scrolling costs nothing and the
            mask tells you there is more to the right. */}
        <div
          className="-mx-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-1 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            >
              {option.label}
            </Chip>
          ))}

          <span
            className="mx-1 h-5 w-px shrink-0 bg-outline-variant"
            aria-hidden="true"
          />

          {SORTS.map((option) => (
            <Chip
              key={option.value}
              active={filters.sort === option.value}
              onClick={() => onChange({ ...filters, sort: option.value })}
            >
              {option.label}
            </Chip>
          ))}
        </div>

        {/* Announced politely, so a screen reader hears the count change as the
            query narrows rather than being told nothing. */}
        <span
          className="md-data-small shrink-0 text-on-surface-variant"
          aria-live="polite"
        >
          {String(resultCount).padStart(2, '0')}
        </span>
      </div>
    </div>
  );
}
