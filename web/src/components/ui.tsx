/**
 * Material 3 components.
 *
 * Each encodes the parts of the spec that are easy to drop and expensive to
 * lose: the state layer on every interactive surface, the minimum touch target,
 * the paired colour roles, and the shape scale. Screens compose these rather
 * than assembling Material out of loose utility classes, which is how the
 * system stays consistent once more than one person is editing it.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** The translucent sheet M3 lays over a component on hover, focus and press. */
function StateLayer() {
  return <span className="md-state-layer" aria-hidden="true" />;
}

// ─── Buttons ───────────────────────────────────────────────────────────────

/**
 * M3's button variants, in descending emphasis.
 *
 * The variant carries the meaning, so a screen states importance by choosing
 * one rather than by restyling: `filled` for the single main action, `tonal`
 * for a strong secondary, `outlined` and `text` for everything quieter.
 */
export type ButtonVariant =
  | 'filled'
  | 'gold'
  | 'tonal'
  | 'outlined'
  | 'outlined-gold'
  | 'text'
  | 'elevated';

const VARIANT: Record<ButtonVariant, string> = {
  filled: 'bg-primary text-on-primary',
  /**
   * The organiser's primary action. Gold as a *fill* with dark text on top —
   * the only way bright gold is legible in light mode, where it as a label
   * measures about 1.9:1 and fails AA at every size.
   */
  gold: 'bg-tertiary-container text-on-tertiary-container',
  tonal: 'bg-secondary-container text-on-secondary-container',
  // Neutral label, not primary: an outlined button is a quieter path, and
  // colouring its label competes with the filled action it sits beside.
  outlined: 'border border-outline text-on-surface',
  /**
   * The organiser door on a consumer surface. `--md-tertiary` resolves to
   * bronze in light mode and true gold on dark, which is what keeps the label
   * readable in both without the component knowing which theme it is in.
   */
  'outlined-gold': 'border border-tertiary text-tertiary',
  text: 'text-on-surface-variant',
  elevated: 'bg-surface-container-low text-primary md-elevation-1',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
  busyLabel?: string;
  full?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'filled',
  busy = false,
  busyLabel,
  full = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'md-state md-label-large inline-flex cursor-pointer items-center justify-center gap-2',
        // 48px, not 40: this is the accessibility floor for a touch target and
        // the target device is a phone, so the floor is the default.
        'clipped h-12 px-6 transition-colors duration-150',
        // M3's disabled treatment: 12% on-surface fill, 38% on-surface label.
        'disabled:cursor-not-allowed disabled:border-transparent disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:shadow-none',
        VARIANT[variant],
        full && 'w-full',
        className,
      )}
    >
      <StateLayer />
      {busy ? <Spinner /> : icon}
      <span className="relative">{busy && busyLabel ? busyLabel : children}</span>
    </button>
  );
}

export function ButtonLink({
  to,
  variant = 'filled',
  className,
  children,
  viewTransition,
}: {
  to: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
  /** Hand the navigation to the View Transitions API where one is worthwhile. */
  viewTransition?: boolean;
}) {
  return (
    <Link
      to={to}
      viewTransition={viewTransition}
      className={cx(
        'md-state md-label-large clipped inline-flex h-12 cursor-pointer items-center justify-center gap-2 px-6 transition-colors duration-150',
        VARIANT[variant],
        className,
      )}
    >
      <StateLayer />
      <span className="relative">{children}</span>
    </Link>
  );
}

/**
 * The same button, as a real anchor.
 *
 * For in-page targets and anything leaving the app. A router `Link` to a hash
 * changes the URL without moving the page, because the router owns scroll
 * restoration and has no reason to think a fragment is a scroll instruction —
 * a plain anchor is what actually jumps.
 */
export function ButtonAnchor({
  href,
  variant = 'filled',
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={cx(
        'md-state md-label-large clipped inline-flex h-12 cursor-pointer items-center justify-center gap-2 px-6 transition-colors duration-150',
        VARIANT[variant],
        className,
      )}
    >
      <StateLayer />
      <span className="relative">{children}</span>
    </a>
  );
}

/**
 * The organiser's floating action — "Create event".
 *
 * Gold, elevated, and the one control on a dashboard that is allowed to sit
 * over the content rather than in the flow: listing is the action the whole
 * surface exists to make easy, so it stays reachable wherever the page is
 * scrolled to.
 */
export function Fab({
  to,
  label,
  icon,
  className,
}: {
  to: string;
  label: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cx(
        'md-state md-label-large inline-flex h-14 cursor-pointer items-center gap-3 rounded-lg px-5',
        'bg-tertiary-container text-on-tertiary-container md-elevation-3',
        className,
      )}
    >
      <StateLayer />
      <span className="relative flex items-center gap-3">
        {icon}
        {label}
      </span>
    </Link>
  );
}

/** A circular icon-only button, at the 48dp target M3 requires. */
export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'md-state flex size-12 cursor-pointer items-center justify-center rounded-full text-on-surface-variant transition-colors',
        className,
      )}
    >
      <StateLayer />
      <span className="relative flex items-center justify-center">{children}</span>
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('relative size-4 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Text field ────────────────────────────────────────────────────────────

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
  valid?: boolean;
}

/**
 * M3's outlined text field.
 *
 * The label sits on the outline and floats up into it once the field is focused
 * or filled — which is the entire reason M3 works this way: the label never
 * disappears, so someone half-way down a form can still tell what they are
 * typing into. Outlined rather than filled because a form on a tonal card needs
 * its own boundary; a filled field on a filled surface is two greys arguing.
 *
 * Driven by `peer` and `placeholder-shown` rather than React state, so it stays
 * correct through autofill, which sets a value without firing the events a
 * state-driven version would depend on.
 *
 * Validity is reported by the caller on blur, never per keystroke: a field that
 * turns red while someone is still typing their own email address is telling
 * them they are wrong before they have finished being right.
 */
export function Field({
  label,
  hint,
  error,
  valid = false,
  id,
  className,
  ...rest
}: FieldProps) {
  const fieldId = id ?? `field-${label.toLowerCase().replace(/\W+/g, '-')}`;
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;
  const confirmed = valid && !error;

  return (
    <div>
      <div className="relative">
        <input
          {...rest}
          id={fieldId}
          // `placeholder-shown` needs a placeholder to test against; a single
          // space keeps it invisible while the floating label does the work.
          placeholder={rest.placeholder ?? ' '}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(
            'peer md-body-large h-14 w-full rounded-sm border bg-transparent px-4',
            // Room at the right for the confirmation mark, so a long value does
            // not run underneath it.
            confirmed && 'pr-12',
            'text-on-surface transition-colors placeholder:text-transparent',
            // The focus ring is the outline thickening, not a second ring
            // outside it — `focus-visible` on the wrapper would double up.
            'focus:outline-none',
            error
              ? 'border-error focus:border-error'
              : confirmed
                ? 'border-success focus:border-success'
                : 'border-outline focus:border-primary',
            'focus:border-2',
            className,
          )}
        />

        {/* The label rides the outline: transparent-backed while it sits inside
            the field, and given a slab of the surface colour once it floats up
            so it punches a gap in the border rather than crossing it. */}
        <label
          htmlFor={fieldId}
          className={cx(
            'md-body-small pointer-events-none absolute -top-2 left-3 origin-left px-1 transition-all duration-150',
            'bg-surface-container-high',
            error
              ? 'text-error'
              : confirmed
                ? 'text-success'
                : 'text-on-surface-variant peer-focus:text-primary',
            // Full size and sitting on the baseline while empty and unfocused;
            // small and lifted into the outline otherwise.
            'peer-placeholder-shown:md-body-large peer-placeholder-shown:top-4 peer-placeholder-shown:bg-transparent',
            'peer-focus:md-body-small peer-focus:-top-2 peer-focus:bg-surface-container-high',
          )}
        >
          {label}
        </label>

        {confirmed && (
          <svg
            className="pointer-events-none absolute top-1/2 right-4 size-5 -translate-y-1/2 text-success"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </div>

      {/* Supporting text, at the 16px inset M3 specifies. */}
      {error ? (
        <p id={`${fieldId}-error`} role="alert" className="md-body-small mt-1 px-4 text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="md-body-small mt-1 px-4 text-on-surface-variant">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ─── Surfaces ──────────────────────────────────────────────────────────────

/**
 * M3 cards.
 *
 * Separation normally comes from moving to a different surface container rather
 * than from adding a shadow, so `filled` is the default and `elevated` is for
 * something that genuinely floats.
 */
export function Card({
  children,
  className,
  variant = 'filled',
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  variant?: 'filled' | 'outlined' | 'elevated';
  interactive?: boolean;
}) {
  const variants = {
    filled: 'bg-surface-container-high',
    outlined: 'bg-surface-container border border-outline-variant',
    elevated: 'bg-surface-container-low md-elevation-1',
  };

  return (
    <div
      className={cx(
        'rounded-md',
        variants[variant],
        interactive && 'md-state cursor-pointer',
        className,
      )}
    >
      {interactive && <StateLayer />}
      {children}
    </div>
  );
}

/** M3 filter chip. */
export function Chip({
  selected = false,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        // Fully rounded, and 32px tall so a row of chips reads as one line of
        // chrome — the 48px touch target comes from the `before` overlay rather
        // than from 16px of extra vertical space in the layout.
        'md-state md-label-large clipped clipped-sm relative inline-flex h-8 cursor-pointer items-center gap-2 px-4 transition-colors',
        "before:absolute before:inset-x-0 before:top-1/2 before:h-12 before:-translate-y-1/2 before:content-['']",
        selected
          ? 'bg-primary-container text-on-primary-container'
          : 'border border-outline-variant text-on-surface-variant',
      )}
    >
      <StateLayer />
      {selected && (
        <svg
          viewBox="0 0 20 20"
          className="relative size-4"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
      )}
      <span className="relative">{children}</span>
    </button>
  );
}

/** A compact status badge, on the tonal container roles. */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'gold' | 'low' | 'gone';
}) {
  const tones = {
    neutral: 'bg-secondary-container text-on-secondary-container',
    /** VIP and premium tiers — one of the three sanctioned uses of gold. */
    gold: 'bg-tertiary-container text-on-tertiary-container',
    low: 'bg-tertiary-container text-on-tertiary-container',
    gone: 'bg-surface-container-highest text-on-surface-variant',
  };
  return (
    <span
      className={cx(
        'md-label-small inline-flex items-center rounded-xs px-2 py-0.5',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-sm', className)} aria-hidden="true" />;
}

/**
 * An empty screen is an invitation, not an error.
 *
 * Three parts, always in this order: a mark, a line saying what is missing, and
 * a line saying what to do about it. The default mark is a torn stub — the
 * product's own vocabulary rather than a generic magnifying glass — drawn in
 * `outline-variant` so it reads as an absence and not as a warning.
 */
export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-surface-container-low px-6 py-16 text-center">
      <div className="flex justify-center text-outline-variant" aria-hidden="true">
        {icon ?? (
          <svg viewBox="0 0 48 48" className="size-12" fill="none">
            <path
              d="M6 14a2 2 0 0 1 2-2h32a2 2 0 0 1 2 2v6a4 4 0 0 0 0 8v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6a4 4 0 0 0 0-8v-6Z"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M24 16v4m0 4v4m0 4v4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="0.5 5"
            />
          </svg>
        )}
      </div>

      <p className="md-title-medium mt-5 text-on-surface">{title}</p>
      <p className="md-body-medium mx-auto mt-2 max-w-sm text-on-surface-variant">
        {body}
      </p>
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'That did not load',
  body,
  onRetry,
}: {
  title?: string;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-lg bg-error-container px-6 py-12 text-center">
      <p className="md-title-medium text-on-error-container">{title}</p>
      <p className="md-body-medium mx-auto mt-2 max-w-md text-on-error-container">
        {body}
      </p>
      {/* Every error keeps a way out — a dead end turns a blip into a lost sale. */}
      {onRetry && (
        <div className="mt-6 flex justify-center">
          <Button variant="outlined" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
