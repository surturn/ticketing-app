import type { FastifyInstance } from 'fastify';
import { MPESA_WEBHOOK_PATH } from '../config/env.js';
import { isValidCallbackToken, mpesaGateway } from '../gateways/mpesa/gateway.js';
import { applySettlement, recordWebhookDelivery } from '../services/payments.service.js';

// ---------------------------------------------------------------------------
// M-Pesa callback.
//
// Two rules govern everything here:
//
//   1. Always answer 200 with {ResultCode: 0}. Safaricom retries anything else
//      aggressively, and a retry storm during a sale is worse than a missed
//      callback — especially since the reconciliation worker will catch what we
//      drop.
//   2. Persist the delivery before acting on it. If processing then throws, the
//      row stays `received` and the reconciler settles the payment by polling
//      Daraja instead. Nothing is lost by failing here.
// ---------------------------------------------------------------------------

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    // Shared with the MPESA_CALLBACK_URL validation in config/env.ts, so a
    // misconfigured callback URL fails at boot instead of at the first payment.
    MPESA_WEBHOOK_PATH,
    {
      config: {
        // Safaricom bursts retries; rate-limiting them would cause more retries.
        rateLimit: false,
      },
    },
    async (request, reply) => {
      const token = (request.query as { token?: string } | undefined)?.token;

      if (!isValidCallbackToken(token)) {
        request.log.warn(
          { ip: request.ip },
          'rejected M-Pesa callback with a bad token',
        );
        // Still a 200 — an attacker learns nothing, and if this ever fires for
        // a genuine Safaricom call the reconciler covers us.
        return reply.status(200).send(ACK);
      }

      let settlement;
      try {
        settlement = mpesaGateway.parseCallback(request.body);
      } catch (error) {
        request.log.error(
          { err: error, body: request.body },
          'could not parse M-Pesa callback',
        );
        return reply.status(200).send(ACK);
      }

      request.log.info(
        {
          gatewayRef: settlement.gatewayRef,
          resultCode: settlement.resultCode,
          outcome: settlement.outcome,
        },
        'M-Pesa callback received',
      );

      try {
        const { isNew, id } = await recordWebhookDelivery(
          'mpesa',
          settlement.dedupeKey,
          settlement.raw,
        );

        if (!isNew) {
          // A replay. Already handled; acknowledging is the whole job.
          request.log.debug(
            { dedupeKey: settlement.dedupeKey },
            'duplicate callback ignored',
          );
          return reply.status(200).send(ACK);
        }

        await applySettlement(settlement, { webhookEventId: id });
      } catch (error) {
        // Deliberately swallowed — see rule 2 above.
        request.log.error(
          { err: error, gatewayRef: settlement.gatewayRef },
          'callback processing failed; reconciler will retry',
        );
      }

      return reply.status(200).send(ACK);
    },
  );
}
