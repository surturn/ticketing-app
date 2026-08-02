/**
 * Help.
 *
 * Organised by what someone is trying to do, not by which screen they are on —
 * a person looking for help does not know the name of the page they are stuck
 * on, they know what they were trying to achieve and that it did not work.
 *
 * The button examples are the real components rather than screenshots. That is
 * a deliberate trade: a screenshot is a photograph of a version of the product,
 * and it starts lying the day anything changes — including the shape of the
 * buttons, which changed this week. Rendering the actual component means this
 * page cannot fall out of step with the app, weighs nothing, works in both
 * themes, and can be read by a screen reader.
 */
import { Link } from 'react-router-dom';
import { Badge, Button, ButtonLink, Card } from '@/components/ui';
import { WhatsAppButton, WHATSAPP_DISPLAY } from '@/components/WhatsAppButton';
import type { ReactNode } from 'react';

const CONTACT = 'hello@invonicstechnologies.com';

function Topic({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="md-title-large">{title}</h2>
      <div className="md-body-large mt-3 space-y-3 text-on-surface-variant">
        {children}
      </div>
    </section>
  );
}

/**
 * A control, shown as itself, beside what it does.
 *
 * `pointer-events-none` on the example: it is an illustration, and a help page
 * that started a checkout because someone tapped the picture of a button would
 * be its own support ticket.
 */
function Control({ example, children }: { example: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-outline-variant/60 py-4">
      <div className="pointer-events-none shrink-0" aria-hidden="true">
        {example}
      </div>
      <p className="md-body-medium min-w-[14rem] flex-1 text-on-surface-variant">
        {children}
      </p>
    </div>
  );
}

export function HelpPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-10">
        <h1 className="md-headline-large">Help</h1>
        <p className="md-body-large mt-4 text-on-surface-variant">
          Most things are on this page. If yours is not, email{' '}
          <a className="text-primary underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>{' '}
          — a person reads it.
        </p>
      </header>

      {/* The single most common reason anyone opens a help page, so it is
          first rather than buried under an introduction. */}
      <Card className="mb-10 p-6">
        <h2 className="md-title-large">My ticket has not arrived</h2>
        <p className="md-body-medium mt-3 text-on-surface-variant">
          Check the spam or promotions folder first — that is where it is
          roughly nine times in ten. Search for the word{' '}
          <span className="md-data-medium text-on-surface">Eventify</span>.
        </p>
        <p className="md-body-medium mt-2 text-on-surface-variant">
          If it is genuinely not there, your tickets do not depend on that email.
          Sign in with the address you bought with and they will be under{' '}
          <strong className="text-on-surface">My tickets</strong>, even if you
          bought as a guest.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <ButtonLink to="/account">Find my tickets</ButtonLink>
          {/* Ahead of email, because someone reading this is usually at a gate.
              The prefill saves them explaining the situation from scratch. */}
          <WhatsAppButton
            variant="outlined"
            prefill="Hi Eventify — I paid but my ticket has not arrived."
          >
            WhatsApp us
          </WhatsAppButton>
          <a
            href={`mailto:${CONTACT}?subject=Missing%20ticket`}
            className="md-state md-label-large trimmed inline-flex h-12 items-center justify-center border border-outline px-6 text-on-surface"
          >
            <span className="md-state-layer" aria-hidden="true" />
            <span className="relative">Email us</span>
          </a>
        </div>
      </Card>

      <div className="space-y-10">
        <Topic id="buying" title="Buying a ticket">
          <p>
            Open the event, choose how many of each ticket type you want, then
            fill in your name, email and M-Pesa number. The buttons you will
            meet, in order:
          </p>

          <div className="mt-4">
            <Control
              example={
                <div className="trimmed flex items-center gap-1 border border-outline-variant bg-surface p-1">
                  <span className="flex size-12 items-center justify-center rounded-full text-lg text-on-surface-variant">
                    −
                  </span>
                  <span className="md-data-large w-8 text-center">2</span>
                  <span className="flex size-12 items-center justify-center rounded-full text-lg text-on-surface-variant">
                    +
                  </span>
                </div>
              }
            >
              Adds or removes one ticket of that type. The minus is greyed out at
              zero, and the plus stops at the per-order limit the organiser set.
            </Control>

            <Control example={<Button>Review order</Button>}>
              Checks your basket and shows the exact total and the number the
              payment prompt will go to. Nothing is charged and no ticket is
              held yet — this is the step where a mistyped phone number shows
              up, as the number it will actually be.
            </Control>

            <Control example={<Button>Pay with M-Pesa</Button>}>
              Sends the payment request to your phone. Your tickets are held from
              this moment for a few minutes while you enter your PIN.
            </Control>

            <Control example={<Badge tone="gone">Sold out</Badge>}>
              That ticket type has gone. The event stays listed because other
              types may still be available.
            </Control>
          </div>
        </Topic>

        <Topic id="paying" title="Paying, and when it goes wrong">
          <p>
            After you tap pay, a prompt appears on your phone. Enter your M-Pesa
            PIN and the page updates on its own — you do not need to refresh or
            do anything else.
          </p>
          <p>
            <strong className="text-on-surface">
              The prompt says INVONICS TECHNOLOGIES, not Eventify.
            </strong>{' '}
            That is us. Invonics Technologies builds and operates Eventify
            Tickets, and it is the name registered with Safaricom, so it is what
            M-Pesa shows on the request and on your statement. Nothing has gone
            wrong.
          </p>
          <p>
            <strong className="text-on-surface">The prompt never arrived.</strong>{' '}
            It expires after about a minute. Nothing has been charged and your
            tickets are still held, so start the payment again.
          </p>
          <p>
            <strong className="text-on-surface">You closed the page.</strong>{' '}
            Your order is safe. Reopen the link from your confirmation, or find
            it under My tickets.
          </p>
          <p>
            <strong className="text-on-surface">
              Money left your account but no ticket arrived.
            </strong>{' '}
            Email us with the M-Pesa message and we will either issue the ticket
            or refund you in full. That one is ours to fix, not yours to chase.
          </p>
        </Topic>

        <Topic id="gate" title="Getting in on the night">
          <p>
            Open your ticket and show the QR code at the door. It works with no
            signal once the page has been opened, so open it before you leave
            rather than in a queue.
          </p>
          <p>
            Each ticket is scanned once. If you bought several, everyone needs
            their own — one code cannot admit two people.
          </p>
          <p>
            If a scanner will not read it, the code printed underneath can be
            typed in by hand. Screen brightness up usually solves it.
          </p>
        </Topic>

        <Topic id="account" title="Your account">
          <p>
            You do not need one to buy a ticket, but it keeps everything in one
            place if you change phone or lose an email.
          </p>

          <div className="mt-4">
            <Control example={<Button variant="tonal">Sign in</Button>}>
              In the top bar. Signing in with the address you bought with pulls
              in tickets you already own, including guest purchases.
            </Control>

            <Control example={<Button variant="outlined">Account settings</Button>}>
              Change your name, your M-Pesa number, and whether we email you
              about new events. Your email address cannot be changed here —
              it is what your existing tickets are matched against.
            </Control>

            <Control example={<Button variant="danger">Sign out</Button>}>
              Ends the session on this device. Your tickets stay in your account
              and in your email.
            </Control>
          </div>

          <p className="pt-2">
            Closing your account deletes your name, phone number and email.
            Tickets you have already bought stay valid — see the{' '}
            <Link to="/privacy" className="text-primary underline">
              privacy notice
            </Link>{' '}
            for exactly what is kept and for how long.
          </p>
        </Topic>

        <Topic id="emails" title="Emails from us">
          <p>
            Ticket confirmations are always sent — they are part of the purchase,
            not marketing, and cannot be turned off.
          </p>
          <p>
            Announcements about new events and flash sales are separate and only
            go to people who asked for them. Turn them on or off in account
            settings, or use the unsubscribe link at the foot of any
            announcement.
          </p>
        </Topic>

        <Topic id="refunds" title="Refunds and cancelled events">
          <p>
            If an event is cancelled you are entitled to a refund of the ticket
            price, sent back to the M-Pesa number you paid from.
          </p>
          <p>
            If the date or venue changes, the organiser decides whether tickets
            stay valid or can be refunded, and we will tell you which.
          </p>
          <p>
            Otherwise tickets are generally non-refundable once issued, because
            the seat is no longer available to anyone else. The{' '}
            <Link to="/terms" className="text-primary underline">
              terms
            </Link>{' '}
            set this out in full.
          </p>
        </Topic>

        <Topic id="organisers" title="Listing your own event">
          <p>
            See{' '}
            <Link to="/host" className="text-primary underline">
              hosting an event
            </Link>{' '}
            for what it costs and how it works.
          </p>
        </Topic>
      </div>

      <Card className="mt-12 p-6">
        <h2 className="md-title-large">Still stuck</h2>
        <p className="md-body-medium mt-3 text-on-surface-variant">
          The quickest way to reach us is WhatsApp — {WHATSAPP_DISPLAY}. Email{' '}
          <a className="text-primary underline" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>{' '}
          works too. Either way, if it is about a particular order, include the
          reference from your confirmation email — it looks like{' '}
          <span className="md-data-medium text-on-surface">TKT-8F3KQ2XA</span> —
          and we will find it straight away.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <WhatsAppButton prefill="Hi Eventify — I need help with an order." />
          <a
            href={`mailto:${CONTACT}`}
            className="md-state md-label-large trimmed inline-flex h-12 items-center justify-center border border-outline px-6 text-on-surface"
          >
            <span className="md-state-layer" aria-hidden="true" />
            <span className="relative">Email us</span>
          </a>
        </div>
      </Card>
    </div>
  );
}
