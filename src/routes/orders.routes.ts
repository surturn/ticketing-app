import { LIMITS } from '../config/rate-limits.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getOrderByReference, getOrderStatus } from '../services/orders.service.js';

const referenceParams = z.object({ reference: z.string().min(4).max(40) });

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/orders/:reference', async (request) => {
    const { reference } = referenceParams.parse(request.params);
    return { order: await getOrderByReference(reference) };
  });

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
