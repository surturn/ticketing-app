/**
 * One event: what it is, what a ticket costs, and how to buy one.
 *
 * The purchase is two committed steps and no more — choose tickets, then enter
 * details and pay. Each extra screen between wanting a ticket and having one
 * costs sales, so there is no cart, no account requirement and no interstitial.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ApiError,
  createCheckout,
  fetchEvent,
  fieldErrors,
  previewCheckout,
  type PreviewResponse,
  type Tier,
} from '@/lib/api';
import { LocalErrorBoundary } from '@/components/LocalErrorBoundary';
import { useToast } from '@/components/Toasts';
import { availabilityLabel, formatEventDate, formatMoney } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { RichText } from '@/components/RichText';
import { useAuth } from '@/auth/AuthProvider';
import {
  Badge,
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

// ─── Tier ──────────────────────────────────────────────────────────────────

function TierRow({
  tier,
  quantity,
  onChange,
}: {
  tier: Tier;
  quantity: number;
  onChange: (next: number) => void;
}) {
  const availability = availabilityLabel(tier);
  const unavailable = !tier.onSale || tier.soldOut || tier.closedByOrganiser;

  // An uncapped tier has no stock number to cap against, so the only ceiling is
  // what one order may contain.
  const ceiling = tier.uncapped
    ? tier.maxPerOrder
    : Math.min(tier.maxPerOrder, tier.available ?? 0);

  // VIP and premium are one of the three sanctioned uses of gold on a consumer
  // surface — it marks a tier as the expensive one, which is exactly the
  // "earn" register gold carries everywhere else in the product.
  const isVip = /vip|premium|gold/i.test(tier.name);

  return (
    <Card
      className={`p-5 transition-colors duration-[--dur-medium] ease-[--ease-standard] ${
        quantity > 0 ? 'bg-surface-container-highest' : ''
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="md-title-medium text-on-surface">{tier.name}</h3>
            {isVip && <Badge tone="gold">VIP</Badge>}
            <Badge tone={availability.tone === 'ok' ? 'neutral' : availability.tone}>
              {availability.text}
            </Badge>
          </div>

          {tier.description && (
            <p className="md-body-medium mt-1.5 text-on-surface-variant">
              {tier.description}
            </p>
          )}

          {/* A price is a fact the door will check — the data face, and tabular
              figures so a column of tiers lines up down the edge. */}
          <p className="md-data-large mt-3 text-on-surface">
            {formatMoney(tier.priceCents, tier.currency)}
          </p>

          {tier.maxPerOrder < 10 && !unavailable && (
            <p className="md-data-small mt-1 text-on-surface-variant">
              Up to {tier.maxPerOrder} per order
            </p>
          )}
        </div>

        {unavailable ? (
          // Sold-out tiers stay visible and greyed rather than disappearing:
          // a tier vanishing between two page loads reads as a bug to someone
          // who was sent the link.
          <p className="md-body-medium text-on-surface-variant">
            {tier.closedByOrganiser
              ? 'Sales have closed'
              : tier.soldOut
                ? 'Sold out'
                : 'Not on sale'}
          </p>
        ) : (
          // The stepper's frame is clipped like everything else; the two targets
          // inside stay circular, because a round icon button is not the generic
          // pill the shape change was aimed at.
          //
          // 48px, not 40. This is the control someone taps repeatedly on a
          // phone, often in a queue, often one-handed — the last place to
          // economise on target size.
          <div className="trimmed flex items-center gap-1 border border-outline-variant bg-surface p-1">
            <button
              type="button"
              onClick={() => onChange(Math.max(0, quantity - 1))}
              disabled={quantity === 0}
              aria-label={`Remove one ${tier.name} ticket`}
              className="md-state flex size-12 cursor-pointer items-center justify-center rounded-full text-lg text-on-surface-variant transition-colors disabled:cursor-not-allowed disabled:opacity-30"
            >
              <span className="md-state-layer" aria-hidden="true" />
              <span className="relative">−</span>
            </button>

            <span
              className="md-data-large w-8 text-center text-on-surface"
              aria-live="polite"
              aria-label={`${quantity} ${tier.name} tickets`}
            >
              {quantity}
            </span>

            <button
              type="button"
              onClick={() => onChange(Math.min(ceiling, quantity + 1))}
              disabled={quantity >= ceiling}
              aria-label={`Add one ${tier.name} ticket`}
              className="md-state flex size-12 cursor-pointer items-center justify-center rounded-full text-lg text-on-surface-variant transition-colors disabled:cursor-not-allowed disabled:opacity-30"
            >
              <span className="md-state-layer" aria-hidden="true" />
              <span className="relative">+</span>
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export function EventPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data, loading, error, reload } = useAsync(() => fetchEvent(slug), [slug]);
  const event = data?.event;

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
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
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

  const buyer = {
    name: name.trim(),
    email: email.trim(),
    phone: normalisePhoneForDisplay(phone),
  };

  async function handleReview() {
    setFailure(null);
    setServerErrors({});
    setWorking('preview');
    try {
      setPreview(await previewCheckout({ eventSlug: slug, items, buyer }));
    } catch (caught) {
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
    <div className="grid gap-10 lg:grid-cols-[1fr_380px] lg:items-start">
      <div>
        {/* The poster, at last, on the page where the buyer is deciding.
            Showing it only in the listing was backwards: the moment someone is
            weighing up a ticket is exactly when the promoter's artwork should be
            doing its work. */}
        {/* Blue, not gold. Gold on a consumer surface means "this leads to the
            organiser side"; using it as a generic accent here would spend the
            one signal the buyer has for telling the two halves of the product
            apart. */}
        <header className="relative mb-10 overflow-hidden rounded-lg border border-primary/25 bg-surface-container">
          <div className="relative flex flex-col gap-7 p-6 sm:flex-row sm:items-center sm:p-8">
            {posterVisible && (
              <img
                src={event.posterUrl!}
                alt={`Poster for ${event.name}`}
                onError={() => setPosterFailed(true)}
                /* The receiving half of the card → page morph. The grid card
                   claims the same name on its way out, so the browser treats
                   the two as one object opening rather than two pages
                   swapping. */
                style={{ viewTransitionName: 'poster' }}
                className="aspect-4/5 w-full shrink-0 rounded-md border border-primary/30 object-cover shadow-2xl shadow-black/20 sm:w-44"
              />
            )}

            <div className="min-w-0">
              {/* A date is a fact the door will check, so it stays in the data
                  face — but as an eyebrow it is chrome, which is why it is not
                  also uppercased and tracked out like a mono label. */}
              <p className="md-data-medium text-primary">
                {formatEventDate(event.startsAt, event.timezone)}
              </p>

              <h1 className="md-display-small mt-3">{event.name}</h1>

              {event.venue && (
                <p className="md-body-large mt-3 text-on-surface-variant">{event.venue}</p>
              )}

              {event.description && (
                <div className="mt-5 max-w-2xl">
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
          </div>
        </header>

        <h2 className="md-eyebrow mb-5 text-on-surface-variant">Tickets</h2>

        <div className="space-y-3">
          {event.tiers.map((tier) => (
            <TierRow
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
      </div>

      {/* ─── Summary and checkout ─────────────────────────────────────── */}
      {/* Padded at the foot on mobile so the sticky subtotal never covers the
          last control — a bar sitting on top of the pay button is worse than
          no bar at all. */}
      <aside id="your-order" className="scroll-mt-20 pb-24 lg:sticky lg:top-24 lg:pb-0">
        <Card className="relative overflow-hidden p-5">
          {/* The tear line, and the only one on this viewport. */}
          <div className="stub-edge -mx-5 -mt-5 mb-5" aria-hidden="true" />

          <h2 className="md-title-large">Your order</h2>

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

              <div className="mt-4 flex items-baseline justify-between border-t border-outline-variant pt-4">
                <span className="md-body-medium text-on-surface-variant">Total</span>
                <span className="md-data-large text-on-surface">
                  {formatMoney(totalCents, event.currency)}
                </span>
              </div>

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

              <div className="mt-6">
                <Button full onClick={handleCheckoutClick} disabled={!detailsComplete}>
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
                {ticketCount} {ticketCount === 1 ? 'ticket' : 'tickets'}
              </p>
              <p className="md-data-large text-on-surface">
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
            preview={preview}
            loading={working === 'preview'}
            paying={working === 'paying'}
            failure={failure}
            email={modalEmail}
            phone={modalPhone}
            touched={modalTouched}
            onEmailChange={setModalEmail}
            onPhoneChange={setModalPhone}
            onTouch={(field) => setModalTouched((t) => ({ ...t, [field]: true }))}
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
