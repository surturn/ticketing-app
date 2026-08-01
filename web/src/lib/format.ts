/**
 * Formatting for money, dates and the small strings that appear everywhere.
 *
 * Centralised because the alternative is every component inventing its own, and
 * a price that renders differently on two screens reads as a bug in the price.
 */

/**
 * Money.
 *
 * The API speaks in integer cents and never in floats, and so does this — the
 * division happens once, here, at the moment of display. `KES 1,500` rather than
 * `KES 1,500.00`: Kenyan ticket prices are whole shillings, and trailing zeros
 * on every card is noise.
 */
export function formatMoney(cents: number, currency = 'KES'): string {
  const whole = cents / 100;
  const hasFraction = cents % 100 !== 0;

  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(whole);
}

/**
 * Event dates, in the event's own timezone.
 *
 * A doors-at time is a fact about the venue, not about the buyer's laptop. A
 * Nairobi event bought from London must still say 18:00, so the event's timezone
 * is passed in rather than defaulted to the browser's.
 */
export function formatEventDate(
  iso: string,
  timezone = 'Africa/Nairobi',
): string {
  return new Intl.DateTimeFormat('en-KE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso));
}

export function formatEventDay(iso: string, timezone = 'Africa/Nairobi'): string {
  return new Intl.DateTimeFormat('en-KE', {
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(new Date(iso));
}

/** The countdown on a held order: "8:14 left". */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * How a tier's remaining stock should read.
 *
 * Three states the API distinguishes and the interface must not collapse:
 * unlimited (`available: null` with `uncapped`), genuinely none left, and a low
 * number worth showing as urgency. Treating `null` as zero would present an
 * unlimited tier as sold out.
 */
export function availabilityLabel(tier: {
  available: number | null;
  uncapped: boolean;
  soldOut: boolean;
  closedByOrganiser: boolean;
}): { text: string; tone: 'ok' | 'low' | 'gone' } {
  if (tier.closedByOrganiser) return { text: 'Sales closed', tone: 'gone' };
  if (tier.soldOut) return { text: 'Sold out', tone: 'gone' };
  if (tier.uncapped || tier.available === null) return { text: 'Available', tone: 'ok' };
  if (tier.available === 0) return { text: 'Sold out', tone: 'gone' };
  if (tier.available <= 10) return { text: `Only ${tier.available} left`, tone: 'low' };
  return { text: `${tier.available} available`, tone: 'ok' };
}

/** Groups a flat ticket list by tier, for the stub headings. */
export function groupBy<T, K extends string>(
  items: T[],
  key: (item: T) => K,
): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}
