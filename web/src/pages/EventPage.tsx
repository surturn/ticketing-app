/**
 * One event: what it is, what a ticket costs, and how to buy one.
 *
 * The purchase is two committed steps and no more — choose tickets, then enter
 * details and pay. Each extra screen between wanting a ticket and having one
 * costs sales, so there is no cart, no account requirement and no interstitial.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ApiError,
  createCheckout,
  fetchEvent,
  fetchEvents,
  fieldErrors,
  previewCheckout,
  type PreviewResponse,
} from '@/lib/api';
import { Accordion } from '@/components/Accordion';
import { EventHero } from '@/components/EventHero';
import { EventTrustStrip } from '@/components/EventTrustStrip';
import { EventRail } from '@/components/EventRail';
import { HowItWorks } from '@/components/HowItWorks';
import { LocalErrorBoundary } from '@/components/LocalErrorBoundary';
import { Section } from '@/components/Section';
import { TicketCard } from '@/components/TicketCard';
import { useToast } from '@/components/Toasts';
import { formatMoney } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { RichText } from '@/components/RichText';
import { useAuth } from '@/auth/AuthProvider';
import {
  Button,
  ButtonAnchor,
  ButtonLink,
  Card,
  ErrorState,
  Field,
  Skeleton,
} from '@/components/ui';

// ─── Validation ────────────────────────────────────────────────────────────
//
// Deliberately permissive, and duplicated from the API rather than trusted to
// it. This exists to spare the buyer a round-trip for an obvious typo; the API
// remains the authority and re-validates everything.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** 07…, 01…, 2547…, +2541… — every way a Kenyan number is normally written. */
const PHONE = /^(?:\+?254|0)?[17]\d{8}$/;

function normalisePhoneForDisplay(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

// ─── Page ──────────────────────────────────────────────────────────────────

export function EventPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data, loading, error, reload } = useAsync(() => fetchEvent(slug), [slug]);
  const event = data?.event;

  // The full listing is already cached by the homepage in most sessions, and a
  // failure here must not touch the page the buyer came for — so it fails to an
  // empty list and the section simply does not render.
  const { data: listing } = useAsync(fetchEvents);

  const related = useMemo(() => {
    const all = listing?.events ?? [];
    if (!event) return [];
    const sameCategory = all.filter(
      (e) => e.slug !== event.slug && e.category && e.category === event.category,
    );
    // Falls back to whatever is on next rather than showing nothing: someone at
    // the bottom of an event page is still browsing.
    const pool = sameCategory.length >= 3 ? sameCategory : all.filter((e) => e.slug !== event.slug);
    return pool.slice(0, 10);
  }, [listing, event]);

  const { notify } = useToast();
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const [posterFailed, setPosterFailed] = useState(false);
  // Collapsed by default — the header's job is to get someone to the tiers
  // below it, and a long pitch in the way of that is a scroll before a
  // decision. Only offered as a toggle when there is enough text for
  // collapsing to matter; a two-line description just renders as written.
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  /**
   * The preview, tagged with what it was priced for.
   *
   * Storing the key alongside the value — rather than trusting the caller to
   * have checked it before writing — is what lets every *reader* below be the
   * enforcement point instead of every *writer*. See `currentPreview`.
   */
  const [preview, setPreview] = useState<{ key: string; value: PreviewResponse } | null>(null);
  const [working, setWorking] = useState<'preview' | 'paying' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Per-field objections from the server, keyed by field name. */
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  // The "Confirm details" modal, and its own copies of email/phone — editable
  // right up to the moment of paying, independent of the fields above until
  // confirmed. Terms acceptance is no longer a checkbox: completing this
  // step, with the notice below the Confirm button, is the act of accepting.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [modalEmail, setModalEmail] = useState('');
  const [modalPhone, setModalPhone] = useState('');
  const [modalTouched, setModalTouched] = useState<Record<string, boolean>>({});

  const posterVisible = Boolean(event?.posterUrl) && !posterFailed;

  /**
   * One key per basket, minted once and kept until the basket changes.
   *
   * This is what makes a retry safe: the same key returns the original order
   * instead of reserving a second set of seats and sending a second prompt.
   * Regenerating it per attempt would defeat the entire mechanism.
   */
  const items = useMemo(
    () =>
      Object.entries(basket)
        .filter(([, quantity]) => quantity > 0)
        .map(([tierId, quantity]) => ({ tierId, quantity })),
    [basket],
  );

  const basketKey = useMemo(
    () => items.map((i) => `${i.tierId}x${i.quantity}`).sort().join('|'),
    [items],
  );

  const idempotencyKey = useMemo(
    () => (basketKey ? `${slug}:${basketKey}:${crypto.randomUUID()}` : ''),
    // A new key only when the basket itself changes — not on re-render, and not
    // per attempt.
    [slug, basketKey],
  );

  const totalCents = useMemo(() => {
    if (!event) return 0;
    return items.reduce((sum, item) => {
      const tier = event.tiers.find((t) => t.id === item.tierId);
      return sum + (tier ? tier.priceCents * item.quantity : 0);
    }, 0);
  }, [event, items]);

  const ticketCount = items.reduce((sum, item) => sum + item.quantity, 0);

  /**
   * Client checks first, then whatever the server objected to.
   *
   * The local rules are for the obvious cases and run on blur, so a buyer is not
   * told they are wrong halfway through typing. `serverErrors` fills in what
   * only the server can know — a domain that does not accept mail, a number
   * outside the ranges Safaricom issues — and it is applied per field rather
   * than as a banner, because "the request is not valid" above five inputs
   * leaves the buyer to guess which one to fix.
   */
  const errors = {
    name:
      (touched.name && name.trim().length < 2 ? 'Please enter your full name.' : null) ??
      serverErrors.name ??
      null,
    email:
      (touched.email && !EMAIL.test(email.trim())
        ? 'That address looks incomplete — check for a missing letter.'
        : null) ??
      serverErrors.email ??
      null,
    phone:
      (touched.phone && !PHONE.test(normalisePhoneForDisplay(phone))
        ? 'Use the number your M-Pesa is on, like 0712 345 678.'
        : null) ??
      serverErrors.phone ??
      null,
  };

  const detailsComplete =
    name.trim().length >= 2 &&
    EMAIL.test(email.trim()) &&
    PHONE.test(normalisePhoneForDisplay(phone));

  /**
   * While the confirm modal is open, its own email/phone fields are what will
   * actually be charged — `handleConfirm` builds its request from
   * `modalEmail`/`modalPhone` directly, never from these. If this stayed
   * keyed to the page's own fields regardless, editing an email inside the
   * modal would leave the preview below it priced for the address the buyer
   * is no longer looking at: `previewKey` would not move, so nothing would
   * invalidate the stale preview, and "Confirm & pay" would stay lit for
   * details that do not match what is about to be sent.
   */
  const buyer = {
    name: name.trim(),
    email: (confirmOpen ? modalEmail : email).trim(),
    phone: normalisePhoneForDisplay(confirmOpen ? modalPhone : phone),
  };

  /**
   * What a preview is actually priced against — not just the basket, but the
   * buyer too. A preview is a promise about two things at once: how much,
   * and whose handset gets the M-Pesa prompt. Either one moving under it
   * makes the preview on screen a lie, which is the failure mode both bugs
   * below come from — one where the basket moved, one where the buyer did.
   *
   * Encoded with `JSON.stringify` rather than joined with a separator
   * character. A `|`-joined string collides: a buyer named `Jane|07123456789`
   * with an empty next field produces the same key as one named `Jane` whose
   * phone is `07123456789` — two different orders that hash identically,
   * which lets a real change in what is being charged hide behind a key that
   * did not appear to move. `JSON.stringify` on the array preserves each
   * field's boundary (its own quoting and length-prefixing per element), so
   * no value a buyer can type in a name, email or phone field can forge a
   * collision with another set of values.
   */
  const previewKey = JSON.stringify([basketKey, buyer.name, buyer.email, buyer.phone]);

  /**
   * The preview, but only while it still describes what is on screen.
   *
   * This is the actual fix, not the ref guard below. Every consumer in this
   * component reads `currentPreview`, never `preview` — so a stale preview
   * (basket or buyer moved on since it was priced) does not merely get
   * caught before being written, it stops existing as far as the UI is
   * concerned the instant `previewKey` changes, on the very same render. A
   * bug that skips the write-side guard, or a future call site that forgets
   * it exists, still cannot display or charge a stale figure, because there
   * is no code path that reads `preview` directly. Filtering at the point of
   * use turns "guard every writer" into "there is only one reader, and it is
   * already correct."
   */
  const currentPreview = preview && preview.key === previewKey ? preview.value : null;

  /**
   * `handleReview` closes over whatever `previewKey` was at the moment it was
   * called, and that closure does not update when the buyer changes the
   * basket or their details while the request is in flight — state updates
   * schedule a re-render, they do not reach back into a promise that is
   * already awaiting. A ref is the one thing that can be read fresh at
   * resolution time regardless of which render's closure is doing the
   * reading, which is exactly what "is this response still current"
   * requires.
   */
  const previewKeyRef = useRef(previewKey);
  useEffect(() => {
    previewKeyRef.current = previewKey;
  }, [previewKey]);

  /**
   * Invalidates the preview on any change to what it was priced against.
   *
   * Also redundant with `currentPreview`, and also deliberately so.
   * `currentPreview` already stops a stale preview from being read the
   * instant `previewKey` changes — this effect clearing the underlying state
   * is not what prevents the bug. What it buys instead: without it, `preview`
   * would sit forever holding the last value ever fetched, tagged with a key
   * that no longer matches anything, growing more stale with every basket or
   * buyer edit the whole session through. That is a memory leak and a
   * confusing `preview` value for anything that inspects raw state, not a
   * pricing bug — `currentPreview` already made it inert — but there is no
   * reason to let dead data accumulate when clearing it is one line. This
   * also duplicates the synchronous `setPreview(null)` in the tier
   * `onChange` below on purpose — that one exists because an effect only
   * runs after the render it was scheduled by, so without it a new basket
   * would render for one frame with `preview` still holding the old value
   * (harmless now that `currentPreview` filters every read, but there is no
   * reason to rely on that alone when a one-line synchronous clear is free).
   * This effect is the net underneath it: it also covers every path that isn't a tier
   * click, chiefly the buyer editing their name, email or phone, which has
   * no equivalent synchronous handler. Do not remove either half — the
   * overlap on the basket path is deliberate, not an oversight.
   */
  useEffect(() => {
    setPreview(null);
  }, [previewKey]);

  async function handleReview() {
    // Captured now, checked after the await — see the ref effect above for
    // why a plain closure over `previewKey` cannot do this.
    const requestedKey = previewKey;
    setFailure(null);
    setServerErrors({});
    setWorking('preview');
    try {
      const result = await previewCheckout({ eventSlug: slug, items, buyer });

      // Belt and braces, deliberately redundant with `currentPreview` above.
      // `currentPreview` is what actually keeps a stale figure off the
      // screen — it filters at read time, so even a write this guard failed
      // to catch could never be displayed or charged. This check exists
      // anyway for two reasons that are about the write, not the read: (1)
      // it skips a pointless state update and re-render on every keystroke
      // typed while a preview request is in flight, and (2) it means a
      // `console.log(preview)` or a future consumer that reads the raw state
      // instead of `currentPreview` still sees something sane rather than a
      // value tagged for a basket that no longer exists. On a payment path,
      // catching the problem in two independent places is worth the few
      // extra lines even though the second one alone is sufficient.
      if (previewKeyRef.current !== requestedKey) return;

      setPreview({ key: requestedKey, value: result });
    } catch (caught) {
      // Same staleness guard on the failure path, and for the same reason: a
      // validation error from a request fired against the old basket or
      // buyer is exactly as wrong as a stale price. Attaching "that email
      // looks incomplete" to a field the buyer has since corrected is its
      // own false report, not a lesser one.
      if (previewKeyRef.current !== requestedKey) return;

      const perField = fieldErrors(caught);
      setServerErrors(perField);

      // A banner only for what could not be attached to an input. When every
      // objection has a field, repeating it above the form is noise.
      if (Object.keys(perField).length === 0) {
        setFailure(
          caught instanceof ApiError ? caught.message : 'We could not price that basket.',
        );
      }

      // A basket that cannot be priced is not the buyer's fault and not
      // something they can read off a field, so it is worth saying out loud.
      if (!(caught instanceof ApiError)) {
        notify('We could not reach the server. Check your connection and try again.');
      }
    } finally {
      // Cleared unconditionally — including when the response above turned
      // out to be stale and was discarded. `working` gates the Review
      // button's own busy state (`disabled={disabled || busy}` in Button),
      // and while it is true the buyer cannot fire a new request, but they
      // *can* still change the basket or edit their details underneath it —
      // that is precisely the race this file is guarding against. If a
      // stale response left `working` set to `'preview'`, the Review button
      // would stay disabled for a basket the buyer has already moved past,
      // with no way left to ask for a current price. Ending the in-flight
      // request's busy state is bookkeeping about the request, not about the
      // result it carried, so it is correct regardless of which one this was.
      setWorking(null);
    }
  }

  /** Opens the confirm modal and (re)prices the basket while it is open. */
  function handleCheckoutClick() {
    setModalEmail(email);
    setModalPhone(phone);
    setModalTouched({});
    setConfirmOpen(true);
    void handleReview();
  }

  async function handleConfirm() {
    const confirmedBuyer = {
      name: name.trim(),
      email: modalEmail.trim(),
      phone: normalisePhoneForDisplay(modalPhone),
    };

    setFailure(null);
    setServerErrors({});
    setWorking('paying');
    try {
      const order = await createCheckout(
        {
          eventSlug: slug,
          items,
          buyer: confirmedBuyer,
          // There is no checkbox any more — reaching this call is the act of
          // accepting, and the modal says so next to the button that triggers
          // it. Marketing consent is a separate, freely given choice and is
          // only ever collected at sign-up, never assumed here.
          acceptedTerms: true,
          marketingOptIn: false,
        },
        idempotencyKey,
      );
      // Keep the page's own fields in step with what was actually charged, in
      // case anything ever reads them again before the navigation lands.
      setEmail(modalEmail);
      setPhone(modalPhone);
      // Straight to the order page, which owns the waiting state. The prompt is
      // already on the buyer's handset by the time this navigates.
      navigate(`/orders/${order.reference}`, { state: { justCreated: true } });
    } catch (caught) {
      /**
       * Nothing is cleared here, and that is the point.
       *
       * The basket, the name, the email and the number all stay exactly as
       * typed. A buyer whose payment failed on a phone in a queue will not
       * retype three fields to try again — they leave. Re-entering the details
       * is a far larger tax than the failure itself.
       */
      const perField = fieldErrors(caught);
      setServerErrors(perField);

      if (Object.keys(perField).length === 0) {
        setFailure(
          caught instanceof ApiError
            ? caught.message
            : 'We could not start that payment. Please try again.',
        );
      }

      if (!(caught instanceof ApiError)) {
        notify('We could not reach the server. Your details are still here — try again.');
      }

      setWorking(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <div className="mt-8 space-y-4">
          <Skeleton className="h-28 w-full rounded-md" />
          <Skeleton className="h-28 w-full rounded-md" />
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <ErrorState
        title="We could not find that event"
        body={error ?? 'It may have been removed, or the link may be wrong.'}
        onRetry={reload}
      />
    );
  }

  return (
    <div>
      <EventHero
        event={event}
        posterVisible={posterVisible}
        onPosterError={() => setPosterFailed(true)}
      />

      <EventTrustStrip event={event} />

      <div className="grid gap-10 pt-8 lg:grid-cols-[1fr_380px] lg:items-start">
      <div>
        {/* The description, re-homed above the tiers now that the header it
            used to live inside is gone — and, on phones, the poster's home
            too. EventHero's floating poster is desktop-only (there's no room
            for it beside the title at phone width), so without this a mobile
            buyer would never see the artwork at all. Guarded on either
            condition, not just the description, so the heading never appears
            over nothing. */}
        {(event.description || posterVisible) && (
          <div className="mb-10">
            <h2 className="md-title-large mb-3">About this event</h2>

            {posterVisible && (
              <img
                src={event.posterUrl!}
                alt={`Poster for ${event.name}`}
                onError={() => setPosterFailed(true)}
                loading="lazy"
                className="mb-5 aspect-4/5 w-full max-w-56 rounded-md object-cover sm:hidden"
              />
            )}

            {event.description && (
              <div className="max-w-2xl">
                <RichText
                  text={event.description}
                  className={`md-body-large text-on-surface-variant ${
                    descriptionExpanded ? '' : 'line-clamp-4'
                  }`}
                />

                {/* A rough length rather than a measured overflow — this only
                    has to be right for the common case, and a toggle that
                    appears under a description short enough to already fit
                    costs nothing but a wasted tap. */}
                {event.description.length > 220 && (
                  <button
                    type="button"
                    onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                    aria-expanded={descriptionExpanded}
                    className="md-label-large mt-2 cursor-pointer text-primary hover:underline"
                  >
                    {descriptionExpanded ? 'Show less' : 'Read more'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <h2 className="md-title-large mb-5">Choose your tickets</h2>

        <div className="space-y-3">
          {event.tiers.map((tier) => (
            <TicketCard
              key={tier.id}
              tier={tier}
              quantity={basket[tier.id] ?? 0}
              onChange={(next) => {
                setBasket((current) => ({ ...current, [tier.id]: next }));
                // Any change invalidates a priced preview — showing yesterday's
                // total next to today's basket is worse than showing none.
                setPreview(null);
              }}
            />
          ))}
        </div>

        {/* The questions stay visible; only the answers cost space. */}
        <div className="mt-12">
          <Accordion
            label="Venue"
            summary={event.venue ?? 'To be confirmed'}
            icon={<IconPin />}
          >
            <p>{event.venue ?? 'The organiser has not published a venue yet.'}</p>
            {event.venue && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.venue)}`}
                target="_blank"
                rel="noreferrer noopener"
                className="md-label-large mt-3 inline-flex text-primary underline"
              >
                Open in Maps
              </a>
            )}
          </Accordion>

          <Accordion
            label="Hosted by"
            summary={event.organiser.name}
            icon={<IconPeople />}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="md-title-medium text-on-surface">
                {event.organiser.name}
              </span>
              {/* Only when true. There is no "unverified" badge — labelling an
                  organiser unverified on the page selling their tickets is a
                  claim we would be publishing on their behalf, and the platform
                  is onboarding vetted organisers only, so the absence of a badge
                  is a queue rather than a judgement. */}
              {event.organiser.verified && <VerifiedBadge />}
            </div>
            <p className="mt-3">
              {/* Names two specific checks — identity and payout details —
                  because that is exactly what setting this flag means: the
                  platform runs both before an organiser is allowed to sell.
                  This wording is load-bearing, not a softer paraphrase we
                  reached for; if onboarding ever stops performing either
                  check before verifying someone, this sentence has to change
                  with it. */}
              {event.organiser.verified
                ? 'We have verified this organiser’s identity and payout details before letting them sell.'
                : 'Tickets for this event are sold through Eventify, and your payment is protected the same way on every event.'}
            </p>
          </Accordion>

          <Accordion label="Refund policy" summary="This event is non-refundable.">
            <p>
              Tickets for this event are non-refundable. If the event is cancelled
              or rescheduled by the organiser, we will contact you at the email
              address on your order.
            </p>
          </Accordion>

          <Accordion label="FAQ" summary="View common questions">
            <dl className="space-y-4">
              <div>
                <dt className="md-title-small text-on-surface">
                  How do I get my ticket?
                </dt>
                <dd className="mt-1">
                  It arrives by email the moment your payment clears. Open it once
                  and it works at the gate with no signal.
                </dd>
              </div>
              <div>
                <dt className="md-title-small text-on-surface">
                  Do I need an account?
                </dt>
                <dd className="mt-1">
                  No. Buy as a guest and we email your tickets. Signing in later
                  with the same address collects them into one place.
                </dd>
              </div>
              <div>
                <dt className="md-title-small text-on-surface">
                  Can I buy for friends?
                </dt>
                <dd className="mt-1">
                  Yes. Choose the quantity you need — all the tickets arrive in one
                  email for you to forward.
                </dd>
              </div>
            </dl>
          </Accordion>
        </div>

        <div className="mt-12">
          <HowItWorks />
        </div>
      </div>

      {/* ─── Summary and checkout ─────────────────────────────────────── */}
      {/* Padded at the foot on mobile so the sticky subtotal never covers the
          last control — a bar sitting on top of the pay button is worse than
          no bar at all. */}
      <aside id="your-order" className="scroll-mt-20 pb-24 lg:sticky lg:top-24 lg:pb-0">
        <Card className="relative overflow-hidden p-5">
          {/* The tear line, and the only one on this viewport. */}
          <div className="stub-edge -mx-5 -mt-5 mb-5" aria-hidden="true" />

          <h2 className="md-title-large">Order summary</h2>

          {ticketCount === 0 ? (
            <p className="md-body-medium mt-3 text-on-surface-variant">
              Choose your tickets and the total will appear here.
            </p>
          ) : (
            <>
              <ul className="mt-4 space-y-2">
                {items.map((item) => {
                  const tier = event.tiers.find((t) => t.id === item.tierId)!;
                  return (
                    <li key={item.tierId} className="flex justify-between gap-4">
                      <span className="md-body-medium text-on-surface-variant">
                        {tier.name} × {item.quantity}
                      </span>
                      <span className="md-data-medium text-on-surface">
                        {formatMoney(tier.priceCents * item.quantity, tier.currency)}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {/* Subtotal, fee, total — stated in that order and always, even
                  though two of the three are currently the same number.
                  §Checkout asks for transparency and never surprising the
                  buyer, and the honest version of that here is to say out loud
                  that there is no booking fee. Competitors charge one; a buyer
                  who has been stung before is looking for exactly this line. */}
              <div className="mt-4 space-y-2 border-t border-outline-variant pt-4">
                <div className="flex items-baseline justify-between">
                  <span className="md-body-medium text-on-surface-variant">Subtotal</span>
                  <span className="md-data-medium text-on-surface">
                    {formatMoney(totalCents, event.currency)}
                  </span>
                </div>

                <div className="flex items-baseline justify-between">
                  <span className="md-body-medium text-on-surface-variant">
                    Booking fee
                  </span>
                  <span className="md-data-medium text-success">None</span>
                </div>

                <div className="flex items-baseline justify-between border-t border-outline-variant pt-3">
                  <span className="md-title-medium text-on-surface">Total</span>
                  <span className="md-data-large text-primary">
                    {formatMoney(totalCents, event.currency)}
                  </span>
                </div>
              </div>

              <p className="md-body-small mt-4 flex items-center gap-2 text-on-surface-variant">
                <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
                  <rect x="5" y="2" width="10" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
                </svg>
                Pay with M-Pesa
              </p>

              <div className="mt-6 space-y-4">
                <Field
                  label="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  error={errors.name}
                  valid={!errors.name && name.trim().length >= 2}
                  autoComplete="name"
                  placeholder="Wanjiku Kamau"
                />

                <Field
                  label="Email"
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  error={errors.email}
                  valid={!errors.email && EMAIL.test(email.trim())}
                  autoComplete="email"
                  placeholder="you@example.com"
                  hint={
                    user && email === user.email
                      ? undefined
                      : 'Your tickets are sent here.'
                  }
                />

                <Field
                  label="M-Pesa number"
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
                  error={errors.phone}
                  valid={!errors.phone && PHONE.test(normalisePhoneForDisplay(phone))}
                  autoComplete="tel"
                  placeholder="0712 345 678"
                  hint="The payment prompt goes to this number."
                />
              </div>

              {/* The price panel, the consent copy and the Pay button all moved
                  into `ConfirmDetailsModal` — pulling the final check into a
                  modal means the buyer's attention is on nothing else while
                  they confirm the two things a payment actually depends on. */}
              <div className="mt-6">
                <Button
                  full
                  icon={<LockIcon />}
                  onClick={handleCheckoutClick}
                  disabled={!detailsComplete}
                >
                  Checkout
                </Button>
              </div>

              <p className="md-body-small mt-3 text-center text-on-surface-variant">
                No account needed — we email your tickets.
              </p>
            </>
          )}
        </Card>

        <div className="mt-4 text-center">
          <ButtonLink to="/" variant="text">
            Back to events
          </ButtonLink>
        </div>
      </aside>
    </div>

      {related.length >= 3 && (
        <Section title="You might also like">
          <EventRail
            title="You might also like"
            events={related}
            headed={false}
            morphPoster={false}
          />
        </Section>
      )}

      {/* The sticky subtotal, phones only.
          On desktop the summary panel is already pinned beside the tiers, but
          on a phone it sits a full screen below them — so someone adding their
          third ticket has no idea what they are about to spend and no way to
          continue without scrolling past everything they just chose. This is
          that panel's job, reduced to the two things that matter: what it
          costs and how to proceed. Pinned above the safe area so it clears the
          home indicator rather than sitting under it. */}
      {ticketCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-outline-variant bg-surface-container-low pb-[env(safe-area-inset-bottom)] lg:hidden">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="md-body-small text-on-surface-variant">
                {ticketCount} {ticketCount === 1 ? 'ticket' : 'tickets'} · no fee
              </p>
              <p className="md-data-large text-primary">
                {formatMoney(totalCents, event.currency)}
              </p>
            </div>

            <ButtonAnchor href="#your-order" className="shrink-0">
              Get tickets
            </ButtonAnchor>
          </div>
        </div>
      )}

      <AnimatePresence>
        {confirmOpen && (
          <ConfirmDetailsModal
            key="confirm-details"
            currency={event.currency}
            // `currentPreview`, never the raw `preview` — the same reason
            // every other consumer in this file reads it that way. Passing
            // the tagged state's raw value here would hand the modal a price
            // that might already belong to a basket or a buyer it no longer
            // describes.
            preview={currentPreview}
            loading={working === 'preview'}
            paying={working === 'paying'}
            failure={failure}
            email={modalEmail}
            phone={modalPhone}
            touched={modalTouched}
            onEmailChange={setModalEmail}
            onPhoneChange={setModalPhone}
            // Re-prices on blur, not per keystroke — the same rule this file
            // already applies to the page's own fields. `buyer` above already
            // switches to these modal fields the instant they change, so the
            // safety property does not depend on this firing at all: a stale
            // `previewKey` already makes `currentPreview` null and disables
            // "Confirm & pay" the moment an edit lands, on the same render.
            // This exists only so the buyer gets a fresh price without a
            // separate refresh action, matching "editable right up to the
            // moment of paying."
            onTouch={(field) => {
              setModalTouched((t) => ({ ...t, [field]: true }));
              void handleReview();
            }}
            serverErrors={serverErrors}
            onRetryPreview={handleReview}
            onConfirm={handleConfirm}
            onClose={() => {
              // Not while a payment is actually in flight — closing here would
              // strand the buyer wondering whether it went through.
              if (working === 'paying') return;
              setConfirmOpen(false);
              setFailure(null);
              setServerErrors({});
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" aria-hidden="true">
      <rect x="4" y="9" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden="true">
      <path
        d="M10 18s6-5 6-9a6 6 0 1 0-12 0c0 4 6 9 6 9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="9" r="2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function IconPeople() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 16c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.5 12c1.9.3 3.5 1.9 3.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="14" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * The vetted mark.
 *
 * Blue, not gold. Gold means "this leads to the organiser side of the product"
 * — a door for the seller. This is a statement to the *buyer* about someone
 * else, which is the trust register, and trust is blue everywhere else in this
 * product. Making it gold would spend the one signal a buyer has for telling
 * the two halves apart.
 */
function VerifiedBadge() {
  return (
    <span className="md-label-medium inline-flex items-center gap-1.5 rounded-xs bg-primary-container px-2 py-1 text-on-primary-container">
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
        <path
          d="M8 1.5l1.8 1.2 2.1-.3.6 2 1.7 1.3-1 1.9.3 2.1-2 .6-1.3 1.7L8 12.9l-2.2.1-1.3-1.7-2-.6.3-2.1-1-1.9L3.5 5.4l.6-2 2.1.3L8 1.5Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="m5.8 8 1.5 1.5L10.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Verified organiser
    </span>
  );
}

// ─── Confirm details ───────────────────────────────────────────────────────

/**
 * The last screen before the STK push fires.
 *
 * Replaces what used to be an inline price panel and a separate "Pay" button
 * on the page itself: pulling the final check into a modal means the buyer's
 * attention is on nothing else while they confirm the two things a payment
 * actually depends on — where the tickets go and where the prompt goes.
 *
 * There is no consent checkbox here. Reaching for the confirm button is the
 * act of accepting, and the notice above it says so — quietly, the way a
 * receipt says terms apply, not as one more thing demanding a tap before the
 * one the buyer came here to make.
 */
function ConfirmDetailsModal({
  currency,
  preview,
  loading,
  paying,
  failure,
  email,
  phone,
  touched,
  onEmailChange,
  onPhoneChange,
  onTouch,
  serverErrors,
  onRetryPreview,
  onConfirm,
  onClose,
}: {
  currency: string;
  preview: PreviewResponse | null;
  loading: boolean;
  paying: boolean;
  failure: string | null;
  email: string;
  phone: string;
  touched: Record<string, boolean>;
  onEmailChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
  onTouch: (field: 'email' | 'phone') => void;
  serverErrors: Record<string, string>;
  onRetryPreview: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const emailError =
    (touched.email && !EMAIL.test(email.trim())
      ? 'That address looks incomplete — check for a missing letter.'
      : null) ??
    serverErrors.email ??
    null;
  const phoneError =
    (touched.phone && !PHONE.test(normalisePhoneForDisplay(phone))
      ? 'Use the number your M-Pesa is on, like 0712 345 678.'
      : null) ??
    serverErrors.phone ??
    null;

  const detailsValid = EMAIL.test(email.trim()) && PHONE.test(normalisePhoneForDisplay(phone));
  const canConfirm = detailsValid && Boolean(preview?.chargeable) && !paying && !loading;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-details-title"
      onClick={() => {
        if (!paying) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: 'spring', stiffness: 260, damping: 24 }}
        className="w-full max-w-sm rounded-lg bg-surface-container-high p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-details-title" className="md-title-large text-on-surface">
          Confirm details
        </h2>
        <p className="md-body-medium mt-1 text-on-surface-variant">
          Check everything before we charge your M-Pesa.
        </p>

        <div className="mt-5 space-y-4">
          <Field
            label="Email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            onBlur={() => onTouch('email')}
            error={emailError}
            valid={!emailError && EMAIL.test(email.trim())}
            autoComplete="email"
          />

          <Field
            label="M-Pesa number"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => onPhoneChange(e.target.value)}
            onBlur={() => onTouch('phone')}
            error={phoneError}
            valid={!phoneError && PHONE.test(normalisePhoneForDisplay(phone))}
            autoComplete="tel"
            hint="The payment prompt goes to this number."
          />
        </div>

        {loading && (
          <p className="md-body-medium mt-4 text-on-surface-variant">Checking prices…</p>
        )}

        {/* Wrapped because it renders server-shaped money and a list of
            issues — the two things most likely to arrive in a form this
            component did not expect. A throw here would otherwise take the
            whole modal down mid-payment. */}
        {!loading && preview && (
          <LocalErrorBoundary label="the price summary" onRetry={onRetryPreview}>
            <div className="mt-4 rounded-sm border border-outline-variant bg-surface p-4">
              <p className="md-body-medium text-on-surface-variant">
                Charging{' '}
                <span className="md-data-medium text-on-surface">
                  {formatMoney(preview.totalCents, currency)}
                </span>
              </p>
              <p className="md-body-small mt-2 text-on-surface-variant">
                Held for {preview.holdMinutes} minutes once you pay.
              </p>

              {!preview.chargeable && preview.issues.length > 0 && (
                <ul className="md-body-medium mt-3 space-y-1 text-error" role="alert">
                  {preview.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          </LocalErrorBoundary>
        )}

        {!loading && failure && (
          <p role="alert" className="md-body-medium mt-4 text-error">
            {failure}
          </p>
        )}

        {/* Said before the prompt arrives, not after.
            The STK request on the buyer's phone shows the registered Safaricom
            business name, which is Invonics Technologies, not Eventify. A
            payment request from a company they have never heard of is exactly
            what a scam looks like, and the careful ones cancel. Naming it here
            turns a surprise into a confirmation that the right thing is
            happening. */}
        <p className="md-body-small mt-4 text-center text-on-surface-variant">
          The M-Pesa request will show{' '}
          <span className="md-data-small text-on-surface">INVONICS TECHNOLOGIES</span>, who
          operate Eventify.
        </p>

        {/* Quiet by design — small, muted, unbolded. Not a checkbox: pressing
            Confirm below is itself the accepting act, and this line exists so
            that act is informed rather than assumed, without competing for
            attention with the button it sits above. */}
        <p className="md-body-small mt-3 text-center text-on-surface-variant opacity-80">
          By confirming, you agree we can use these details to process your payment and
          deliver your ticket — see our{' '}
          <Link to="/terms" className="underline">
            Terms
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="underline">
            Privacy Notice
          </Link>
          .
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <Button
            full
            onClick={onConfirm}
            disabled={!canConfirm}
            busy={paying}
            busyLabel="Securing your spot…"
          >
            {preview
              ? `Confirm & pay ${formatMoney(preview.totalCents, currency)}`
              : 'Confirm & pay'}
          </Button>
          <Button variant="outlined" full onClick={onClose} disabled={paying}>
            Cancel
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
