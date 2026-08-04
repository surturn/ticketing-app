/**
 * Minus, count, plus.
 *
 * Lifted out of the tier row so the ticket card and anything later that needs
 * a quantity share one control rather than two that drift apart.
 *
 * 48px targets, and that is not negotiable here: this is the control someone
 * taps repeatedly, on a phone, often in a queue, often one-handed. It is the
 * last place in the product to economise on target size. The two buttons stay
 * circular inside a chamfered frame — a round icon button is not the generic
 * pill the shape change was aimed at.
 */
export function QuantityStepper({
  value,
  onChange,
  max,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  max: number;
  /** The tier name, so each control announces which ticket it changes. */
  label: string;
}) {
  return (
    <div className="trimmed flex items-center gap-1 border border-outline-variant bg-surface p-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={value === 0}
        aria-label={`Remove one ${label} ticket`}
        className="md-state flex size-12 cursor-pointer items-center justify-center rounded-full text-lg text-on-surface-variant transition-colors disabled:cursor-not-allowed disabled:opacity-30"
      >
        <span className="md-state-layer" aria-hidden="true" />
        <span className="relative">−</span>
      </button>

      <span
        className="md-data-large w-8 text-center text-on-surface"
        aria-live="polite"
        aria-label={`${value} ${label} tickets`}
      >
        {value}
      </span>

      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label={`Add one ${label} ticket`}
        className="md-state flex size-12 cursor-pointer items-center justify-center rounded-full text-lg text-on-surface-variant transition-colors disabled:cursor-not-allowed disabled:opacity-30"
      >
        <span className="md-state-layer" aria-hidden="true" />
        <span className="relative">+</span>
      </button>
    </div>
  );
}
