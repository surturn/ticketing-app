/**
 * A disclosure row.
 *
 * The event page carries venue, organiser, refund policy and FAQs, and all four
 * are answers to questions most buyers do not have. Laid out flat they push the
 * ticket selection below the fold, which taxes every buyer to serve a few.
 * Collapsed, the *questions* stay visible — which is the part that builds trust
 * — and only the answers cost space.
 *
 * A real <button> with aria-expanded rather than <details>: the summary needs a
 * two-column layout with a trailing chevron, and Safari's default marker
 * fights that.
 */
import { useId, useState, type ReactNode } from 'react';

export function Accordion({
  icon,
  label,
  summary,
  defaultOpen = false,
  children,
}: {
  icon?: ReactNode;
  label: string;
  /** The one-line answer, shown while collapsed. */
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className="border-b border-outline-variant">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="md-state flex w-full cursor-pointer items-center gap-3 py-5 text-left transition-colors"
      >
        <span className="md-state-layer" aria-hidden="true" />

        {icon && (
          <span className="relative shrink-0 text-on-surface-variant" aria-hidden="true">
            {icon}
          </span>
        )}

        <span className="md-title-medium relative shrink-0 text-on-surface">{label}</span>

        {summary && (
          <span className="md-body-medium relative min-w-0 flex-1 truncate text-on-surface-variant">
            {summary}
          </span>
        )}

        <svg
          viewBox="0 0 20 20"
          className={`relative ml-auto size-5 shrink-0 text-on-surface-variant transition-transform duration-(--dur-short) ${
            open ? 'rotate-180' : ''
          }`}
          fill="none"
          aria-hidden="true"
        >
          <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div id={panelId} className="md-body-large pb-6 text-on-surface-variant">
          {children}
        </div>
      )}
    </div>
  );
}
