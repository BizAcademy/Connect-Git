import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger";
import { requireUser, type AuthedRequest } from "../lib/auth";
import {
  creditDeposit,
  markPaymentStatus,
  hasServiceRoleKey,
  fetchPayment,
  BONUS_THRESHOLD_FCFA,
  BONUS_AMOUNT_FCFA,
  isEligibleForBonus,
} from "../lib/deposits";
import {
  isAfribapayConfigured,
  isCountryExcluded,
  listAllowedCountries,
  payin,
  requestOtp,
  getStatus,
  verifyWebhookSignature,
  isSuccessStatus,
  isFailureStatus,
  AfribapayNotConfiguredError,
  AfribapayApiError,
} from "../lib/afribapay";

const router: IRouter = Router();

const SUPABASE_URL = (process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"])!;
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const SUPABASE_ANON_KEY = (process.env["SUPABASE_ANON_KEY"] || process.env["VITE_SUPABASE_ANON_KEY"])!;

// Public base URL of the API server, used to compute the webhook callback URL
// sent to AfribaPay (notify_url). Falls back to the Replit dev domain if set.
const PUBLIC_URL = (
  process.env["PUBLIC_API_URL"]
  || (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "")
);

if (!isAfribapayConfigured()) {
  logger.warn(
    "AfribaPay is not configured: set AFRIBAPAY_API_USER, AFRIBAPAY_API_KEY and "
    + "AFRIBAPAY_MERCHANT_KEY as server secrets. Deposit endpoints will return HTTP 503 until set.",
  );
}
if (!hasServiceRoleKey()) {
  logger.warn(
    "SUPABASE_SERVICE_ROLE_KEY not set — automatic deposit crediting via webhook will not work. "
    + "Admins can still manually credit deposits from the admin panel using their own session.",
  );
}

function serverHeaders() {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

interface InsertPaymentArgs {
  userId: string;
  amount: number;
  userToken: string;
  orderId: string;
  country: string;
  operator: string;
  phoneNumber: string;
  currency: string;
}

async function insertPayment(args: InsertPaymentArgs): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
    method: "POST",
    headers: {
      ...serverHeaders(),
      Authorization: `Bearer ${args.userToken}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: args.userId,
      amount: args.amount,
      method: "afribapay",
      status: "pending",
      order_id: args.orderId,
      country: args.country,
      operator: args.operator,
      phone_number: args.phoneNumber,
      currency: args.currency,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Failed to create payment: HTTP ${r.status} ${body}`);
  }
  const rows = (await r.json()) as Array<{ id: string }>;
  if (!rows[0]?.id) throw new Error("Failed to create payment: empty response");
  return rows[0].id;
}

async function patchPayment(paymentId: string, patch: Record<string, unknown>, userToken?: string) {
  const headers = userToken
    ? { ...serverHeaders(), Authorization: `Bearer ${userToken}` }
    : serverHeaders();
  await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(patch),
  });
}

async function findPaymentByOrderId(orderId: string): Promise<{ id: string; status: string; user_id: string } | null> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/payments?order_id=eq.${encodeURIComponent(orderId)}&select=id,status,user_id&limit=1`,
    { headers: serverHeaders() },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as Array<{ id: string; status: string; user_id: string }>;
  return rows[0] || null;
}

function generateOrderId(userId: string): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `BB-${userId.slice(0, 8)}-${ts}-${rnd}`;
}

function notifyUrl(): string {
  if (!PUBLIC_URL) return "";
  return `${PUBLIC_URL.replace(/\/+$/, "")}/api/payments/webhook`;
}

function pickCurrencyForCountry(c: { currency?: string; code: string }): string {
  if (c.currency) return c.currency.toUpperCase();
  // Fallback heuristic for francophone Africa
  const xof = ["BJ", "BF", "CI", "GW", "ML", "NE", "SN", "TG"];
  const xaf = ["CM", "CF", "TD", "CG", "GQ", "GA"];
  const code = c.code.toUpperCase();
  if (xof.includes(code)) return "XOF";
  if (xaf.includes(code)) return "XAF";
  return "XOF";
}

function extractAfribapayMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, any>;
  // Sandbox/prod wraps real detail inside payload.error.message
  const inner = p["error"] ?? p["data"] ?? p;
  if (inner && typeof inner === "object") {
    const msg = (inner as Record<string, any>)["message"];
    if (typeof msg === "string" && msg) return msg;
  }
  return undefined;
}

function handleAfribapayError(err: unknown, res: import("express").Response) {
  if (err instanceof AfribapayNotConfiguredError) {
    return res.status(503).json({ error: "Service de paiement non configuré" });
  }
  if (err instanceof AfribapayApiError) {
    logger.error({ status: err.status, payload: err.payload }, "AfribaPay API error");
    // Surface the real AfribaPay message when available (e.g. "This phone number is unavailable for testing purposes")
    const realMsg = extractAfribapayMessage(err.payload);
    const userFacingError = realMsg || err.message || "Erreur AfribaPay";
    const httpStatus = err.status === 404 || err.status === 403 ? 400 : 502;
    return res.status(httpStatus).json({ error: userFacingError });
  }
  logger.error({ err }, "AfribaPay unexpected error");
  return res.status(500).json({ error: "Erreur interne" });
}

// ---------------------------------------------------------------------------
// GET /api/payments/bonus-info — public
// ---------------------------------------------------------------------------
router.get("/payments/bonus-info", (_req, res) => {
  res.json({
    threshold_fcfa: BONUS_THRESHOLD_FCFA,
    bonus_fcfa: BONUS_AMOUNT_FCFA,
  });
});

// ---------------------------------------------------------------------------
// GET /api/payments/countries — list of supported countries (GN+CD removed)
// ---------------------------------------------------------------------------
router.get("/payments/countries", async (_req, res) => {
  try {
    const all = await listAllowedCountries();
    // Belt-and-suspenders: re-filter on the way out.
    const safe = all.filter((c) => !isCountryExcluded(c.code));
    res.json({ countries: safe });
  } catch (err) {
    return handleAfribapayError(err, res);
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/otp — request an OTP for an operator that requires it
// ---------------------------------------------------------------------------
router.post("/payments/otp", requireUser, async (req: AuthedRequest, res) => {
  const country = String(req.body?.country || "").toUpperCase();
  const operator = String(req.body?.operator || "");
  const phone = String(req.body?.phone_number || "");
  if (!country || !operator || !phone) {
    return res.status(400).json({ error: "Champs requis : country, operator, phone_number" });
  }
  if (isCountryExcluded(country)) {
    return res.status(400).json({ error: "Pays non supporté" });
  }
  try {
    await requestOtp({ country, operator, phone_number: phone });
    res.json({ ok: true });
  } catch (err) {
    return handleAfribapayError(err, res);
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/initiate — create a PAYIN
// ---------------------------------------------------------------------------
router.post("/payments/initiate", requireUser, async (req: AuthedRequest, res) => {
  const amount = Number(req.body?.amount);
  const country = String(req.body?.country || "").toUpperCase();
  const operator = String(req.body?.operator || "");
  const phone = String(req.body?.phone_number || "").replace(/\s+/g, "");
  const otpCode = req.body?.otp_code ? String(req.body.otp_code) : undefined;

  if (!Number.isFinite(amount) || amount < 500) {
    return res.status(400).json({ error: "Montant minimum : 500 FCFA" });
  }
  if (amount > 10_000_000) {
    return res.status(400).json({ error: "Montant trop élevé" });
  }
  if (!country || !operator || !phone) {
    return res.status(400).json({ error: "Champs requis : country, operator, phone_number" });
  }
  // Defensive double-filter: GN + CD are never allowed even if the client forces them.
  if (isCountryExcluded(country)) {
    return res.status(400).json({ error: "Pays non supporté" });
  }
  if (!isAfribapayConfigured()) {
    return res.status(503).json({ error: "Service de paiement non configuré" });
  }
  if (!notifyUrl()) {
    logger.error("PUBLIC_API_URL (et REPLIT_DEV_DOMAIN) ne sont pas définis : impossible de transmettre une notify_url à AfribaPay.");
    return res.status(503).json({
      error: "Service de paiement temporairement indisponible (URL de callback non configurée).",
    });
  }

  // Resolve currency from the official country list (avoids client-side spoofing).
  let currency = "XOF";
  try {
    const list = await listAllowedCountries();
    const found = list.find((c) => c.code.toUpperCase() === country);
    if (!found) {
      return res.status(400).json({ error: "Pays non supporté" });
    }
    const op = found.operators.find((o) => o.code === operator);
    if (!op) {
      return res.status(400).json({ error: "Opérateur invalide pour ce pays" });
    }
    currency = (op.currency || pickCurrencyForCountry(found)).toUpperCase();
    if (op.otp_required && !otpCode) {
      return res.status(400).json({ error: "Code OTP requis pour cet opérateur" });
    }
  } catch (err) {
    return handleAfribapayError(err, res);
  }

  const orderId = generateOrderId(req.userId!);

  let paymentId: string;
  try {
    paymentId = await insertPayment({
      userId: req.userId!,
      amount,
      userToken: req.userToken!,
      orderId,
      country,
      operator,
      phoneNumber: phone,
      currency,
    });
  } catch (err) {
    logger.error({ err }, "insertPayment failed");
    return res.status(500).json({ error: "Impossible d'enregistrer le paiement" });
  }

  try {
    const result = await payin({
      operator,
      country,
      phone_number: phone,
      amount,
      currency,
      order_id: orderId,
      notify_url: notifyUrl(),
      otp_code: otpCode,
    });
    if (result.transaction_id) {
      await patchPayment(paymentId, { transaction_id: result.transaction_id }, req.userToken!);
    }
    return res.json({
      ok: true,
      payment_id: paymentId,
      order_id: orderId,
      transaction_id: result.transaction_id,
      status: result.status,
      message: result.message
        || "Confirmez la transaction sur votre téléphone (code USSD ou notification mobile money).",
    });
  } catch (err) {
    await patchPayment(paymentId, { status: "failed" }, req.userToken!).catch(() => undefined);
    return handleAfribapayError(err, res);
  }
});

// ---------------------------------------------------------------------------
// GET /api/payments/status/:orderId — polling
// ---------------------------------------------------------------------------
router.get("/payments/status/:orderId", requireUser, async (req: AuthedRequest, res) => {
  const orderId = String(req.params["orderId"] || "");
  if (!orderId) return res.status(400).json({ error: "order_id manquant" });

  const local = await findPaymentByOrderId(orderId);
  if (!local) return res.status(404).json({ error: "Paiement introuvable" });
  if (local.user_id !== req.userId) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  // Already terminal → just return
  if (local.status === "completed") {
    return res.json({ status: "completed", credited: true });
  }
  if (local.status === "failed" || local.status === "rejected") {
    return res.json({ status: local.status, credited: false });
  }

  // Still pending → ask AfribaPay
  if (!isAfribapayConfigured()) {
    return res.json({ status: "pending", credited: false });
  }
  try {
    const remote = await getStatus(orderId);
    if (isSuccessStatus(remote.status)) {
      const result = await creditDeposit(local.id);
      if (result.ok) {
        return res.json({
          status: "completed",
          credited: true,
          already_credited: result.alreadyCredited,
          amount_credited: result.amountCredited,
          bonus_credited: result.bonusCredited,
        });
      }
      logger.error({ paymentId: local.id, err: result.error }, "status: creditDeposit failed");
      return res.json({ status: "pending", credited: false });
    }
    if (isFailureStatus(remote.status)) {
      await markPaymentStatus(local.id, "failed").catch(() => undefined);
      return res.json({ status: "failed", credited: false });
    }
    return res.json({ status: "pending", credited: false, provider_status: remote.status });
  } catch (err) {
    return handleAfribapayError(err, res);
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/webhook — public, signed by AfribaPay
// ---------------------------------------------------------------------------
router.post("/payments/webhook", async (req: Request & { rawBody?: string }, res) => {
  if (!isAfribapayConfigured()) {
    logger.warn("AfribaPay webhook hit but service not configured");
    return res.status(503).json({ ok: false });
  }
  const sign = (req.headers["afribapay-sign"] as string | undefined)
    || (req.headers["Afribapay-Sign"] as unknown as string | undefined)
    || (req.headers["x-afribapay-sign"] as string | undefined);
  const raw = req.rawBody ?? JSON.stringify(req.body ?? {});
  if (!verifyWebhookSignature(raw, sign)) {
    logger.warn({ ip: req.ip }, "AfribaPay webhook: invalid signature");
    return res.status(401).json({ ok: false, error: "Signature invalide" });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const inner = (body["data"] && typeof body["data"] === "object") ? (body["data"] as Record<string, unknown>) : body;
  const orderId = String(inner["order_id"] ?? body["order_id"] ?? "");
  const rawStatus = String(inner["status"] ?? body["status"] ?? "");

  if (!orderId) {
    logger.warn({ body }, "AfribaPay webhook: missing order_id");
    return res.status(400).json({ ok: false, error: "order_id manquant" });
  }

  const local = await findPaymentByOrderId(orderId);
  if (!local) {
    logger.warn({ orderId }, "AfribaPay webhook: payment not found");
    return res.status(200).json({ ok: false, error: "Paiement introuvable" });
  }

  // Update transaction_id if newly known
  const txId = inner["transaction_id"] || inner["transactionId"];
  if (txId) {
    await patchPayment(local.id, { transaction_id: String(txId) }).catch(() => undefined);
  }

  try {
    if (isSuccessStatus(rawStatus)) {
      const result = await creditDeposit(local.id);
      if (!result.ok) {
        logger.error({ paymentId: local.id, err: result.error }, "webhook: creditDeposit failed");
        return res.status(200).json({ ok: false, error: result.error });
      }
      // Defensive lookup just to hydrate the response (tests rely on these fields).
      const fresh = await fetchPayment(local.id).catch(() => null);
      return res.json({
        ok: true,
        already_credited: result.alreadyCredited,
        amount_credited: result.amountCredited,
        bonus_credited: result.bonusCredited,
        status: fresh?.status ?? "completed",
      });
    }
    if (isFailureStatus(rawStatus)) {
      const result = await markPaymentStatus(local.id, "failed");
      if (!result.ok) {
        logger.error({ paymentId: local.id, err: result.error }, "webhook: markPaymentStatus failed");
        return res.status(200).json({ ok: false, error: result.error });
      }
      return res.json({ ok: true, marked: "failed" });
    }
    return res.json({ ok: true, ignored: true, status: rawStatus });
  } catch (err) {
    logger.error({ err, orderId }, "AfribaPay webhook: unexpected error");
    return res.status(200).json({ ok: false, error: "Erreur interne" });
  }
});

export { BONUS_THRESHOLD_FCFA, BONUS_AMOUNT_FCFA, isEligibleForBonus };

export default router;
