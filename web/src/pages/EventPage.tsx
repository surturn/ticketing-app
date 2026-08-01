/**
 * One event: what it is, what a ticket costs, and how to buy one.
 *
 * The purchase is two committed steps and no more — choose tickets, then enter
 * details and pay. Each extra screen between wanting a ticket and having one
 * costs sales, so there is no cart, no account requirement and no interstitial.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  createCheckout,
  fetchEvent,
  previewCheckout,
  type PreviewResponse,
  type Tier,
} from '@/lib/api';
import { availabilityLabel, formatEventDate, formatMoney } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/auth/AuthProvider';
import {
  Badge,
  Button,
  ButtonAnchor,
  ButtonLink,
  Card,
  ConsentCheckbox,
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
          <div className="clipped flex items-center gap-1 border border-outline-variant bg-surface p-1">
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

  const [basket, setBasket] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const [posterFailed, setPosterFailed] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [working, setWorking] = useState<'preview' | 'paying' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Both start false and stay false until tapped. Consent has to be an act the
  // buyer took, so neither box is ever pre-ticked.
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);

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

  const errors = {
    name: touched.name && name.trim().length < 2 ? 'Please enter your full name.' : null,
    email:
      touched.email && !EMAIL.test(email.trim())
        ? 'That address looks incomplete — check for a missing letter.'
        : null,
    phone:
      touched.phone && !PHONE.test(normalisePhoneForDisplay(phone))
        ? 'Use the number your M-Pesa is on, like 0712 345 678.'
        : null,
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
    setWorking('preview');
    try {
      setPreview(await previewCheckout({ eventSlug: slug, items, buyer }));
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : 'We could not price that basket.',
      );
    } finally {
      setWorking(null);
    }
  }

  async function handlePay() {
    if (!acceptedTerms) {
      setTermsError('Please accept the terms and privacy notice to continue.');
      return;
    }

    setFailure(null);
    setTermsError(null);
    setWorking('paying');
    try {
      const order = await createCheckout(
        {
          eventSlug: slug,
          items,
          buyer,
          acceptedTerms: true,
          marketingOptIn,
        },
        idempotencyKey,
      );
      // Straight to the order page, which owns the waiting state. The prompt is
      // already on the buyer's handset by the time this navigates.
      navigate(`/orders/${order.reference}`, { state: { justCreated: true } });
    } catch (caught) {
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : 'We could not start that payment. Please try again.',
      );
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
                <p className="md-body-large mt-5 max-w-2xl text-on-surface-variant">
                  {event.description}
                </p>
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

              {/* The priced, normalised confirmation. This is where a mistyped
                  phone number surfaces — as the number it will actually be, not
                  as the buyer typed it. */}
              {preview && (
                <div className="mt-5 rounded-sm border border-outline-variant bg-surface p-4">
                  <p className="md-body-medium text-on-surface-variant">
                    Charging{' '}
                    <span className="md-data-medium text-on-surface">
                      {formatMoney(preview.totalCents, event.currency)}
                    </span>{' '}
                    to
                  </p>
                  <p className="md-data-large mt-0.5 text-on-surface">
                    {preview.buyer.phone}
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
              )}

              {failure && (
                <p role="alert" className="md-body-medium mt-4 text-error">
                  {failure}
                </p>
              )}

              {/* Two boxes, two questions, neither pre-ticked.
                  Kept separate because they are separate consents: agreeing to
                  the terms is not agreeing to marketing, and bundling them into
                  one tick would make both invalid. The order completes
                  identically whether or not the second is touched — which is
                  what makes the first freely given rather than the price of a
                  ticket. */}
              <div className="mt-6 space-y-3 border-t border-outline-variant pt-5">
                <ConsentCheckbox
                  checked={acceptedTerms}
                  onChange={(next) => {
                    setAcceptedTerms(next);
                    if (next) setTermsError(null);
                  }}
                  required
                  error={termsError}
                >
                  I agree to the{' '}
                  <Link to="/terms" className="text-primary underline">
                    terms of service
                  </Link>{' '}
                  and the{' '}
                  <Link to="/privacy" className="text-primary underline">
                    privacy notice
                  </Link>
                  , and to my details being used to issue and deliver my ticket.
                </ConsentCheckbox>

                <ConsentCheckbox checked={marketingOptIn} onChange={setMarketingOptIn}>
                  Email me about upcoming events and flash sales. Optional, and
                  you can stop at any time.
                </ConsentCheckbox>
              </div>

              <div className="mt-6">
                {preview?.chargeable ? (
                  <Button
                    full
                    onClick={handlePay}
                    busy={working === 'paying'}
                    busyLabel="Securing your spot…"
                  >
                    Pay {formatMoney(preview.totalCents, event.currency)} with M-Pesa
                  </Button>
                ) : (
                  <Button
                    full
                    onClick={handleReview}
                    disabled={!detailsComplete}
                    busy={working === 'preview'}
                    busyLabel="Checking…"
                  >
                    Review order
                  </Button>
                )}
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
    </div>
  );
}
