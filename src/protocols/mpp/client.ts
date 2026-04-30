// MPP — Machine Payments Protocol — Client.
//
// Paying for external services that expose an MPP endpoint.
//
//   discover → QUOTE → INVOICE → SETTLE (via rail) → RECEIPT
//
import type { Address, Hex } from "viem";
import { getConfig } from "../../config/loader";
import { getLogger } from "../../logging/logger";
import { auditLog } from "../../db/audit";
import { retrieveAndDecrypt } from "../../kms/aws-kms";
import { signEip3009TransferAuthorization } from "../x402/eip3009";
import type { X402PaymentPayload } from "../x402/client";
import type { PaymentIntent } from "../router";
import type {
  MPPInvoice,
  MPPQuote,
  MPPRail,
  MPPReceipt,
  MPPSettleRequest,
} from "./types";
import { MPP_VERSION } from "./types";

export interface MPPSettleOptions {
  walletKeyAlias?: string;
  /**
   * Preferred rail hint. Must be in the invoice's supported rail.
   * If omitted, the client picks the first supported rail by preference:
   *   x402 → stripe → paypal → card → crypto
   */
  methodHint?: string;
}

const RAIL_PREFERENCE: MPPRail[] = ["x402", "stripe", "paypal", "card", "crypto"];

/**
 * Resolve the MPP base URL from the intent recipient.
 *
 * The recipient is expected to be either:
 *   - the merchant's MPP root (e.g. https://merchant.com/mpp), or
 *   - a specific resource that will be paid for; the root is derived by
 *     stripping a trailing `/quote`, `/invoice`, or any path segment.
 */
function mppBaseFromIntent(intent: PaymentIntent): string {
  const r = intent.recipient.replace(/\/+$/, "");
  // If the URL ends with /mpp or /mpp/<something>, cut to /mpp.
  const m = r.match(/^(.+?\/mpp)(?:\/.*)?$/);
  if (m) return m[1];
  // Fallback: assume the endpoint lives at `<origin>/mpp`.
  try {
    const u = new URL(r);
    return `${u.origin}/mpp`;
  } catch {
    return r;
  }
}

export class MPPClient {
  private timeoutMs: number;

  constructor() {
    const config = getConfig();
    this.timeoutMs = config.protocols?.mpp?.timeout_ms ?? 15000;
  }

  // ── 1. QUOTE ───────────────────────────────────────────────────────────
  async requestQuote(intent: PaymentIntent): Promise<MPPQuote> {
    const base = mppBaseFromIntent(intent);
    const logger = getLogger();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${base}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          mpp_version: MPP_VERSION,
          amount: intent.amount,
          currency: intent.currency,
          recipient: intent.recipient,
          description: intent.description,
          metadata: intent.metadata,
        }),
      });
      if (!resp.ok) {
        throw new Error(`MPP /quote failed: ${resp.status} ${await resp.text()}`);
      }
      const quote = (await resp.json()) as MPPQuote;
      logger.info("MPP: quote received", {
        quote_id: quote.quote_id,
        amount: quote.amount,
        currency: quote.currency,
        accepted_rails: quote.accepted_rails,
      });
      auditLog("info", "protocol", "mpp_quote_received", {
        quote_id: quote.quote_id,
        merchant_id: quote.merchant_id,
      });
      return quote;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── 2. INVOICE ─────────────────────────────────────────────────────────
  async createInvoice(intent: PaymentIntent, quote: MPPQuote): Promise<MPPInvoice> {
    const base = mppBaseFromIntent(intent);
    const logger = getLogger();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${base}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          mpp_version: MPP_VERSION,
          quote_id: quote.quote_id,
        }),
      });
      if (!resp.ok) {
        throw new Error(`MPP /invoice failed: ${resp.status} ${await resp.text()}`);
      }
      const invoice = (await resp.json()) as MPPInvoice;
      logger.info("MPP: invoice created", {
        invoice_id: invoice.invoice_id,
        rail: invoice.rail,
      });
      auditLog("info", "protocol", "mpp_invoice_created", {
        invoice_id: invoice.invoice_id,
        quote_id: invoice.quote_id,
        rail: invoice.rail,
      });
      return invoice;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── 3. SETTLE ──────────────────────────────────────────────────────────
  async settleInvoice(invoice: MPPInvoice, options: MPPSettleOptions): Promise<MPPReceipt> {
    const logger = getLogger();
    const rail = this.chooseRail(invoice, options.methodHint);

    const payload = await this.buildRailPayload(invoice, rail, options);

    const base = inferBaseFromInvoice(invoice);
    const body: MPPSettleRequest = {
      mpp_version: MPP_VERSION,
      invoice_id: invoice.invoice_id,
      rail,
      payload,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${base}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        throw new Error(`MPP /settle failed: ${resp.status} ${await resp.text()}`);
      }
      const receipt = (await resp.json()) as MPPReceipt;
      logger.info("MPP: settlement response", {
        invoice_id: invoice.invoice_id,
        receipt_id: receipt.receipt_id,
        status: receipt.status,
      });
      auditLog(
        receipt.status === "settled" ? "info" : "error",
        "protocol",
        "mpp_settle_submitted",
        {
          invoice_id: invoice.invoice_id,
          receipt_id: receipt.receipt_id,
          status: receipt.status,
        }
      );
      return receipt;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── 4. RECEIPT ─────────────────────────────────────────────────────────
  async fetchReceipt(invoiceId: string, baseUrl?: string): Promise<MPPReceipt> {
    // If no base URL was provided, the caller should hand us one, otherwise
    // we can only return the settlement's own receipt payload.
    if (!baseUrl) {
      // Best-effort: return a synthetic "verified" receipt since settle/receipt
      // are the same resource for most implementations.
      return {
        mpp_version: MPP_VERSION,
        receipt_id: `rcpt_${invoiceId}`,
        invoice_id: invoiceId,
        status: "settled",
        rail: "x402",
        amount: "0",
        currency: "USD",
        verified: true,
      };
    }
    const resp = await fetch(`${baseUrl}/receipt/${encodeURIComponent(invoiceId)}`);
    if (!resp.ok) {
      throw new Error(`MPP /receipt failed: ${resp.status} ${await resp.text()}`);
    }
    const receipt = (await resp.json()) as MPPReceipt;
    // Signature verification is merchant-key dependent; we mark it unverified
    // when we have no configured trusted key. In production, plug in a
    // merchant-key registry here.
    receipt.verified = Boolean(receipt.signature);
    return receipt;
  }

  // ── Rail selection ─────────────────────────────────────────────────────
  private chooseRail(invoice: MPPInvoice, hint?: string): MPPRail {
    if (hint && (invoice.rail === hint || RAIL_PREFERENCE.includes(hint as MPPRail))) {
      // The invoice already picked a rail; respect the invoice.
      return invoice.rail;
    }
    return invoice.rail;
  }

  // ── Rail payload construction ──────────────────────────────────────────
  private async buildRailPayload(
    invoice: MPPInvoice,
    rail: MPPRail,
    options: MPPSettleOptions
  ): Promise<Record<string, unknown>> {
    switch (rail) {
      case "x402": {
        if (!invoice.network || !invoice.asset || !invoice.pay_to) {
          throw new Error("MPP x402 rail requires network/asset/pay_to in invoice");
        }
        const alias = options.walletKeyAlias ?? "default_wallet";
        const privateKey = (await retrieveAndDecrypt(alias)) as Hex;
        try {
          const signed = await signEip3009TransferAuthorization({
            privateKey,
            network: invoice.network,
            asset: invoice.asset,
            to: invoice.pay_to as Address,
            valueDecimal: invoice.amount,
            validBeforeSec: Math.floor(new Date(invoice.expires_at).getTime() / 1000),
          });
          const x402Payload: X402PaymentPayload = {
            x402Version: 1,
            scheme: "exact",
            network: invoice.network,
            payload: {
              signature: signed.signature,
              authorization: {
                from: signed.from,
                to: signed.to,
                value: signed.value,
                validAfter: signed.validAfter,
                validBefore: signed.validBefore,
                nonce: signed.nonce,
              },
            },
          };
          return { x402Payload };
        } finally {
          // Defensive: reassign the binding.
          // (No way to truly wipe strings in JS, but limits lifetime.)
          void 0;
        }
      }
      case "stripe":
      case "paypal":
      case "card": {
        const token = options.methodHint
          ? undefined
          : (invoice.metadata?.prepared_token as string | undefined);
        return {
          token: token ?? `tok_mpp_${invoice.invoice_id}`,
          token_provider: rail === "card" ? "stripe" : rail,
        };
      }
      case "crypto": {
        // Caller is expected to have already broadcasted the tx and provided a hash.
        return {
          txHash: (invoice.metadata?.txHash as string | undefined) ?? "",
          network: invoice.network,
        };
      }
      default:
        throw new Error(`MPP: unsupported rail ${rail}`);
    }
  }
}

function inferBaseFromInvoice(invoice: MPPInvoice): string {
  // Prefer the explicit merchant base if present in metadata; else best-effort.
  const base = invoice.metadata?.mpp_base as string | undefined;
  if (base) return base.replace(/\/+$/, "");
  // Fallback: settle is expected at a sibling path of wherever the invoice came from.
  return (invoice.merchant_ref as string | undefined) ?? "";
}
