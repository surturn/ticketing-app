/**
 * The four reassurances specific to actually buying a ticket, as a card
 * overlapping the hero's lower edge.
 *
 * Different content from the homepage's `TrustBar`: a buyer here has already
 * decided which event, so the question is no longer "is this real" but "can I
 * still get in" — hence the live seat count leading the row.
 */
import type { EventDetail } from '@/lib/api';

/**
 * How many seats are left across every tier still actually on sale.
 *
 * Only counts capped tiers. An uncapped tier has no number behind it, so
 * folding it into a total would either under-report (ignoring it) or invent a
 * figure (treating "no limit" as zero) — both worse than the honest answer,
 * which is that a total is not knowable and the strip says "Selling now"
 * instead.
 */
function seatsLeft(event: EventDetail): number | null {
  let total = 0;
  let anyCapped = false;

  for (const tier of event.tiers) {
    if (!tier.onSale || tier.soldOut || tier.closedByOrganiser) continue;
    if (tier.uncapped || tier.available === null) continue;
    anyCapped = true;
    total += tier.available;
  }

  return anyCapped ? total : null;
}

function MegaphoneIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <path d="M3 8v4l4 1V7L3 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path
        d="M7 7.2 15 4v12l-8-3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M6 13v3a1.5 1.5 0 0 0 3 0v-2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <path
        d="m11 3-7 9h5l-1 5 7-9h-5l1-5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <path
        d="M10 2.5 4 5v5c0 3.5 2.5 6.2 6 7.5 3.5-1.3 6-4 6-7.5V5l-6-2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="m7.5 10 2 2 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <rect x="5" y="2" width="10" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 15.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EventTrustStrip({ event }: { event: EventDetail }) {
  const seats = seatsLeft(event);

  const items: { icon: React.ReactNode; label: string; hint: React.ReactNode }[] = [
    {
      icon: <MegaphoneIcon />,
      label: 'Limited Seats',
      hint:
        seats !== null ? (
          <>
            <span className="font-medium text-primary">{seats}</span> left
          </>
        ) : (
          'Selling now'
        ),
    },
    { icon: <BoltIcon />, label: 'Instant Delivery', hint: 'QR tickets' },
    { icon: <ShieldIcon />, label: 'Secure Checkout', hint: 'Encrypted' },
    { icon: <PhoneIcon />, label: 'Pay with M-Pesa', hint: 'Fast & safe' },
  ];

  return (
    <div className="md-elevation-2 relative z-10 -mt-8 rounded-lg bg-surface-container-lowest p-5 sm:p-6">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2.5">
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
    </div>
  );
}
