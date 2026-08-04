/**
 * The four reassurances, as a row.
 *
 * A buyer about to type an M-Pesa PIN into a site a friend linked them to is
 * asking exactly four questions, and this answers them before they are asked
 * rather than in a footer they will never reach.
 *
 * Scrolls horizontally on a phone rather than wrapping to two cramped rows or
 * dropping to one item per line, which would make a reassurance strip taller
 * than the hero it reassures about.
 *
 * Two tones, because it sits on two different backgrounds. `surface` is the
 * card-on-a-page version used lower on the page and while signed in; `hero`
 * sits over the masthead photograph itself, so its text is literal white
 * rather than a theme token — same reason the hero's own headline is — and its
 * icon badge is a translucent wash rather than a solid container colour, since
 * a solid tonal fill would fight the photograph behind it instead of sitting
 * on top of it.
 */
import type { ReactNode } from 'react';

export interface TrustItem {
  icon: ReactNode;
  label: string;
  hint: string;
}

export function TrustBar({
  items,
  variant = 'surface',
}: {
  items: TrustItem[];
  variant?: 'surface' | 'hero';
}) {
  const onHero = variant === 'hero';

  return (
    <ul
      className={`-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:gap-6 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden ${
        onHero ? 'sm:flex-wrap' : 'sm:grid sm:grid-cols-2 lg:grid-cols-4'
      }`}
    >
      {items.map((item) => (
        <li
          key={item.label}
          className={
            onHero
              ? 'flex w-56 shrink-0 snap-start items-center gap-2.5 sm:w-auto'
              : 'flex w-56 shrink-0 snap-start items-center gap-3 rounded-md bg-surface-container-low p-4 sm:w-auto'
          }
        >
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
              onHero
                ? 'bg-[var(--blue-60)] text-white'
                : 'bg-primary-container text-on-primary-container'
            }`}
            aria-hidden="true"
          >
            {item.icon}
          </span>
          <span className="min-w-0">
            <span
              className={`md-title-small block truncate ${onHero ? 'text-white' : 'text-on-surface'}`}
            >
              {item.label}
            </span>
            <span
              className={`md-body-small block truncate ${onHero ? 'text-white/70' : 'text-on-surface-variant'}`}
            >
              {item.hint}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The buyer's four questions, answered.
 *
 * Exported as data rather than a second component so the homepage and the
 * event page state the same four things in the same order — a reassurance that
 * changes wording between pages reassures nobody.
 */
export const BUYER_TRUST: TrustItem[] = [
  { icon: <IconPhone />, label: 'Pay with M-Pesa', hint: 'Secure payments' },
  { icon: <IconMail />, label: 'E-ticket delivery', hint: 'Instant to your email' },
  { icon: <IconScan />, label: 'Scan at the gate', hint: 'No app needed' },
  { icon: <IconShield />, label: '100% secure', hint: 'Encrypted checkout' },
];

function IconPhone() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden="true">
      <rect x="5" y="2" width="10" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 15.5h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m2.5 5.5 7.5 5 7.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function IconScan() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden="true">
      <path
        d="M3 7V4h3M17 7V4h-3M3 13v3h3M17 13v3h-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M3 10h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden="true">
      <path
        d="M10 2.5 4 5v5c0 3.5 2.5 6.2 6 7.5 3.5-1.3 6-4 6-7.5V5l-6-2.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="m7.5 10 2 2 3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
