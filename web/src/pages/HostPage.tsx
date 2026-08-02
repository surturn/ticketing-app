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
import { WhatsAppButton, WHATSAPP_DISPLAY } from '@/components/WhatsAppButton';

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

        <div className="mt-7 flex flex-wrap items-center gap-3">
          {/* One filled button in this view, and it is gold: the organiser's
              primary action on the organiser's page. */}
          <ButtonAnchor href="#pricing" variant="gold">
            See what it costs
          </ButtonAnchor>

          {/* Outlined, beside it rather than competing with it — but present in
              the hero rather than at the bottom of the page. An organiser
              deciding whether to trust us with a sale wants a person, and the
              answer to "how fast do they reply" is the pitch. */}
          <WhatsAppButton
            variant="outlined"
            prefill="Hi Eventify — I would like to list an event."
          >
            Talk to us on WhatsApp
          </WhatsAppButton>
        </div>

        <p className="md-body-small mt-3 text-on-surface-variant">
          Fastest way to reach us — {WHATSAPP_DISPLAY}. We answer during working
          hours, usually within the hour.
        </p>
      </section>

      <OrganiserPitch />
    </div>
  );
}
