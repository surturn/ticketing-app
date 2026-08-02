// ---------------------------------------------------------------------------
// Gateway contract.
//
// Checkout and settlement talk only to this interface. Adding Paystack or
// Stripe later means writing one adapter and registering it — no changes to
// inventory, order state machine, or ticket issuance.
// ---------------------------------------------------------------------------

export type GatewayName = 'mpesa';

export interface ChargeRequest {
  orderId: string;
  /** Human reference shown on the buyer's statement / STK prompt. */
  reference: string;
  amountCents: number;
  currency: string;
  phone: string;
  description: string;
}

export interface ChargeResult {
  /** The gateway's id for this attempt — M-Pesa CheckoutRequestID. */
  gatewayRef: string;
  merchantRef?: string;
  /** Message worth surfacing to the buyer ("Enter your M-Pesa PIN"). */
  customerMessage?: string;
  raw: Record<string, unknown>;
}

export type SettlementOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'pending'
  | 'timeout';

export interface SettlementResult {
  gatewayRef: string;
  merchantRef?: string;
  outcome: SettlementOutcome;
  resultCode: number;
  resultDesc: string;
  receipt?: string;
  amountCents?: number;
  phone?: string;
  transactionDate?: Date;
  /** Stable identity for this delivery, used to dedupe replayed callbacks. */
  dedupeKey: string;
  raw: Record<string, unknown>;
}

/** What a gateway may inspect to authenticate an inbound callback. */
export interface CallbackAuthInput {
  query: Record<string, unknown> | undefined;
  headers: Record<string, unknown>;
  /** Present only where a gateway needs the unparsed body for a signature. */
  rawBody?: Buffer;
}

export interface PaymentGateway {
  readonly name: GatewayName;
  /** False when credentials are absent — lets the service boot without them. */
  isConfigured(): boolean;
  /** Initiates a charge. Never called inside a database transaction. */
  charge(request: ChargeRequest): Promise<ChargeResult>;
  /**
   * Decides whether an inbound callback genuinely came from this gateway.
   *
   * Part of the interface because it is the security-critical half of accepting
   * one, and leaving it out was how it ended up living beside the M-Pesa
   * implementation and being imported directly by the webhook route. A second
   * gateway implementing this interface would have been told how to parse a
   * callback and never told it had to authenticate one — which is exactly how
   * an implementation ships with a verifier that returns true.
   *
   * The argument is wider than any single gateway needs: M-Pesa carries a token
   * on the query string, while an HMAC scheme needs the raw body and a header.
   * That is a deliberate trade — a narrow signature per gateway would mean the
   * route knowing which gateway it is talking to, which is the coupling being
   * removed.
   *
   * **Must fail closed.** An implementation that cannot verify has not verified.
   */
  authenticateCallback(input: CallbackAuthInput): boolean;

  /** Parses an inbound webhook body into a normalised settlement. */
  parseCallback(body: unknown): SettlementResult;
  /** Polls the gateway — used when a callback never arrived. */
  queryStatus(gatewayRef: string): Promise<SettlementResult>;
}
