import type { FastifyInstance } from 'fastify';
import {
  MPESA_B2C_RESULT_PATH,
  MPESA_B2C_TIMEOUT_PATH,
  MPESA_REVERSAL_RESULT_PATH,
  MPESA_REVERSAL_TIMEOUT_PATH,
  MPESA_WEBHOOK_PATH,
} from '../config/env.js';
import type { InitiatorResultBody } from '../gateways/mpesa/daraja.js';
import { getGateway } from '../gateways/registry.js';
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
      // Authentication is the gateway's own business now, not this route's.
      // Previously it imported the M-Pesa verifier directly, which meant the
      // route knew which gateway it was serving and a second one would have
      // had to branch here.
      const gateway = getGateway('mpesa');

      if (!gateway.authenticateCallback({ query: request.query as never, headers: request.headers })) {
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
        settlement = gateway.parseCallback(request.body);
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

  // ─── Initiator results: B2C and Reversal ─────────────────────────────────
  //
  // The outcome of a payout or a refund, arriving minutes after the request was
  // accepted. Same two rules as above: always acknowledge, and persist before
  // acting.
  //
  // These are recorded but not yet acted on. Neither product has a domain flow
  // behind it — there is no payouts table for a B2C result to settle, and no
  // refund record for a reversal to close — so acting on one would mean
  // inventing state to write it into. Persisting every delivery means that when
  // those flows are built the history is already there, and in the meantime a
  // payout that failed is visible in `webhook_events` rather than lost.

  /**
   * Registers one result or timeout endpoint.
   *
   * The dedupe key is the OriginatorConversationID — the id we minted when
   * sending the request, and the only value that is stable across a retry.
   * Safaricom's own ConversationID is not usable for this: it is absent from
   * some timeout payloads.
   */
  function registerInitiatorCallback(path: string, kind: string): void {
    app.post(path, { config: { rateLimit: false } }, async (request, reply) => {
      const gateway = getGateway('mpesa');

      if (!gateway.authenticateCallback({ query: request.query as never, headers: request.headers })) {
        request.log.warn({ ip: request.ip, kind }, 'rejected M-Pesa result with a bad token');
        return reply.status(200).send(ACK);
      }

      const body = request.body as Partial<InitiatorResultBody> | undefined;
      const result = body?.Result;

      // A timeout callback carries no Result envelope at all. Falling back to
      // the raw body keeps the delivery recorded rather than dropped, which is
      // the whole point of persisting these.
      const dedupeKey = result?.OriginatorConversationID
        ? `${kind}:${result.OriginatorConversationID}`
        : `${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

      request.log.info(
        {
          kind,
          originatorConversationId: result?.OriginatorConversationID,
          transactionId: result?.TransactionID,
          resultCode: result?.ResultCode,
          resultDesc: result?.ResultDesc,
        },
        'M-Pesa initiator result received',
      );

      try {
        await recordWebhookDelivery(
          'mpesa',
          dedupeKey,
          (request.body ?? {}) as Record<string, unknown>,
        );
      } catch (error) {
        request.log.error({ err: error, kind, dedupeKey }, 'could not record M-Pesa result');
      }

      return reply.status(200).send(ACK);
    });
  }

  registerInitiatorCallback(MPESA_B2C_RESULT_PATH, 'b2c-result');
  registerInitiatorCallback(MPESA_B2C_TIMEOUT_PATH, 'b2c-timeout');
  registerInitiatorCallback(MPESA_REVERSAL_RESULT_PATH, 'reversal-result');
  registerInitiatorCallback(MPESA_REVERSAL_TIMEOUT_PATH, 'reversal-timeout');
}
