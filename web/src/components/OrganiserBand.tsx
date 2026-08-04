/**
 * The listing pitch, at the foot of the homepage.
 *
 * Placed last deliberately. Someone who typed the domain in is usually deciding
 * where to list, but someone who followed a link is here to buy — and the fold
 * belongs to the buyer. A closing band catches the organiser on their way past
 * without spending the top of the page on the smaller audience.
 *
 * Gold throughout, which is the whole point: gold means "this leads to the side
 * of the product where you sell", and this is the largest instance of that
 * signal anywhere in the storefront.
 */
import { ButtonLink } from './ui';

const POINTS = [
  { value: 'M-Pesa', label: 'Paid straight to your till' },
  { value: 'Days', label: 'Not weeks, to settle' },
  { value: 'Free', label: 'To list an event' },
];

export function OrganiserBand() {
  return (
    <section className="mb-(--space-section-sm) overflow-hidden rounded-lg bg-tertiary-container sm:mb-(--space-section)">
      <div className="grid gap-8 p-8 sm:p-12 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-16">
        <div className="min-w-0">
          <p className="md-eyebrow text-on-tertiary-container/80">For organisers</p>

          <h2 className="md-display-small mt-3 max-w-xl text-on-tertiary-container">
            Sell your tickets where your audience already is
          </h2>

          <p className="md-body-large mt-4 max-w-lg text-on-tertiary-container/85">
            List an event in minutes. Buyers pay with M-Pesa, tickets go out by
            email, and the money reaches your account in days rather than weeks.
          </p>

          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4">
            {POINTS.map((point) => (
              <div key={point.value}>
                <dt className="md-headline-small text-on-tertiary-container">
                  {point.value}
                </dt>
                <dd className="md-body-small mt-0.5 text-on-tertiary-container/80">
                  {point.label}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* `gold` is the filled tertiary variant — the organiser's primary
            action, and the only filled button in this band. */}
        <ButtonLink to="/host" variant="gold" className="shrink-0">
          List an event
        </ButtonLink>
      </div>
    </section>
  );
}
