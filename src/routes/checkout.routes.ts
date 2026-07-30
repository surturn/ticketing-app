import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cancelOrder, createCheckout } from '../services/checkout.service.js';

const checkoutBody = z.object({
  eventSlug: z.string().min(1),
  items: z
    .array(
      z.object({
        tierId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(10),
  buyer: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(200).optional(),
    phone: z.string().min(9).max(20),
  }),
  metadata: z.record(z.unknown()).optional(),
});

const referenceParams = z.object({ reference: z.string().min(4).max(40) });

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/checkout',
    {
      config: {
        // Tighter than the global limit: this endpoint holds inventory and
        // costs a Daraja call, so it is the one worth protecting from a bot.
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = checkoutBody.parse(request.body);

      // Clients should send a stable Idempotency-Key per basket so a retry on a
      // flaky mobile connection does not reserve the seats twice.
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;

      const result = await createCheckout({
        eventSlug: body.eventSlug,
        items: body.items,
        buyer: body.buyer,
        metadata: body.metadata,
        idempotencyKey,
      });

      return reply.status(result.idempotentReplay ? 200 : 201).send(result);
    },
  );

  app.post('/api/orders/:reference/cancel', async (request) => {
    const { reference } = referenceParams.parse(request.params);
    return cancelOrder(reference);
  });
}
