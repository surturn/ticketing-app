/**
 * An order, from "check your phone" to "here are your tickets".
 *
 * This page is the one buyers bookmark, forward, and reopen at the gate, so it
 * has to be correct on a cold load with no memory of the checkout that made it.
 * Everything it shows is fetched from the reference in the URL.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import confetti from 'canvas-confetti';
import { AnimatePresence, motion } from 'framer-motion';
import {
  fetchOrder,
  fetchOrderStatus,
  isTerminal,
  type OrderDetail,
  type OrderStatus,
} from '@/lib/api';
import { formatCountdown, formatMoney } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { TicketStub } from '@/components/TicketStub';
import { Button, ButtonLink, Card, ErrorState, Skeleton } from '@/components/ui';
import { LeaveCheckoutDialog } from '@/components/LeaveCheckoutDialog';

/** Poll interval while a payment is in flight. */
const POLL_MS = 3000;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The celebration.
 *
 * Gold and electric blue, two seconds, fired once. Skipped entirely under
 * reduced-motion — a burst of particles is exactly what that setting exists to
 * suppress, and the tickets below are the actual payload either way.
 */
/** Canvas needs literal colours, so the tones are read off the token layer at
 *  call time rather than duplicated as hexes here. */
function tone(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function celebrate(): void {
  if (prefersReducedMotion()) return;

  // A four-core phone is the target device, not the exception. Particles are
  // the first thing to cut when there is no headroom for them — the tickets
  // below are the actual payload either way.
  if ((navigator.hardwareConcurrency ?? 8) <= 4) return;

  const colors = [tone('--gold-70'), tone('--blue-50'), tone('--gold-80'), tone('--blue-60')];

  // Capped at 40 across the whole burst.
  const TOTAL = 40;

  const shoot = (particleRatio: number, opts: confetti.Options) => {
    void confetti({
      origin: { y: 0.35 },
      colors,
      disableForReducedMotion: true,
      particleCount: Math.max(1, Math.floor(TOTAL * particleRatio)),
      ...opts,
    });
  };

  shoot(0.25, { spread: 26, startVelocity: 55 });
  shoot(0.2, { spread: 60 });
  shoot(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
  shoot(0.2, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
}

/**
 * A headline that assembles itself, one word every 40ms.
 *
 * Split into words rather than characters — a per-letter reveal reads as a
 * typewriter effect, which is a different and much cheaper feeling than a
 * sentence arriving. Rendered as a single string for assistive technology so
 * the announcement is not fragmented into two dozen separate labels.
 */
function StaggeredWords({ text }: { text: string }) {
  const reduced = prefersReducedMotion();

  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {text.split(' ').map((word, index) => (
          <motion.span
            key={`${word}-${index}`}
            className="inline-block"
            initial={reduced ? undefined : { opacity: 0, y: 12 }}
            animate={reduced ? undefined : { opacity: 1, y: 0 }}
            transition={{
              type: 'spring',
              stiffness: 200,
              damping: 15,
              delay: 0.18 + index * 0.04,
            }}
          >
            {word}
            {/* A non-breaking space inside the animated span, so the gap
                travels with the word instead of collapsing between two
                inline-blocks. */}
            {index < text.split(' ').length - 1 ? ' ' : ''}
          </motion.span>
        ))}
      </span>
    </>
  );
}

// ─── Waiting for the M-Pesa prompt ─────────────────────────────────────────

/** How long an STK prompt realistically stays on the handset. */
const STK_WINDOW_MS = 60_000;

/**
 * The circular countdown on the STK screen.
 *
 * A ring rather than a spinner, because the two say different things: a spinner
 * means "something is happening", a ring means "you have this long", and the
 * second is the only one that is true here. Drawn with a stroke offset so the
 * arc is a pure paint change per second — no layout, no reflow.
 */
function CountdownRing({ fraction, label }: { fraction: number; label: string }) {
  const RADIUS = 30;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  return (
    <div className="relative mx-auto size-20">
      <svg viewBox="0 0 68 68" className="size-full -rotate-90" aria-hidden="true">
        <circle
          cx="34"
          cy="34"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          className="text-outline-variant"
        />
        <circle
          cx="34"
          cy="34"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          className="text-primary"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, fraction)))}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>

      <span className="md-data-large absolute inset-0 flex items-center justify-center text-on-surface">
        {label}
      </span>
    </div>
  );
}

function AwaitingPayment({
  expiresAt,
  reference,
  amount,
}: {
  expiresAt: string | null;
  reference: string;
  amount: string;
}) {
  const [remaining, setRemaining] = useState(() =>
    expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0,
  );
  // Counts the prompt itself, not the inventory hold: the two are different
  // clocks and conflating them is what makes these screens lie. The hold runs
  // for minutes; the prompt on the handset is gone in about a minute.
  const [sinceSent, setSinceSent] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setSinceSent(Date.now() - started);
      if (expiresAt) setRemaining(new Date(expiresAt).getTime() - Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const promptLeft = Math.max(0, STK_WINDOW_MS - sinceSent);
  const promptExpired = promptLeft === 0;

  return (
    <Card className="p-8 text-center">
      {promptExpired ? (
        // Not an error, and never dressed as one: nothing was charged, the hold
        // is still running, and the only thing that happened is that a prompt
        // timed out. Apologising here would invent a problem.
        <>
          <h1 className="md-headline-small text-on-surface">That request expired.</h1>
          <p className="md-body-medium mx-auto mt-2 max-w-sm text-on-surface-variant">
            No money left your account. Your tickets are still held — start the
            payment again and we will send a fresh prompt.
          </p>
        </>
      ) : (
        <>
          <CountdownRing
            fraction={promptLeft / STK_WINDOW_MS}
            label={String(Math.ceil(promptLeft / 1000))}
          />

          <h1 className="md-headline-small mt-6 text-on-surface">Check your phone</h1>
          <p className="md-body-large mx-auto mt-2 max-w-sm text-on-surface-variant">
            Enter your M-Pesa PIN to pay{' '}
            <span className="md-data-medium text-on-surface">{amount}</span>.
          </p>

          <p className="md-data-medium mt-6 text-on-surface-variant" aria-live="polite">
            Waiting for confirmation…
          </p>

          {/* Repeated here because this is the screen someone is looking at
              while the unfamiliar name is on their phone. */}
          <p className="md-body-small mt-4 text-on-surface-variant">
            The request shows{' '}
            <span className="md-data-small text-on-surface">INVONICS TECHNOLOGIES</span>,
            who operate Eventify.
          </p>
        </>
      )}

      {remaining > 0 && (
        <p className="md-body-medium mt-6 text-on-surface-variant">
          Your tickets are held for{' '}
          <span className="md-data-medium text-on-surface">
            {formatCountdown(remaining)}
          </span>
        </p>
      )}

      <p className="md-data-small mt-6 text-on-surface-variant">
        Order {reference} · keep this page open
      </p>
    </Card>
  );
}

// ─── Terminal failure ──────────────────────────────────────────────────────

const FAILURE_COPY: Record<string, { title: string; body: string }> = {
  failed: {
    title: 'That payment did not go through',
    body: 'Nothing was charged and your seats have been released. You can try again — the tickets are back on sale.',
  },
  expired: {
    title: 'The hold ran out',
    body: 'We could not confirm the payment in time, so the seats went back on sale. Nothing was charged.',
  },
  cancelled: {
    title: 'This order was cancelled',
    body: 'Nothing was charged. You can start again whenever you are ready.',
  },
};

function FailedOrder({ status, eventSlug }: { status: OrderStatus; eventSlug: string }) {
  const copy = FAILURE_COPY[status] ?? FAILURE_COPY.failed!;

  return (
    <Card className="p-8 text-center">
      <h1 className="md-headline-small text-on-surface">{copy.title}</h1>
      <p className="md-body-large mx-auto mt-2 max-w-md text-on-surface-variant">
        {copy.body}
      </p>
      {/* The recovery path is the primary action — a dead end here is a lost
          sale from someone who had already decided to buy. */}
      <div className="mt-8">
        <ButtonLink to={`/events/${eventSlug}`}>Try again</ButtonLink>
      </div>
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export function OrderPage() {
  const { reference = '' } = useParams();

  const { data, loading, error, reload } = useAsync(
    () => fetchOrder(reference),
    [reference],
  );

  const [live, setLive] = useState<OrderDetail | null>(null);
  const order = live ?? data?.order ?? null;
  const celebrated = useRef(false);

  // Poll only while there is something to wait for, and stop the moment the
  // order reaches a state it can never leave.
  useEffect(() => {
    if (!order || isTerminal(order.status)) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const status = await fetchOrderStatus(reference);
        if (cancelled) return;

        if (isTerminal(status.status)) {
          clearInterval(timer);
          // The status poll is deliberately lightweight and carries no tickets,
          // so a terminal status means re-fetching the full order.
          const full = await fetchOrder(reference);
          if (!cancelled) setLive(full.order);
        }
      } catch {
        // Swallowed on purpose: a dropped poll is not worth an error screen
        // over a payment that is probably still fine. The next tick retries.
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [order, reference]);

  // Fires once, on the transition into paid.
  useEffect(() => {
    if (order?.status === 'paid' && order.tickets.length > 0 && !celebrated.current) {
      celebrated.current = true;
      celebrate();
    }
  }, [order]);

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-48 w-full rounded-md" />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState
          title="We could not find that order"
          body={error ?? 'Check the link, or search your email for the confirmation.'}
          onRetry={reload}
        />
      </div>
    );
  }

  const paid = order.status === 'paid';

  /**
   * The seats are genuinely reserved, and the clock is genuinely running.
   *
   * Both conditions are required. `awaiting_payment` alone is not enough — an
   * order whose hold has already lapsed has nothing left to lose, and warning
   * someone about seats that are already back on sale would be telling them
   * something untrue to keep them on the page.
   */
  const holdIsLive =
    order.status === 'awaiting_payment' &&
    order.expiresAt !== null &&
    new Date(order.expiresAt).getTime() > Date.now();

  return (
    <div className="mx-auto max-w-2xl">
      <LeaveCheckoutDialog active={holdIsLive} expiresAt={order.expiresAt} />

      <AnimatePresence mode="wait">
        {paid ? (
          <motion.div
            key="paid"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            <header className="mb-8 text-center">
              <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="md-eyebrow text-tertiary"
              >
                Payment confirmed
              </motion.p>

              {/* Revealed a word at a time, 40ms apart. The stagger is the
                  point: the sentence assembles itself rather than appearing,
                  which is what makes this read as an arrival. */}
              <h1 className="md-headline-large mt-2 text-on-surface">
                <StaggeredWords text="You're going to the show." />
              </h1>

              <p className="md-body-large mt-3 text-on-surface-variant">
                {order.tickets.length === 1
                  ? 'Your ticket is below, and on its way to '
                  : `All ${order.tickets.length} tickets are below, and on their way to `}
                <span className="text-on-surface">{order.buyer.email}</span>
              </p>
            </header>

            {/* The one moment gold appears on a consumer surface: a single
                radial pulse behind the tickets as they land, marking the
                transition from buying to owning. It fires once and never
                loops — a glow that repeats is decoration, and this is not. */}
            <div className="relative">
              <div className="gold-glow" aria-hidden="true" />

              <div className="relative space-y-4">
                {order.tickets.map((ticket, index) => (
                  <TicketStub
                    key={ticket.id}
                    ticket={ticket}
                    eventName={order.event.name}
                    startsAt={order.event.startsAt}
                    venue={order.event.venue}
                    // The order payload carries no timezone, and the venue is
                    // the one the event is actually in.
                    timezone="Africa/Nairobi"
                    index={index}
                  />
                ))}
              </div>
            </div>

            {/* Receipt: quiet, factual, and below the celebration rather than
                competing with it. */}
            <Card className="mt-8 p-5">
              <div className="flex justify-between gap-4">
                <span className="md-body-medium text-on-surface-variant">Order</span>
                <span className="md-data-medium text-on-surface">{order.reference}</span>
              </div>
              <div className="mt-2 flex justify-between gap-4">
                <span className="md-body-medium text-on-surface-variant">Paid</span>
                <span className="md-data-medium text-on-surface">
                  {formatMoney(order.totalCents, order.currency)}
                </span>
              </div>
              {order.payment?.receipt && (
                <div className="mt-2 flex justify-between gap-4">
                  <span className="md-body-medium text-on-surface-variant">
                    M-Pesa receipt
                  </span>
                  <span className="md-data-medium text-on-surface">
                    {order.payment.receipt}
                  </span>
                </div>
              )}
            </Card>

            <div className="mt-6 flex justify-center gap-3">
              <Button variant="outlined" onClick={() => window.print()}>
                Print tickets
              </Button>
              <ButtonLink to="/" variant="text">
                Back to events
              </ButtonLink>
            </div>
          </motion.div>
        ) : isTerminal(order.status) ? (
          <motion.div key="failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <FailedOrder status={order.status} eventSlug={order.event.slug} />
          </motion.div>
        ) : (
          <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <AwaitingPayment
              expiresAt={order.expiresAt}
              reference={order.reference}
              amount={formatMoney(order.totalCents, order.currency)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
