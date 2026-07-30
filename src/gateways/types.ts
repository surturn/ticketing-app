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

export interface PaymentGateway {
  readonly name: GatewayName;
  /** False when credentials are absent — lets the service boot without them. */
  isConfigured(): boolean;
  /** Initiates a charge. Never called inside a database transaction. */
  charge(request: ChargeRequest): Promise<ChargeResult>;
  /** Parses an inbound webhook body into a normalised settlement. */
  parseCallback(body: unknown): SettlementResult;
  /** Polls the gateway — used when a callback never arrived. */
  queryStatus(gatewayRef: string): Promise<SettlementResult>;
}
