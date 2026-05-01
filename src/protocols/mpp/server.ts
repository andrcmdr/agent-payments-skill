// MPP — Machine Payments Protocol — Server.
//
// Accept payments from external agents using the MPP lifecycle:
//   POST /mpp/quote        issue a quote
//   POST /mpp/invoice      issue a signed, content-addressed invoice
//   POST /mpp/settle       settle an invoice via the chosen rail
//   GET  /mpp/receipt/:id  fetch (or re-fetch) the signed receipt
//   GET  /mpp/invoices/:id fetch invoice by id
//
import { Router, Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getConfig } from "../../config/loader";
import { getLogger } from "../../logging/logger";
import { auditLog } from "../../db/audit";
import { executeWeb2Payment } from "../../payments/web2/gateways";
import type { X402PaymentPayload } from "../x402/client";
import type {
  MPPInvoice,
  MPPQuote,
  MPPRail,
  MPPReceipt,
} from "./types";
import { MPP_VERSION } from "./types";

export const mppRouter = Router();

// ─── In-memory stores ──────────────────────────────────────────────────────
// In production, quotes, invoices and receipts should be persisted.

interface QuoteEntry {
  quote: MPPQuote;
  created_at: string;
}
interface InvoiceEntry {
  invoice: MPPInvoice;
  status: "issued" | "settled" | "failed";
  receipt?: MPPReceipt;
}

const _quotes = new Map<string, QuoteEntry>();
const _invoices = new Map<string, InvoiceEntry>();

// ─── Helpers ───────────────────────────────────────────────────────────────

function canonicalize(obj: unknown): string {
  // Deterministic JSON serialization (sorted keys) for content-addressing
  // and signature stability.
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
  const entries = Object.keys(obj as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

function signPayload(payload: unknown, label: string): string {
  // Placeholder HMAC-style "signature" derived from the server's MPP signing
  // secret. A real deployment should use ECDSA with a persistent key.
  const config = getConfig();
  const secret =
    config.protocols?.mpp?.signing_secret ??
    process.env.MPP_SIGNING_SECRET ??
    "mpp-default-signing-secret-change-me";
  return createHash("sha256")
    .update(`${label}|${secret}|${canonicalize(payload)}`)
    .digest("hex");
}

function hashInvoiceId(invoiceBody: Record<string, unknown>): string {
  const h = createHash("sha256").update(canonicalize(invoiceBody)).digest("hex");
  return `inv_${h.slice(0, 32)}`;
}

// ─── Validation ────────────────────────────────────────────────────────────

const QuoteRequestSchema = z.object({
  mpp_version: z.string(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.string(),
  recipient: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const InvoiceRequestSchema = z.object({
  mpp_version: z.string(),
  quote_id: z.string().min(1),
  preferred_rail: z.string().optional(),
});

const SettleRequestSchema = z.object({
  mpp_version: z.string(),
  invoice_id: z.string().min(1),
  rail: z.enum(["x402", "stripe", "paypal", "card", "crypto"]),
  payload: z.record(z.unknown()),
  payer: z
    .object({ agent_id: z.string().optional(), user_id: z.string().optional() })
    .optional(),
});

// ─── POST /quote ───────────────────────────────────────────────────────────

mppRouter.post("/quote", (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const body = QuoteRequestSchema.parse(req.body);
    const config = getConfig();
    const mppConfig = config.protocols?.mpp ?? {};

    const accepted_rails: MPPRail[] =
      (mppConfig.accepted_rails as MPPRail[] | undefined) ?? ["x402", "stripe"];
    const quote: MPPQuote = {
      mpp_version: MPP_VERSION,
      quote_id: `quo_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
      merchant_id: mppConfig.merchant_id ?? "agentic-payments-bot",
      amount: body.amount,
      currency: body.currency,
      accepted_rails,
      network: mppConfig.default_network ?? "base",
      asset: mppConfig.default_asset ?? body.currency,
      pay_to: mppConfig.pay_to,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      description: body.description,
      metadata: body.metadata,
    };

    _quotes.set(quote.quote_id, { quote, created_at: new Date().toISOString() });
    auditLog("info", "mpp_server", "quote_issued", {
      quote_id: quote.quote_id,
      amount: quote.amount,
      currency: quote.currency,
    });
    logger.info("MPP server: quote issued", { quote_id: quote.quote_id });
    res.status(200).json(quote);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ─── POST /invoice ─────────────────────────────────────────────────────────

mppRouter.post("/invoice", (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const body = InvoiceRequestSchema.parse(req.body);
    const entry = _quotes.get(body.quote_id);
    if (!entry) {
      res.status(404).json({ error: "Unknown quote_id" });
      return;
    }

    if (new Date(entry.quote.expires_at) < new Date()) {
      res.status(410).json({ error: "Quote has expired" });
      return;
    }

    const chosenRail: MPPRail =
      (body.preferred_rail as MPPRail | undefined) &&
      entry.quote.accepted_rails.includes(body.preferred_rail as MPPRail)
        ? (body.preferred_rail as MPPRail)
        : entry.quote.accepted_rails[0];

    const unsigned: Omit<MPPInvoice, "invoice_id" | "signature"> = {
      mpp_version: MPP_VERSION,
      quote_id: entry.quote.quote_id,
      merchant_id: entry.quote.merchant_id,
      amount: entry.quote.amount,
      currency: entry.quote.currency,
      rail: chosenRail,
      network: entry.quote.network,
      asset: entry.quote.asset,
      pay_to: entry.quote.pay_to,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      resource: (entry.quote.metadata?.resource as string | undefined) ?? undefined,
      merchant_ref: randomBytes(8).toString("hex"),
      metadata: entry.quote.metadata,
    };

    const invoice_id = hashInvoiceId(unsigned);
    const invoice: MPPInvoice = {
      ...unsigned,
      invoice_id,
      signature: signPayload({ ...unsigned, invoice_id }, "invoice"),
    };

    _invoices.set(invoice_id, { invoice, status: "issued" });
    auditLog("info", "mpp_server", "invoice_issued", {
      invoice_id,
      quote_id: entry.quote.quote_id,
      rail: chosenRail,
    });
    logger.info("MPP server: invoice issued", { invoice_id, rail: chosenRail });
    res.status(201).json(invoice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ─── POST /settle ──────────────────────────────────────────────────────────

mppRouter.post("/settle", async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const body = SettleRequestSchema.parse(req.body);
    const entry = _invoices.get(body.invoice_id);
    if (!entry) {
      res.status(404).json({ error: "Unknown invoice_id" });
      return;
    }
    if (entry.status === "settled") {
      res.status(409).json({ error: "Invoice already settled", receipt: entry.receipt });
      return;
    }
    if (new Date(entry.invoice.expires_at) < new Date()) {
      res.status(410).json({ error: "Invoice has expired" });
      return;
    }
    if (body.rail !== entry.invoice.rail) {
      res.status(400).json({ error: `Invoice rail is ${entry.invoice.rail}, got ${body.rail}` });
      return;
    }

    const receipt = await settleOnRail(entry.invoice, body.rail, body.payload);

    entry.receipt = receipt;
    entry.status = receipt.status === "settled" ? "settled" : "failed";

    auditLog(
      receipt.status === "settled" ? "info" : "error",
      "mpp_server",
      "invoice_settled",
      {
        invoice_id: entry.invoice.invoice_id,
        receipt_id: receipt.receipt_id,
        rail: receipt.rail,
        status: receipt.status,
      }
    );
    logger.info("MPP server: invoice settled", {
      invoice_id: entry.invoice.invoice_id,
      status: receipt.status,
    });

    const http = receipt.status === "settled" ? 200 : receipt.status === "pending" ? 202 : 400;
    res.status(http).json(receipt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ─── GET /receipt/:invoiceId ───────────────────────────────────────────────

mppRouter.get("/receipt/:invoiceId", (req: Request, res: Response) => {
  const entry = _invoices.get(req.params.invoiceId);
  if (!entry || !entry.receipt) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.json(entry.receipt);
});

// ─── GET /invoices/:invoiceId ──────────────────────────────────────────────

mppRouter.get("/invoices/:invoiceId", (req: Request, res: Response) => {
  const entry = _invoices.get(req.params.invoiceId);
  if (!entry) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json({ invoice: entry.invoice, status: entry.status });
});

// ─── GET /invoices — list (debug / admin) ──────────────────────────────────

mppRouter.get("/invoices", (_req: Request, res: Response) => {
  const entries = Array.from(_invoices.values()).map(({ invoice, status }) => ({
    invoice_id: invoice.invoice_id,
    quote_id: invoice.quote_id,
    amount: invoice.amount,
    currency: invoice.currency,
    rail: invoice.rail,
    status,
    created_at: invoice.created_at,
  }));
  res.json({ invoices: entries });
});

// ─── Rail settlement ───────────────────────────────────────────────────────

async function settleOnRail(
  invoice: MPPInvoice,
  rail: MPPRail,
  payload: Record<string, unknown>
): Promise<MPPReceipt> {
  const config = getConfig();
  const baseReceipt: Omit<MPPReceipt, "status" | "signature" | "verified"> = {
    mpp_version: MPP_VERSION,
    receipt_id: `rcpt_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
    invoice_id: invoice.invoice_id,
    rail,
    amount: invoice.amount,
    currency: invoice.currency,
  };

  // Dry-run: short-circuit to a deterministic "settled" receipt.
  if (config.dry_run?.enabled) {
    const receipt: MPPReceipt = {
      ...baseReceipt,
      status: "settled",
      rail_reference: `dryrun_${rail}_${Date.now()}`,
      settled_at: new Date().toISOString(),
    };
    receipt.signature = signPayload(receipt, "receipt");
    receipt.verified = true;
    return receipt;
  }

  try {
    if (rail === "x402") {
      const x402Payload = payload.x402Payload as X402PaymentPayload | undefined;
      if (!x402Payload) throw new Error("x402 rail requires payload.x402Payload");
      // Delegate to the x402 facilitator for actual settlement.
      const facilitatorUrl = config.protocols.x402.facilitator_url;
      const resp = await fetch(`${facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: x402Payload.payload,
          network: x402Payload.network,
          scheme: x402Payload.scheme,
        }),
      });
      if (!resp.ok) throw new Error(`Facilitator rejected: ${resp.status} ${await resp.text()}`);
      const settled = (await resp.json()) as { txHash: string; network: string };
      const receipt: MPPReceipt = {
        ...baseReceipt,
        status: "settled",
        rail_reference: settled.txHash,
        settled_at: new Date().toISOString(),
      };
      receipt.signature = signPayload(receipt, "receipt");
      receipt.verified = true;
      return receipt;
    }

    if (rail === "stripe" || rail === "paypal" || rail === "card") {
      const gateway = rail === "card" ? "stripe" : rail;
      const result = await executeWeb2Payment(gateway, {
        protocol: "ap2",
        action: "pay",
        amount: invoice.amount,
        currency: invoice.currency,
        recipient: (invoice.pay_to as string) ?? invoice.merchant_id,
        description: `MPP invoice ${invoice.invoice_id}`,
        metadata: { ...(invoice.metadata ?? {}), ...payload },
      });
      const receipt: MPPReceipt = {
        ...baseReceipt,
        status: result.status,
        rail_reference: result.transaction_id,
        settled_at: new Date().toISOString(),
        error: result.error,
      };
      receipt.signature = signPayload(receipt, "receipt");
      receipt.verified = true;
      return receipt;
    }

    if (rail === "crypto") {
      const txHash = payload.txHash as string | undefined;
      if (!txHash) throw new Error("crypto rail requires payload.txHash");
      const receipt: MPPReceipt = {
        ...baseReceipt,
        status: "settled",
        rail_reference: txHash,
        settled_at: new Date().toISOString(),
      };
      receipt.signature = signPayload(receipt, "receipt");
      receipt.verified = true;
      return receipt;
    }

    throw new Error(`Unsupported MPP rail: ${rail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failed: MPPReceipt = {
      ...baseReceipt,
      status: "failed",
      error: msg,
      settled_at: new Date().toISOString(),
    };
    failed.signature = signPayload(failed, "receipt");
    failed.verified = true;
    return failed;
  }
}
