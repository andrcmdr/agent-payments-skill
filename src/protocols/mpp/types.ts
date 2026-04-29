// MPP — Machine Payments Protocol: shared types.
//
// MPP is a HTTP-native, content-addressed payment protocol designed for
// autonomous agents. It composes on top of existing rails (x402 on-chain,
// Stripe/PayPal fiat, etc.) via a uniform quote → invoice → settle → receipt
// lifecycle with signed, verifiable receipts.
//
// Lifecycle:
//   1. QUOTE    — agent asks the merchant for a price + accepted rails
//   2. INVOICE  — merchant issues a content-addressed invoice binding the quote
//   3. SETTLE   — agent pays the invoice through the negotiated rail
//   4. RECEIPT  — merchant returns a signed receipt referencing the invoice
//

export const MPP_VERSION = "1.0";

export type MPPRail = "x402" | "stripe" | "paypal" | "card" | "crypto";

/** Response to `POST /mpp/quote`. */
export interface MPPQuote {
  mpp_version: string;
  quote_id: string;
  merchant_id: string;
  amount: string;           // decimal string
  currency: string;
  accepted_rails: MPPRail[];
  // For on-chain rails
  network?: string;
  asset?: string;
  pay_to?: string;
  /** ISO timestamp after which the quote is no longer honored. */
  expires_at: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/** Response to `POST /mpp/invoice`. */
export interface MPPInvoice {
  mpp_version: string;
  invoice_id: string;       // content-addressed (sha256 of canonical body)
  quote_id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  rail: MPPRail;
  network?: string;
  asset?: string;
  pay_to?: string;
  created_at: string;
  expires_at: string;
  /** Resource URL that will be granted after settlement (if any). */
  resource?: string;
  /** Merchant-specific opaque payload echoed back in settle. */
  merchant_ref?: string;
  /** ECDSA signature of the canonicalized invoice body. */
  signature?: string;
  metadata?: Record<string, unknown>;
}

/** Request body for `POST /mpp/settle`. */
export interface MPPSettleRequest {
  mpp_version: string;
  invoice_id: string;
  rail: MPPRail;
  /**
   * Rail-specific payload.
   *
   * For `rail: "x402"`:
   *   { x402Payload: <X402PaymentPayload> }
   * For `rail: "stripe" | "paypal" | "card"`:
   *   { token: "<tokenized-pm-id>", token_provider: "stripe" }
   * For `rail: "crypto"`:
   *   { txHash: "0x...", network: "base" }
   */
  payload: Record<string, unknown>;
  payer?: {
    agent_id?: string;
    user_id?: string;
  };
}

/** Response from `POST /mpp/settle` and stored as the audit receipt. */
export interface MPPReceipt {
  mpp_version: string;
  receipt_id: string;
  invoice_id: string;
  status: "settled" | "pending" | "failed";
  rail: MPPRail;
  amount: string;
  currency: string;
  /** Underlying rail identifier: tx hash, payment intent id, etc. */
  rail_reference?: string;
  settled_at?: string;
  /** ECDSA signature of the canonicalized receipt body. */
  signature?: string;
  /** True if the receipt's signature was verified by the client. */
  verified?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}
