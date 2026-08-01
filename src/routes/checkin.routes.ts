import { LIMITS } from '../config/rate-limits.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { boundedText } from '../lib/validation.js';
import { requireScanner } from '../plugins/auth.js';
import { checkInTicket } from '../services/tickets.service.js';

const checkInBody = z
  .object({
    // Either the signed QR payload or a code typed in by hand at the gate.
    // Trimmed because a barcode scanner commonly appends a newline, and an
    // untrimmed value silently fails to match any ticket.
    code: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(4).max(200)),
    // Lands in tickets.checked_in_by and in the ledger's actor field, so it is
    // bounded and cleaned rather than taken as given.
    gate: boundedText(1, 60).optional(),
  })
  .strict();

export async function checkInRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/checkin',
    {
      preHandler: requireScanner,
      config: { rateLimit: LIMITS.checkIn },
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
