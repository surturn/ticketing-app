/**
 * Shared furniture for the policy pages.
 *
 * Legal text is read in two ways and has to serve both: skimmed by someone
 * hunting one answer, and read in full by someone who has a problem. So the
 * measure is narrow, the headings are numbered and linkable, and the type is
 * the body scale rather than anything smaller — small print is a habit from
 * paper, and it reads as something being hidden.
 */
import type { ReactNode } from 'react';

export function LegalPage({
  title,
  updated,
  summary,
  children,
}: {
  title: string;
  updated: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <article className="mx-auto max-w-2xl">
      <header className="mb-10">
        <h1 className="md-headline-large">{title}</h1>
        <p className="md-data-small mt-3 text-on-surface-variant">
          Last updated {updated}
        </p>
        <p className="md-body-large mt-5 text-on-surface-variant">{summary}</p>
      </header>

      <div className="space-y-8">{children}</div>
    </article>
  );
}

export function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="md-title-large">
        <span className="md-data-medium mr-2 text-on-surface-variant">{n}.</span>
        {title}
      </h2>
      <div className="md-body-large mt-3 space-y-3 text-on-surface-variant">
        {children}
      </div>
    </section>
  );
}

/** A definition-style row, for the tables of data and purposes. */
export function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="border-t border-outline-variant/60 py-3 sm:grid sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="md-title-medium text-on-surface">{term}</dt>
      <dd className="md-body-medium mt-1 text-on-surface-variant sm:mt-0">{children}</dd>
    </div>
  );
}
