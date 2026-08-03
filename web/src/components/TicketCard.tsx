/**
 * A ticket tier, as something you pick.
 *
 * The previous row stated the same facts but did not read as selectable — it
 * was a bordered box with a stepper in it, and a buyer scanning three tiers had
 * to work out that choosing was even the task. §Ticket Selection asks for cards
 * that *feel* selectable, so the whole card is the target, the selected one
 * takes a primary border and a tinted surface, and a radio mark states the
 * choice explicitly rather than leaving it to the fill.
 *
 * Availability is never colour alone: each dot is paired with the word beside
 * it, because a red dot and an amber dot are the same dot to a buyer who cannot
 * distinguish them.
 */
import { availabilityLabel, formatMoney } from '@/lib/format';
import type { Tier } from '@/lib/api';
import { Badge } from './ui';
import { QuantityStepper } from './QuantityStepper';

const DOT: Record<'ok' | 'low' | 'gone', string> = {
  ok: 'bg-success',
  low: 'bg-tertiary',
  gone: 'bg-error',
};

export function TicketCard({
  tier,
  quantity,
  onChange,
}: {
  tier: Tier;
  quantity: number;
  onChange: (next: number) => void;
}) {
  const availability = availabilityLabel(tier);
  const unavailable = !tier.onSale || tier.soldOut || tier.closedByOrganiser;
  const selected = quantity > 0;

  // An uncapped tier has no stock number to cap against, so the only ceiling is
  // what one order may contain.
  const ceiling = tier.uncapped
    ? tier.maxPerOrder
    : Math.min(tier.maxPerOrder, tier.available ?? 0);

  // VIP and premium are one of the three sanctioned uses of gold on a consumer
  // surface — it marks a tier as the expensive one, which is exactly the
  // "earn" register gold carries everywhere else in the product.
  const isVip = /vip|premium|gold/i.test(tier.name);

  return (
    <div
      className={`rounded-md border p-5 transition-colors duration-(--dur-medium) ease-(--ease-standard) ${
        unavailable
          ? 'border-outline-variant bg-surface-container-low opacity-60'
          : selected
            ? 'border-primary bg-primary-container/25'
            : 'border-outline-variant bg-surface-container-lowest'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 gap-3">
          {/* States the choice rather than leaving it to the fill. Presentational
              — the stepper beside it is the real control, and it already
              announces the count. */}
          <span
            aria-hidden="true"
            className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
              selected ? 'border-primary' : 'border-outline'
            }`}
          >
            {selected && <span className="size-2.5 rounded-full bg-primary" />}
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="md-title-medium text-on-surface">{tier.name}</h3>
              {isVip && <Badge tone="gold">VIP</Badge>}
            </div>

            {tier.description && (
              <p className="md-body-medium mt-1.5 text-on-surface-variant">
                {tier.description}
              </p>
            )}

            <p className="md-body-small mt-2.5 flex items-center gap-2 text-on-surface-variant">
              <span
                className={`size-2 shrink-0 rounded-full ${DOT[availability.tone]}`}
                aria-hidden="true"
              />
              {availability.text}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-3">
          {/* A price is a fact the door will check — the data face, and tabular
              figures so a column of tiers lines up down the edge. */}
          <div className="text-right">
            <p className="md-data-large text-primary">
              {formatMoney(tier.priceCents, tier.currency)}
            </p>
            {tier.maxPerOrder < 10 && !unavailable && (
              <p className="md-data-small mt-0.5 text-on-surface-variant">
                Up to {tier.maxPerOrder} per order
              </p>
            )}
          </div>

          {unavailable ? (
            // Sold-out tiers stay visible and greyed rather than disappearing:
            // a tier vanishing between two page loads reads as a bug to someone
            // who was sent the link.
            <p className="md-body-medium text-on-surface-variant">
              {tier.closedByOrganiser
                ? 'Sales have closed'
                : tier.soldOut
                  ? 'Sold out'
                  : 'Not on sale'}
            </p>
          ) : (
            <QuantityStepper
              value={quantity}
              onChange={onChange}
              max={ceiling}
              label={tier.name}
            />
          )}
        </div>
      </div>
    </div>
  );
}
