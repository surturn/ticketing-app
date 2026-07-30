import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cancelOrder,
  createCheckout,
  previewCheckout,
} from '../services/checkout.service.js';
import { optionalUser } from '../plugins/auth.js';
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
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
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
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = checkoutBody.parse(request.body);

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
        // Taken from the verified token, never from the body — a caller must not
        // be able to file an order under somebody else's account.
        userId: request.user?.uid ?? null,
      });

      return reply.status(result.idempotentReplay ? 200 : 201).send(result);
    },
  );

  app.post('/api/orders/:reference/cancel', async (request) => {
    const { reference } = referenceParams.parse(request.params);
    return cancelOrder(reference);
  });
}
