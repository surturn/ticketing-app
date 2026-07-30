import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireScanner } from '../plugins/auth.js';
import { checkInTicket } from '../services/tickets.service.js';

const checkInBody = z.object({
  // Either the signed QR payload or a code typed in by hand at the gate.
  code: z.string().min(4).max(200),
  gate: z.string().max(60).optional(),
});

export async function checkInRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/checkin',
    {
      preHandler: requireScanner,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = checkInBody.parse(request.body);

      const result = await checkInTicket(body.code, {
        // A scanner token is scoped to one event; an admin key is not.
        eventId: request.scanner?.eventId,
        scannedBy: body.gate ?? request.scanner?.gate ?? 'admin',
      });

      // 200 either way — "already checked in" is information the gate needs,
      // not an error condition. The `admitted` flag drives the UI.
      return result;
    },
  );
}
