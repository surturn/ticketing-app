/**
 * The four reassurances, as a row.
 *
 * Placed directly under a hero on both the homepage and the event page. A buyer
 * about to type an M-Pesa PIN into a site a friend linked them to is asking
 * exactly four questions, and this answers them before they are asked rather
 * than in a footer they will never reach.
 *
 * Scrolls horizontally on a phone rather than wrapping to two cramped rows or
 * dropping to one item per line, which would make a reassurance strip taller
 * than the hero it reassures about.
 */
import type { ReactNode } from 'react';

export interface TrustItem {
  icon: ReactNode;
  label: string;
  hint: string;
}

export function TrustBar({ items }: { items: TrustItem[] }) {
  return (
    <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-4 [&::-webkit-scrollbar]:hidden">
      {items.map((item) => (
        <li
          key={item.label}
          className="flex w-56 shrink-0 snap-start items-center gap-3 rounded-md bg-surface-container-low p-4 sm:w-auto"
        >
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
            aria-hidden="true"
          >
            {item.icon}
          </span>
          <span className="min-w-0">
            <span className="md-title-small block truncate text-on-surface">{item.label}</span>
            <span className="md-body-small block truncate text-on-surface-variant">
              {item.hint}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
