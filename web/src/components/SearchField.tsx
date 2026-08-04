/**
 * The large search.
 *
 * §Search of the UI rules asks for height, a large tap area and an instant
 * focus state, and rules out hiding it behind a menu. It is fully rounded
 * rather than chamfered — the chamfer is the *button* silhouette, and a search
 * field is not a button; a pill here reads as a field you type into, which is
 * the one place the pill shape is doing work rather than being a default.
 */
export function SearchField({
  value,
  onChange,
  placeholder = 'Search events, artists or venues',
  id = 'event-search',
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? ''}`}>
      <label htmlFor={id} className="sr-only">
        Search events
      </label>

      <svg
        viewBox="0 0 20 20"
        className="pointer-events-none absolute top-1/2 left-5 size-5 -translate-y-1/2 text-on-surface-variant"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2" />
        <path d="m13.5 13.5 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>

      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="md-body-large h-14 w-full rounded-full border border-transparent bg-surface-container-lowest pr-5 pl-13 text-on-surface shadow-lg shadow-black/10 transition-colors placeholder:text-on-surface-variant focus:border-primary focus:outline-none"
      />
    </div>
  );
}
