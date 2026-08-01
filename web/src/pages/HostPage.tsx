/**
 * The listing pitch, on its own route.
 *
 * It used to sit above the event grid on the landing page. That put the wrong
 * audience first: almost everyone arriving at the domain is looking for
 * something to go to, and the handful deciding where to list are better served
 * by a page that is entirely theirs than by a banner the rest have to scroll
 * past.
 *
 * Gold throughout, because this is the organiser side of the product speaking —
 * the one surface where that is the default rather than the exception.
 */
import { OrganiserPitch } from '@/components/OrganiserPitch';
import { ButtonAnchor } from '@/components/ui';

export function HostPage() {
  return (
    <div>
      <section className="mb-12">
        <p className="md-eyebrow text-tertiary">For organisers · Nairobi</p>

        <h1 className="md-display-medium mt-3 max-w-3xl">
          Sell out your next event
        </h1>

        <p className="md-body-large mt-5 max-w-xl text-on-surface-variant">
          List in minutes, share one link, and get paid by M-Pesa. Your buyers
          never leave WhatsApp to find you, and your tickets scan at the gate
          with or without signal.
        </p>

        <div className="mt-7">
          {/* One filled button in this view, and it is gold: the organiser's
              primary action on the organiser's page. */}
          <ButtonAnchor href="#pricing" variant="gold">
            See what it costs
          </ButtonAnchor>
        </div>
      </section>

      <OrganiserPitch />
    </div>
  );
}
