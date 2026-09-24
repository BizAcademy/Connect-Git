import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

type Intent = {
  id: string; status: string; merchantReference?: string;
  requestedCurrencyType: string; currencyRequested: string; amountRequested: string;
  paymentResult?: string | null; irregularStatus?: string | null;
  paymentLink?: string; paymentUrl?: string;
};

export const CRYPTO_DEPOSIT_FEE_BPS = 150;

export function quoteCryptoDeposit(amountMinor: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Montant USD invalide");
  const feeMinor = Math.round(amountMinor * CRYPTO_DEPOSIT_FEE_BPS / 10_000);
  return { feeMinor, chargeMinor: amountMinor + feeMinor };
}

export function storedCryptoCharge(amountMinor: number, feeMinor: number, chargeMinor: number | null): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isSafeInteger(feeMinor) || feeMinor < 0 ||
      !Number.isSafeInteger(amountMinor + feeMinor) || (chargeMinor == null ? feeMinor !== 0 : chargeMinor !== amountMinor + feeMinor)) {
    throw new Error("Montants du paiement incohérents");
  }
  return chargeMinor ?? amountMinor;
}

export function parseUsdMinor(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, cents = ""] = value.split(".");
  const minor = Number(whole) * 100 + Number(cents.padEnd(2, "0"));
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

function apiBase(): string {
  const key = process.env["IZIPAY_API_KEY"];
  if (!key || !/^sk_(test|live)_/.test(key)) throw new Error("Clé IziChange Pay non configurée");
  return key.startsWith("sk_test_") ? "https://api.sandbox-pay.izichange.com" : "https://api.pay.izichange.com";
}
async function api(path: string, init?: { method: string; body: unknown; idempotencyKey: string }): Promise<Intent> {
  const base = apiBase();
  const response = await fetch(`${base}/v1/payment-intents${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${process.env["IZIPAY_API_KEY"]}`,
      ...(init ? { "Content-Type": "application/json", "Idempotency-Key": init.idempotencyKey } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`IziChange Pay a répondu ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || typeof (value as Intent).id !== "string") throw new Error("Réponse IziChange Pay invalide");
  return value as Intent;
}
export function createIntent(amountMinor: number, reference: string, returnUrl: string, email: string) {
  return api("", {
    method: "POST",
    idempotencyKey: reference,
    body: {
      requestedCurrencyType: "fiat", currencyRequested: "USD",
      amountRequested: `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`,
      merchantReference: reference, idempotencyKey: reference,
      returnUrl, customerEmail: email, collectCustomerInformation: true,
      expiresInMinutes: 30, language: "fr",
    },
  });
}
export function retrieveIntent(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Identifiant d'intention invalide");
  return api(`/${encodeURIComponent(id)}`);
}
export function verifyIzipayWebhook(raw: string | undefined, header: string | undefined): { event: string; data: { intentId: string } } {
  const secret = process.env["IZIPAY_WEBHOOK_SECRET"];
  if (!secret || !raw || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) throw new Error("Signature absente");
  const expected = crypto.createHmac("sha256", secret).update(raw).digest();
  const actual = Buffer.from(header.slice(7), "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("Signature invalide");
  const body = JSON.parse(raw);
  if (!Number.isInteger(body.timestamp) || Math.abs(Date.now() / 1000 - body.timestamp) > 300) throw new Error("Webhook expiré");
  if (typeof body.event !== "string" || typeof body.data?.intentId !== "string") throw new Error("Webhook invalide");
  return body;
}

export async function reconcileCryptoPayment(paymentId: string) {
  const db = getMysqlPool();
  const [rows] = await db.execute<RowDataPacket[]>("SELECT * FROM payments WHERE id=? AND provider='izipay'", [paymentId]);
  const payment = rows[0];
  if (!payment || !payment.provider_reference) throw new Error("Intention crypto introuvable");
  // Older pending deposits have no surcharge and a NULL charge_minor.
  const chargedMinor = storedCryptoCharge(Number(payment.amount_minor), Number(payment.fee_minor),
    payment.charge_minor == null ? null : Number(payment.charge_minor));
  const intent = await retrieveIntent(String(payment.provider_reference));
  if (intent.id !== payment.provider_reference || intent.merchantReference !== payment.order_id ||
      intent.currencyRequested !== "USD" || intent.requestedCurrencyType !== "fiat" ||
      parseUsdMinor(intent.amountRequested) !== chargedMinor) {
    throw new Error("Incohérence entre le paiement et l'intention IziChange Pay");
  }
  // An irregular payment may be manually encashed later. Never automatically grant
  // a fixed USD credit for a different amount, even if its status becomes completed.
  const irregular = intent.status === "irregular" ||
    (intent.paymentResult != null && intent.paymentResult !== "exact") ||
    (intent.irregularStatus != null && !["none", ""].includes(intent.irregularStatus));
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [locked] = await conn.execute<RowDataPacket[]>("SELECT * FROM payments WHERE id=? FOR UPDATE", [paymentId]);
    const row = locked[0];
    if (!row || row.provider !== "izipay" || row.provider_reference !== intent.id ||
        row.order_id !== payment.order_id || Number(row.amount_minor) !== Number(payment.amount_minor) ||
        Number(row.fee_minor) !== Number(payment.fee_minor) ||
        storedCryptoCharge(Number(row.amount_minor), Number(row.fee_minor),
          row.charge_minor == null ? null : Number(row.charge_minor)) !== chargedMinor) {
      throw new Error("Paiement modifié");
    }
    if (row.credited_at) { await conn.commit(); return "completed"; }
    if (irregular) {
      await conn.execute("UPDATE payments SET status='irregular' WHERE id=?", [paymentId]);
      await conn.commit(); return "irregular";
    }
    if (intent.status === "completed") {
      const [profiles] = await conn.execute<RowDataPacket[]>("SELECT balance_usd_minor FROM profiles WHERE user_id=? FOR UPDATE", [row.user_id]);
      if (!profiles[0]) throw new Error("Profil introuvable");
      const before = Number(profiles[0].balance_usd_minor), after = before + Number(row.amount_minor);
      await conn.execute("UPDATE profiles SET balance_usd_minor=? WHERE user_id=?", [after, row.user_id]);
      await conn.execute("INSERT INTO wallet_transactions (id,user_id,amount_minor,balance_after_minor,currency,type,reference_type,reference_id) VALUES (?,?,?,?, 'USD','deposit','payment',?)",
        [crypto.randomUUID(), row.user_id, row.amount_minor, after, paymentId]);
      await conn.execute("INSERT INTO balance_audit_log (user_id,previous_balance_minor,new_balance_minor,reason) VALUES (?,?,?,'crypto_usd_deposit')", [row.user_id, before, after]);
      await conn.execute("UPDATE payments SET status='completed',credited_at=NOW(),completed_at=NOW(),balance_before_minor=?,balance_after_minor=? WHERE id=?",
        [before, after, paymentId]);
      await conn.commit(); return "completed";
    }
    const status = ["expired", "failed", "canceled", "cancelled"].includes(intent.status) ? intent.status : "pending";
    await conn.execute("UPDATE payments SET status=? WHERE id=?", [status, paymentId]);
    await conn.commit(); return status;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
}