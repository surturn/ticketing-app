/**
 * The listing pitch — the reason the homepage exists.
 *
 * An organiser deciding where to list is asking two questions and no others:
 * what does this cost me, and when do I get my money. Everything here answers
 * one of those. Nothing here is a feature tour.
 *
 * The payout step is the trust moment: no fee should ever be a surprise
 * discovered after an event has sold, so the numbers sit on the landing page in
 * the data face rather than behind a "contact us".
 */
import type { ReactNode } from 'react';
import { ButtonAnchor } from '@/components/ui';

/**
 * The commercial terms, in one place.
 *
 * TODO(pricing): these are the only invented values on the page — set them to
 * the real commercial terms before launch, and keep them here rather than
 * scattering them through the copy. The API has a `fee_cents` column but no
 * configured rate to read, so there is nothing to derive them from yet.
 */
const TERMS = {
  buyerFee: '6%',
  listingFee: 'Free',
  payoutDays: '3',
} as const;

function Term({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail: string;
}) {
  return (
    <div>
      {/* The number in the data face and the explanation in the body face —
          the register shift is what makes the figure read as a term rather
          than as marketing. */}
      <p className="md-display-small text-on-surface tabular-nums">{value}</p>
      <p className="md-title-medium mt-3 text-on-surface">{label}</p>
      <p className="md-body-medium mt-1 text-on-surface-variant">{detail}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span
        className="md-data-medium flex size-8 shrink-0 items-center justify-center rounded-full bg-tertiary-container text-on-tertiary-container"
        aria-hidden="true"
      >
        {n}
      </span>
      <div className="min-w-0">
        <p className="md-title-medium text-on-surface">{title}</p>
        <p className="md-body-medium mt-1 text-on-surface-variant">{children}</p>
      </div>
    </li>
  );
}

export function OrganiserPitch() {
  return (
    <section
      id="pricing"
      aria-labelledby="pricing-heading"
      /* Gold rule down the leading edge rather than blue: this is the organiser
         equivalent of the "Next up" card, and the two-audience logic shows up
         at component level. */
      className="relative mb-14 scroll-mt-20 overflow-hidden rounded-md border border-tertiary/25 bg-surface-container"
    >
      <div className="absolute inset-y-0 left-0 w-[3px] bg-tertiary" aria-hidden="true" />

      <div className="relative p-6 sm:p-10">
        <p className="md-eyebrow text-tertiary">What it costs</p>

        <h2 id="pricing-heading" className="md-headline-medium mt-3 max-w-2xl">
          No listing fee. Paid out after the show.
        </h2>

        <div className="mt-8 grid gap-8 sm:grid-cols-3">
          <Term
            value={TERMS.listingFee}
            label="To list"
            detail="Put an event up and share it. You are charged nothing until a ticket sells."
          />
          <Term
            value={TERMS.buyerFee}
            label="Per ticket sold"
            detail="Taken from the sale, shown to the buyer at checkout. No monthly cost."
          />
          <Term
            value={`${TERMS.payoutDays} days`}
            label="To your M-Pesa"
            detail="Settlement lands after the event has run, straight to the number you registered."
          />
        </div>

        <ol className="mt-10 grid gap-6 border-t border-outline-variant/60 pt-8 sm:grid-cols-3">
          <Step n="1" title="Upload your poster">
            The artwork you already have. We crop it to the ratio every screen
            expects and show you the WhatsApp preview before you publish.
          </Step>
          <Step n="2" title="Set your tiers">
            Name, price, how many. One tier is enough — most events never need a
            second.
          </Step>
          <Step n="3" title="Share one link">
            Drop it in the group. Buyers pay with M-Pesa and get their ticket by
            email in seconds.
          </Step>
        </ol>

        <div className="mt-10">
          <ButtonAnchor href="mailto:organisers@eventify.co.ke" variant="gold">
            List your event
          </ButtonAnchor>
          {/* Honest about where this currently goes. The four-step listing flow
              in §7.9 of the guidelines is not built yet, and a button that
              opened a dead route would cost more trust than the email does. */}
          <p className="md-body-small mt-3 text-on-surface-variant">
            Self-service listing is opening shortly. Until then we set your event
            up for you, same day.
          </p>
        </div>
      </div>
    </section>
  );
}
