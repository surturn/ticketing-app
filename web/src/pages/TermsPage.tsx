/**
 * Terms of service.
 *
 * Written to be read by a buyer rather than only by a lawyer, and to be honest
 * about the one thing ticketing terms usually obscure: who is actually
 * responsible when an event goes wrong. Eventify sells tickets on an
 * organiser's behalf; the organiser runs the event. Saying so plainly is
 * better for everyone than burying it, because it is the sentence a buyer needs
 * when they are trying to work out who to contact.
 */
import { LegalPage, Section } from '@/components/LegalPage';

const CONTACT = 'hello@invonicstechnologies.com';

export function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="1 August 2026"
      summary="These terms govern your use of Eventify Tickets. They cover how tickets are sold, what happens if an event changes, and what each of us is responsible for."
    >
      <Section n={1} title="Who we are">
        <p>
          Eventify Tickets is operated by Invonics Technologies. In these terms,
          "we" and "us" mean Invonics Technologies, and "you" means anyone using
          the service to buy or sell tickets.
        </p>
        <p>
          By buying a ticket or creating an account, you accept these terms and
          the Privacy Policy.
        </p>
      </Section>

      <Section n={2} title="What we do, and what the organiser does">
        <p>
          We are a ticketing platform. We sell tickets as an agent for the
          organiser of each event, take payment, and issue the ticket. We do not
          run the events themselves.
        </p>
        <p>
          The organiser is responsible for the event: whether it happens, when
          and where it happens, what it consists of, admission at the door, and
          the conduct of the venue. A contract to attend an event is between you
          and the organiser.
        </p>
        <p>
          This matters when something goes wrong: if an event is cancelled or
          changed, the organiser decides what happens, and we act on their
          instruction. If a ticket does not arrive or a payment fails, that is
          ours to fix — write to us.
        </p>
      </Section>

      <Section n={3} title="Buying a ticket">
        <p>
          Tickets are sold subject to availability. Choosing tickets holds them
          for a short period while you pay; if payment is not completed in that
          window, the hold lapses and they return to sale.
        </p>
        <p>
          Payment is by M-Pesa. When you confirm, a payment request is sent to
          your phone and you authorise it with your PIN. We never see or store
          your PIN. Your purchase is complete when Safaricom confirms the
          payment, at which point your tickets are issued and emailed to you.
        </p>
        <p>
          The price shown at checkout is what you pay. Any fee is included in the
          total displayed before you confirm — there are no charges added
          afterwards.
        </p>
        <p>
          Please check your details before confirming. Tickets are sent to the
          email address you give, and a mistyped address means a ticket
          delivered somewhere you cannot reach.
        </p>
      </Section>

      <Section n={4} title="Your ticket">
        <p>
          Each ticket carries a unique code and a cryptographic signature, and is
          valid for one admission to the event it names. A ticket is scanned once;
          a copy presented afterwards will be refused.
        </p>
        <p>
          Do not post your ticket or its QR code publicly. Anyone holding the
          code can use it, and we cannot tell a stranger's screenshot from your
          own at the gate.
        </p>
        <p>
          You may pass a ticket to someone else. The person who arrives with it
          is admitted, so pass it only to someone you intend to have it.
        </p>
      </Section>

      <Section n={5} title="Refunds, cancellations and changes">
        <p>
          Tickets are generally non-refundable once issued, because the sale is
          complete and the seat is no longer available to anyone else.
        </p>
        <p>
          If an event is <strong className="text-on-surface">cancelled</strong>,
          you are entitled to a refund of the ticket price. We will process it to
          the M-Pesa number you paid from, on the organiser's instruction.
        </p>
        <p>
          If an event is{' '}
          <strong className="text-on-surface">materially changed</strong> — a new
          date, or a different venue — the organiser will say whether tickets
          remain valid or may be refunded. We will tell you which.
        </p>
        <p>
          If a payment is taken but no ticket is issued, that is our error and we
          will refund it in full without being asked. If you think this has
          happened, write to us with your order reference and we will resolve it.
        </p>
        <p>
          Nothing in these terms limits any right you have under the Consumer
          Protection Act or other Kenyan law.
        </p>
      </Section>

      <Section n={6} title="Getting in, and being asked to leave">
        <p>
          Admission is at the organiser's discretion and subject to the venue's
          conditions. You may be refused entry or asked to leave for reasons
          including intoxication, threatening behaviour, or refusing a lawful
          security check. In those circumstances no refund is due.
        </p>
        <p>
          Age restrictions, dress codes and prohibited items are set by the
          organiser and stated on the event page where they apply.
        </p>
      </Section>

      <Section n={7} title="Accounts">
        <p>
          You do not need an account to buy a ticket. If you create one, keep
          your sign-in details to yourself — anyone with access to your email
          account can reach your tickets.
        </p>
        <p>
          You may close your account at any time from account settings. Doing so
          deletes your profile but does not cancel tickets you have already
          bought, which remain valid.
        </p>
        <p>
          We may suspend an account we reasonably believe is being used
          fraudulently, to resell tickets in breach of these terms, or to
          interfere with the service.
        </p>
      </Section>

      <Section n={8} title="For organisers">
        <p>
          If you list an event, you confirm that you have the right to run it and
          to sell tickets to it, and that the details you publish are accurate.
        </p>
        <p>
          You are responsible for the event taking place as advertised, for
          honouring valid tickets at the door, and for deciding on refunds where
          an event is cancelled or changed.
        </p>
        <p>
          Buyer details are provided to you so that you can admit people and
          contact them about that event. You may not use them for anything else,
          and you are a data controller in your own right in respect of them.
        </p>
        <p>
          Payouts are made to the M-Pesa or bank details you register, after the
          event has run, less the fee stated when you listed. We may withhold a
          payout where an event is cancelled or a dispute is open, until it is
          resolved.
        </p>
      </Section>

      <Section n={9} title="Acceptable use">
        <p>You agree not to:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>buy tickets by automated means, or in quantities intended to resell at a profit;</li>
          <li>forge, alter or duplicate a ticket;</li>
          <li>interfere with the service, or attempt to access parts of it you are not authorised to;</li>
          <li>use the service to list an event you have no right to run.</li>
        </ul>
      </Section>

      <Section n={10} title="Availability">
        <p>
          We work to keep the service available, particularly while an event is
          on sale, but we do not guarantee uninterrupted access. Maintenance,
          network failures and problems at our providers can all interrupt it.
        </p>
        <p>
          If the service is unavailable at a moment that costs you a ticket
          purchase, tell us — we would rather know than not.
        </p>
      </Section>

      <Section n={11} title="Our responsibility">
        <p>
          We are responsible for the ticketing service: taking payment correctly,
          issuing valid tickets, delivering them, and keeping your data as
          described in the Privacy Policy. Where we fail at those things, we will
          put them right.
        </p>
        <p>
          We are not responsible for the event itself, or for losses arising from
          it — travel and accommodation booked around an event that is later
          cancelled being the common example. Our liability in connection with a
          ticket is limited to the amount you paid for it.
        </p>
        <p>
          Nothing here excludes liability that cannot lawfully be excluded,
          including for fraud or for death or personal injury caused by
          negligence.
        </p>
      </Section>

      <Section n={12} title="Changes to these terms">
        <p>
          We may update these terms. The version published here when you buy a
          ticket is the version that governs that purchase, and we will tell you
          about material changes rather than quietly replacing the page.
        </p>
      </Section>

      <Section n={13} title="Governing law">
        <p>
          These terms are governed by the laws of Kenya, and the courts of Kenya
          have jurisdiction over any dispute arising from them.
        </p>
      </Section>

      <Section n={14} title="Contact">
        <p>
          For anything at all —{' '}
          <a className="text-primary underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>
          . If your question is about a specific order, include the order
          reference from your confirmation email and we will find it faster.
        </p>
      </Section>
    </LegalPage>
  );
}
