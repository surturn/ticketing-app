import { LIMITS } from '../config/rate-limits.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { optionalUser } from '../plugins/auth.js';
import { getOrderByReference, getOrderStatus } from '../services/orders.service.js';

const referenceParams = z.object({ reference: z.string().min(4).max(40) });

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // The same limit as the status poll below, and for a stronger reason: this is
  // the heavier of the two reads and the one that returns buyer details and the
  // signed QR payloads. It was inheriting only the global 240 a minute, so the
  // sensitive endpoint was the looser one — which is the opposite of what the
  // reasoning behind `orderRead` describes.
  app.get(
    '/api/orders/:reference',
    {
      // Optional, not required. A guest checkout has no account by definition,
      // and the reference has to keep resolving for them or they can never see
      // what they bought. Signing in adds the scannable payloads; it is not the
      // price of reading your own order.
      preHandler: optionalUser,
      config: { rateLimit: LIMITS.orderRead },
    },
    async (request) => {
      const { reference } = referenceParams.parse(request.params);
      return {
        order: await getOrderByReference(reference, {
          // From the verified token only. An id in the query string would make
          // ownership something the caller asserts.
          uid: request.user?.uid ?? null,
        }),
      };
    },
  );

  // The confirmation page polls this every couple of seconds while the buyer
  // is on the STK prompt. Never cached — a stale "pending" strands someone who
  // has already paid.
  app.get(
    '/api/orders/:reference/status',
    {
      config: { rateLimit: LIMITS.orderRead },
    },
    async (request, reply) => {
      const { reference } = referenceParams.parse(request.params);
      reply.header('Cache-Control', 'no-store');
      return getOrderStatus(reference);
    },
  );
}
