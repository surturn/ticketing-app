import { LIMITS } from '../config/rate-limits.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cancelOrder,
  createCheckout,
  previewCheckout,
} from '../services/checkout.service.js';
import { optionalUser } from '../plugins/auth.js';
import { TERMS_VERSION } from '../lib/consent.js';
import { badRequest } from '../lib/errors.js';
import { subscribe } from '../services/subscribers.service.js';
import {
  boundedMetadata,
  emailAddress,
  idempotencyKey as idempotencyKeySchema,
  mpesaPhone,
  personName,
} from '../lib/validation.js';

// ---------------------------------------------------------------------------
// `.strict()` everywhere: an unknown key is a client bug, and silently dropping
// it is how a frontend ships a typo'd field name and nobody notices until a
// buyer is overcharged. Better a loud 400 during integration.
// ---------------------------------------------------------------------------

const buyerSchema = z
  .object({
    name: personName,
    // Mandatory. A buyer we cannot email is a buyer who cannot receive tickets.
    email: emailAddress,
    phone: mpesaPhone,
  })
  .strict();

const itemsSchema = z
  .array(
    z
      .object({
        tierId: z.string().uuid('must be a valid tier id'),
        quantity: z.number().int('must be a whole number').min(1).max(100),
      })
      .strict(),
  )
  .min(1, 'your basket is empty')
  .max(10, 'at most 10 different tiers per order');

const checkoutBody = z
  .object({
    eventSlug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9-]+$/, 'must be a lowercase slug'),
    items: itemsSchema,
    buyer: buyerSchema,

    /**
     * Explicit acceptance of the terms and privacy notice, as a literal `true`.
     *
     * `z.literal(true)` rather than a boolean: the schema then refuses a `false`
     * outright instead of accepting it and leaving the route to remember to
     * check. A client that omits it, or sends anything else, gets a 400 naming
     * the field. There is no path to a completed order without it.
     *
     * Optional at the schema level only so the preview endpoint — which reserves
     * nothing, charges nothing and exists to price a basket — does not demand
     * consent before the buyer has been shown what they are consenting to. The
     * checkout route requires it separately.
     */
    acceptedTerms: z.literal(true).optional(),

    /**
     * Whether the buyer asked to hear about future events.
     *
     * Entirely separate from `acceptedTerms`, and never inferred from it.
     * Section 32(4) of the Act asks whether consent was freely given, taking
     * into account whether a service was made conditional on consent that is
     * not necessary to provide it — so this defaults to false, and an order
     * completes identically either way.
     */
    marketingOptIn: z.boolean().default(false),

    metadata: boundedMetadata.optional(),
  })
  .strict();

/** The preview accepts the same body as checkout, so a confirmed basket can be
 *  submitted verbatim without the client reshaping anything. */
const previewBody = checkoutBody;

const referenceParams = z
  .object({
    reference: z
      .string()
      .min(4)
      .max(40)
      .regex(/^[A-Za-z0-9-]+$/, 'must be an order reference'),
  })
  .strict();

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  // ─── Confirm before charging ────────────────────────────────────────────
  //
  // Validates and normalises exactly what /api/checkout would, prices the
  // basket, and echoes back the buyer details as they will be stored — the
  // normalised phone in particular, since `0712…` becoming `254712…` is the
  // detail buyers most often get wrong. Holds no inventory and calls no
  // gateway, so it is safe to call on every keystroke of a confirm screen.
  app.post(
    '/api/checkout/preview',
    { config: { rateLimit: LIMITS.checkoutPreview } },
    async (request) => {
      const body = previewBody.parse(request.body);
      return previewCheckout({
        eventSlug: body.eventSlug,
        items: body.items,
        buyer: body.buyer,
      });
    },
  );

  app.post(
    '/api/checkout',
    {
      // Optional on purpose. A signed-in buyer gets the order attached to their
      // account; a guest, or someone whose token just expired, still completes
      // the purchase. An authentication problem must never cost a sale.
      preHandler: optionalUser,
      config: {
        // Tighter than the global limit: this endpoint holds inventory and
        // costs a Daraja call, so it is the one worth protecting from a bot.
        rateLimit: LIMITS.checkout,
      },
    },
    async (request, reply) => {
      const body = checkoutBody.parse(request.body);

      // Enforced here rather than in the shared schema, because the preview
      // endpoint uses the same body and must stay usable before the buyer has
      // been shown what they would be agreeing to.
      if (body.acceptedTerms !== true) {
        throw badRequest(
          'Please accept the terms and privacy notice to complete your purchase.',
        );
      }

      // Clients should send a stable Idempotency-Key per basket so a retry on a
      // flaky mobile connection does not reserve the seats twice. Validated
      // rather than trusted: it becomes a unique index value.
      const rawKey = request.headers['idempotency-key'];
      const idempotencyKey =
        typeof rawKey === 'string' ? idempotencyKeySchema.parse(rawKey) : undefined;

      const result = await createCheckout({
        eventSlug: body.eventSlug,
        items: body.items,
        buyer: body.buyer,
        metadata: body.metadata,
        idempotencyKey,
        // The version in force at the moment of purchase, so a later revision
        // cannot retroactively change what this buyer agreed to.
        termsVersion: TERMS_VERSION,
        // Taken from the verified token, never from the body — a caller must not
        // be able to file an order under somebody else's account.
        userId: request.user?.uid ?? null,
      });

      /**
       * Marketing consent, recorded after the order rather than before it.
       *
       * Deliberately not awaited into the checkout path and deliberately
       * swallowed: the buyer has paid, and a newsletter signup that failed must
       * never turn a completed purchase into an error. `subscribe` is
       * double-opt-in, so this sends a confirmation the buyer still has to act
       * on — nobody is added to a list by this call alone.
       */
      if (body.marketingOptIn) {
        void subscribe(body.buyer.email, 'checkout').catch((error: unknown) => {
          request.log.warn({ err: error }, 'could not record marketing opt-in');
        });
      }

      return reply.status(result.idempotentReplay ? 200 : 201).send(result);
    },
  );

  /**
   * Cancels an unpaid order.
   *
   * Authorised by knowing the reference, which is unguessable by design — but
   * "unguessable" is a claim about how long guessing takes, and an unlimited
   * endpoint is what turns that from years into an afternoon. The limit is the
   * thing that makes the reference's entropy actually load-bearing.
   */
  app.post(
    '/api/orders/:reference/cancel',
    { config: { rateLimit: LIMITS.accountWrite } },
    async (request) => {
      const { reference } = referenceParams.parse(request.params);
      return cancelOrder(reference);
    },
  );
}
