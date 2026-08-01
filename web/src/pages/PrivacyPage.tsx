/**
 * The privacy notice.
 *
 * Structured against the Data Protection Act (Cap. 411C). Section 29 sets out
 * what a controller must tell a data subject before collecting anything — the
 * rights under s.26, the fact and purpose of collection, who the data goes to,
 * the controller's contacts, the security measures, whether providing it is
 * voluntary, and what happens if it is not provided. Each of those has a
 * section here rather than being folded into prose, so a reader can find the
 * one that concerns them.
 *
 * Everything stated is true of the running system. Where the honest answer is
 * "this is not built yet" — portability, for instance — it says so rather than
 * claiming a capability that would fail on request.
 */
import { LegalPage, Row, Section } from '@/components/LegalPage';

const CONTACT = 'hello@invonicstechnologies.com';

export function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="1 August 2026"
      summary="This notice explains what personal data Eventify Tickets collects, why, who it is shared with, and the rights you hold over it under the Data Protection Act (Cap. 411C)."
    >
      <Section n={1} title="Who is responsible for your data">
        <p>
          Invonics Technologies is the data controller for personal data
          processed through Eventify Tickets at{' '}
          <span className="md-data-medium">eventify.invonicstechnologies.com</span>.
        </p>
        <p>
          For any question about this notice, or to exercise any right described
          in it, write to{' '}
          <a className="text-primary underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>
          .
        </p>
      </Section>

      <Section n={2} title="What we collect and why">
        <p>
          We collect only what is needed to sell you a ticket and get you through
          the door. Each item below is collected directly from you.
        </p>
        <dl className="mt-4">
          <Row term="Name">
            Printed on your ticket and used to identify you at the gate if a
            scan fails.
          </Row>
          <Row term="Email address">
            Where your tickets and payment confirmation are sent. It is also how
            tickets you bought as a guest are matched to an account if you later
            create one.
          </Row>
          <Row term="Phone number">
            The M-Pesa number the payment prompt is sent to, and the number an
            organiser can reach you on about a change to the event.
          </Row>
          <Row term="Payment records">
            The M-Pesa receipt, amount, and result of each transaction. We never
            see or store your M-Pesa PIN, and we do not store card details.
          </Row>
          <Row term="Ticket and admission records">
            Which tickets were issued to you and whether they were scanned at
            the gate.
          </Row>
          <Row term="Account details">
            If you create an account: your display name, phone number, and
            whether you have asked to hear about new events.
          </Row>
        </dl>
      </Section>

      <Section n={3} title="Our lawful basis">
        <p>
          Under section 30 of the Act, processing must rest on a lawful basis. Ours are:
        </p>
        <dl className="mt-4">
          <Row term="Performance of a contract">
            Your name, email, phone and payment record are processed because
            they are necessary to sell you a ticket and admit you to an event.
            Without them we cannot complete the sale.
          </Row>
          <Row term="Consent">
            Announcements about new events and flash sales are sent only if you
            have asked for them. This is separate from buying a ticket and can
            be withdrawn at any time.
          </Row>
          <Row term="Legal obligation">
            Records of completed transactions are retained to meet tax and
            accounting requirements.
          </Row>
        </dl>
      </Section>

      <Section n={4} title="Whether you have to provide it">
        <p>
          Your name, email address and M-Pesa number are mandatory for a
          purchase. If you do not provide them, the sale cannot be completed —
          there would be no way to charge you, issue a ticket, or admit you.
        </p>
        <p>
          Everything else is voluntary. Creating an account, saving a phone
          number to your profile, and receiving announcements are all optional,
          and declining any of them does not affect your ability to buy tickets
          or use them.
        </p>
      </Section>

      <Section n={5} title="Who else receives your data">
        <p>
          We do not sell personal data, and we do not share it for anyone else's
          marketing. It reaches the following processors only so far as each
          needs it to do its job:
        </p>
        <dl className="mt-4">
          <Row term="Safaricom (M-Pesa)">
            Receives your phone number and the amount in order to process
            payment. Safaricom is the controller of its own payment records.
          </Row>
          <Row term="Google (Firebase Authentication)">
            Handles sign-in if you create an account, and holds your email
            address and verification status for that purpose. We never receive
            your password.
          </Row>
          <Row term="Brevo">
            Sends your tickets, confirmations and — if you asked for them —
            announcements. Receives your email address and name.
          </Row>
          <Row term="Railway and Cloudflare">
            Host the service and carry traffic to it. Data is stored in the
            hosting provider's infrastructure and protected in transit.
          </Row>
          <Row term="Event organisers">
            The organiser of an event you bought a ticket to receives your name
            and the tickets issued, so they can admit you and contact you about
            that event. They may not use it for anything else.
          </Row>
        </dl>
      </Section>

      <Section n={6} title="Transfers outside Kenya">
        <p>
          Some of the providers above operate infrastructure outside Kenya, and
          your data is therefore stored and processed abroad. Section 25(h) of
          the Act permits this where there are adequate safeguards. Ours are
          contractual data-processing terms with each provider, encryption of
          data in transit, and access limited to the personnel who need it.
        </p>
        <p>
          If you would like details of the safeguards applying to a particular
          provider, write to us and we will supply them.
        </p>
      </Section>

      <Section n={7} title="How long we keep it">
        <p>
          Ticket and payment records are kept for seven years from the date of
          the transaction, which is the period tax and accounting rules require.
          They are records of a completed sale and cannot be deleted on request
          while that period runs.
        </p>
        <p>
          Your account profile — name, phone number and preferences — is kept
          until you close your account, at which point it is deleted. Closing an
          account does not cancel tickets you have already bought: they remain
          valid at the gate and the links in your confirmation emails keep
          working.
        </p>
        <p>
          If you unsubscribe from announcements, we keep a record of the
          unsubscribe itself so that we do not email you again.
        </p>
      </Section>

      <Section n={8} title="Your rights">
        <p>Under section 26 of the Act you have the right:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>to be told how your personal data is used — which is what this notice is for;</li>
          <li>to obtain a copy of the personal data we hold about you;</li>
          <li>to object to processing, in whole or in part;</li>
          <li>to have inaccurate or misleading data corrected; and</li>
          <li>to have false or misleading data about you deleted.</li>
        </ul>
        <p className="pt-2">
          You can exercise most of these yourself. Your account page shows the
          orders and tickets held against you; account settings let you correct
          your name and phone number, and turn announcements off; and the same
          page lets you close your account and delete your profile outright.
        </p>
        <p>
          For anything you cannot do from those screens — including a copy of
          your data in a portable format — write to{' '}
          <a className="text-primary underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>{' '}
          and we will respond within thirty days.
        </p>
      </Section>

      <Section n={9} title="Consent, and withdrawing it">
        <p>
          Where we rely on your consent, it is asked for separately and is never
          bundled with anything else. Agreeing to our terms is not agreeing to
          marketing, and you can buy a ticket without accepting either
          announcements or any optional storage on your device.
        </p>
        <p>
          You may withdraw consent at any time — from account settings, or from
          the unsubscribe link at the foot of every announcement. Withdrawing it
          does not affect anything lawfully done beforehand.
        </p>
      </Section>

      <Section n={10} title="Cookies and storage on your device">
        <p>
          We do not use advertising or tracking cookies, and we do not run
          third-party analytics.
        </p>
        <p>
          The service stores a small amount of data on your device to function:
          your light or dark theme preference, and — if you sign in — the session
          that keeps you signed in. These are strictly necessary, in the sense
          that the service cannot work as intended without them.
        </p>
        <p>
          If we ever introduce anything beyond that, it will be asked for
          separately and will be off unless you turn it on.
        </p>
      </Section>

      <Section n={11} title="Children">
        <p>
          Eventify Tickets is not intended for children, and we do not knowingly
          collect personal data from anyone under eighteen without the consent of
          a parent or guardian. If you believe a child's data has been collected,
          write to us and we will delete it.
        </p>
      </Section>

      <Section n={12} title="How we protect your data">
        <p>
          Traffic is encrypted in transit. Tickets carry a cryptographic
          signature, so a forged or altered ticket fails verification at the
          gate. Every change to an order is written to an append-only,
          hash-chained ledger the application cannot rewrite, which means an
          alteration to a payment record is detectable rather than merely
          prohibited. Administrative access is restricted and separately
          authenticated.
        </p>
        <p>
          No system is immune. If a breach occurs that presents a real risk to
          your rights and freedoms, we will notify the Data Commissioner and, where
          the Act requires it, you — describing what happened and what to do.
        </p>
      </Section>

      <Section n={13} title="Automated decisions">
        <p>
          We do not make decisions about you by automated means that produce
          legal effects or otherwise significantly affect you. Payment approval
          is made by Safaricom, not by us, and ticket allocation is first come,
          first served.
        </p>
      </Section>

      <Section n={14} title="Complaints">
        <p>
          If you are unhappy with how we have handled your personal data, tell us
          first at{' '}
          <a className="text-primary underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>{' '}
          — most things are quickest to fix directly.
        </p>
        <p>
          You also have the right to complain to the Office of the Data
          Protection Commissioner, which regulates data protection in Kenya,
          whether or not you have raised it with us.
        </p>
      </Section>

      <Section n={15} title="Changes to this notice">
        <p>
          If this notice changes materially, we will publish the new version here
          with a new date and, where the change affects something you consented
          to, ask you again rather than assume the old answer still stands.
        </p>
      </Section>
    </LegalPage>
  );
}
