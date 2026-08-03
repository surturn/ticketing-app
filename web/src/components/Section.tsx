/**
 * A titled band of the page.
 *
 * Exists so section rhythm is a property of the system rather than a decision
 * each page makes again — the spacing between sections was previously chosen
 * per module, which is what made the homepage read as a stack of unrelated
 * blocks rather than one document.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function Section({
  id,
  eyebrow,
  title,
  action,
  children,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  /** The "View all →" affordance, when the section is a window onto more. */
  action?: { to: string; label: string };
  children: ReactNode;
}) {
  const headingId = id ? `${id}-heading` : undefined;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="mb-(--space-section-sm) scroll-mt-20 sm:mb-(--space-section)"
    >
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <p className="md-eyebrow mb-1.5 text-primary">{eyebrow}</p>}
          <h2 id={headingId} className="md-headline-medium truncate">
            {title}
          </h2>
        </div>

        {action && (
          <Link
            to={action.to}
            className="md-label-large shrink-0 text-primary transition-colors hover:text-on-surface"
          >
            {action.label} <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>

      {children}
    </section>
  );
}
