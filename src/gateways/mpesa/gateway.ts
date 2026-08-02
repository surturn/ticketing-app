import crypto from 'node:crypto';
import { env, mpesaConfigured } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { centsToMpesaAmount, mpesaAmountToCents } from '../../lib/money.js';
import type {
  CallbackAuthInput,
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
  SettlementOutcome,
  SettlementResult,
} from '../types.js';
import {
  parseTransactionDate,
  stkPush,
  stkQuery,
  type MpesaCallbackBody,
  type StkCallback,
} from './daraja.js';

// ---------------------------------------------------------------------------
// Daraja result codes we care about. Anything unmapped is a plain failure —
// the buyer keeps their money, we release the seats.
// ---------------------------------------------------------------------------

function mapResultCode(code: number): SettlementOutcome {
  switch (code) {
    case 0:
      return 'succeeded';
    case 1032: // request cancelled by user
      return 'cancelled';
    case 1037: // DS timeout — user unreachable, never entered a PIN
    case 1019: // transaction expired
      return 'timeout';
    default:
      // 1 = insufficient balance, 2001 = wrong PIN, 1001 = another session, …
      return 'failed';
  }
}

function extractMetadata(callback: StkCallback): {
  receipt?: string;
  amountCents?: number;
  phone?: string;
  transactionDate?: Date;
} {
  const items = callback.CallbackMetadata?.Item ?? [];
  const out: {
    receipt?: string;
    amountCents?: number;
    phone?: string;
    transactionDate?: Date;
  } = {};

  for (const item of items) {
    if (item.Value === undefined || item.Value === null) continue;
    switch (item.Name) {
      case 'MpesaReceiptNumber':
        out.receipt = String(item.Value);
        break;
      case 'Amount':
        out.amountCents = mpesaAmountToCents(Number(item.Value));
        break;
      case 'PhoneNumber':
        out.phone = String(item.Value);
        break;
      case 'TransactionDate':
        out.transactionDate = parseTransactionDate(item.Value);
        break;
    }
  }

  return out;
}

export class MpesaGateway implements PaymentGateway {
  readonly name = 'mpesa' as const;

  isConfigured(): boolean {
    return mpesaConfigured;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (request.currency !== 'KES') {
      throw badRequest(`M-Pesa can only charge KES, not ${request.currency}`);
    }

    const response = await stkPush({
      phone: request.phone,
      amount: centsToMpesaAmount(request.amountCents),
      accountReference: request.reference,
      description: request.description,
    });

    return {
      gatewayRef: response.CheckoutRequestID,
      merchantRef: response.MerchantRequestID,
      customerMessage: response.CustomerMessage,
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Daraja cannot send a custom header, so the shared secret rides on the
   * query string of the callback URL we registered with them. The raw body is
   * not consulted — there is no signature to check against it.
   */
  authenticateCallback(input: CallbackAuthInput): boolean {
    const token = input.query?.['token'];
    return isValidCallbackToken(typeof token === 'string' ? token : undefined);
  }

  parseCallback(body: unknown): SettlementResult {
    const callback = (body as MpesaCallbackBody)?.Body?.stkCallback;

    if (!callback?.CheckoutRequestID) {
      throw badRequest('Malformed M-Pesa callback: missing Body.stkCallback');
    }

    const resultCode = Number(callback.ResultCode);
    const metadata = extractMetadata(callback);

    return {
      gatewayRef: callback.CheckoutRequestID,
      merchantRef: callback.MerchantRequestID,
      outcome: mapResultCode(resultCode),
      resultCode,
      resultDesc: callback.ResultDesc ?? '',
      ...metadata,
      // Safaricom sends no delivery id, so identity is the attempt plus its
      // terminal result. A retried delivery of the same result dedupes; a
      // genuinely different result for the same attempt still gets processed.
      dedupeKey: `${callback.CheckoutRequestID}:${resultCode}`,
      raw: body as Record<string, unknown>,
    };
  }

  async queryStatus(gatewayRef: string): Promise<SettlementResult> {
    const response = await stkQuery(gatewayRef);
    const resultCode = Number(response.ResultCode);

    return {
      gatewayRef,
      merchantRef: response.MerchantRequestID,
      outcome: mapResultCode(resultCode),
      resultCode,
      resultDesc: response.ResultDesc ?? '',
      // The query API does not return the receipt, so a reconciled success is
      // recorded without one. The callback fills it in if it arrives later.
      dedupeKey: `${gatewayRef}:${resultCode}`,
      raw: response as unknown as Record<string, unknown>,
    };
  }
}

export const mpesaGateway = new MpesaGateway();

/**
 * Guards every M-Pesa callback route.
 *
 * Fails closed. An unset token used to mean "accept everything", which read as a
 * convenience for deployments without M-Pesa but was in fact the whole
 * authentication check evaluating to `true` for anyone who found the URL. The
 * cost of that is not abstract: a settlement is what turns a held order into
 * issued tickets, and the `gatewayRef` needed to target one is handed to the
 * buyer in the checkout response. `mpesaConfigured` now requires the token, so a
 * service that can charge anyone always has one to compare against.
 *
 * Compared in constant time, like the admin key and the QR signature. A callback
 * endpoint is unauthenticated by definition — the comparison is the only secret
 * operation in it, so it is the only place a timing signal could come from.
 */
export function isValidCallbackToken(token: string | undefined): boolean {
  const expected = env.MPESA_CALLBACK_TOKEN;
  if (!expected) return false;
  if (typeof token !== 'string') return false;

  const provided = Buffer.from(token);
  const secret = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, so length is checked first.
  // Length is not the secret here — the token's value is — and a token of the
  // wrong length is rejected by the comparison below in any case.
  if (provided.length !== secret.length) return false;
  return crypto.timingSafeEqual(provided, secret);
}
