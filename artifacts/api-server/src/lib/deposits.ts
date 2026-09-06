import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { logger } from "./logger";
import { toFcfa, toFcfaByCurrency, setRateOverrides, isRateCacheValid } from "./currency";
import { getMysqlPool } from "./mysql";
import { maybeAwardReferralBonus } from "./referrals";

export const BONUS_THRESHOLD_FCFA = 5000;
export const BONUS_AMOUNT_FCFA = 200;
export const isEligibleForBonus = (amount: number) => Number.isFinite(amount) && amount >= BONUS_THRESHOLD_FCFA;
const fcfa = (minor: number) => Number(minor) / 100;
const minor = (amount: number) => Math.round(amount * 100);

export interface PaymentRow {
  id: string; user_id: string; amount: number; status: string; reference: string | null; method: string;
  created_at: string; order_id?: string | null; transaction_id?: string | null; bonus_amount?: number | null;
  bonus_status?: string | null; bonus_credited_at?: string | null; credited_at?: string | null;
  currency?: string | null; country?: string | null; operator?: string | null;
}
function mapPayment(r: RowDataPacket): PaymentRow {
  return { id: String(r.id), user_id: String(r.user_id), amount: fcfa(r.amount_minor), status: String(r.status),
    reference: r.reference ?? null, method: r.method ?? r.provider ?? "afribapay",
    created_at: new Date(r.created_at).toISOString(), order_id: r.order_id ?? null, transaction_id: r.transaction_id ?? null,
    bonus_amount: fcfa(r.bonus_amount_minor ?? 0), bonus_status: r.bonus_status ?? null,
    bonus_credited_at: r.bonus_credited_at ? new Date(r.bonus_credited_at).toISOString() : null,
    credited_at: r.credited_at ? new Date(r.credited_at).toISOString() : null,
    currency: r.currency ?? null, country: r.country ?? null, operator: r.operator ?? null };
}
export function hasServiceRoleKey(): boolean { return true; }
export async function fetchPayment(paymentId: string, _userToken?: string): Promise<PaymentRow | null> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT * FROM payments WHERE id = ? LIMIT 1", [paymentId]);
  return rows[0] ? mapPayment(rows[0]) : null;
}
export async function fetchPaymentByOrderId(orderId: string): Promise<PaymentRow | null> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT * FROM payments WHERE order_id = ? LIMIT 1", [orderId]);
  return rows[0] ? mapPayment(rows[0]) : null;
}
export async function createPayment(input: { userId: string; amount: number; orderId: string; country: string; operator: string; phoneNumber: string; currency: string; feeAmount?: number; chargeAmount?: number }): Promise<string> {
  const id = crypto.randomUUID();
  await getMysqlPool().execute(
    `INSERT INTO payments (id,user_id,amount_minor,fee_minor,charge_minor,currency,status,provider,method,order_id,country,operator,phone_number)
     VALUES (?,?,?,?,?,?, 'pending','afribapay','afribapay',?,?,?,?)`,
    [id, input.userId, minor(input.amount), minor(input.feeAmount ?? 0), input.chargeAmount == null ? null : minor(input.chargeAmount),
      input.currency, input.orderId, input.country, input.operator, input.phoneNumber],
  );
  return id;
}
export async function updatePaymentTransaction(paymentId: string, transactionId: string): Promise<void> {
  await getMysqlPool().execute("UPDATE payments SET transaction_id = COALESCE(transaction_id, ?) WHERE id = ?", [transactionId, paymentId]);
}
export async function ensureRatesLoaded(): Promise<void> {
  if (isRateCacheValid()) return;
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT `key`, `value` FROM settings WHERE `key` LIKE 'currency_rate_%'");
  const overrides: Record<string, number> = {};
  for (const row of rows) {
    const m = /^currency_rate_([A-Z]{2})$/i.exec(String(row.key));
    const value = Number(row.value);
    if (m?.[1] && Number.isFinite(value) && value > 0) overrides[m[1].toUpperCase()] = value;
  }
  setRateOverrides(overrides);
}
export type CreditOutcome = { ok: true; alreadyCredited: boolean; amountCredited: number; bonusCredited: number; newBalance: number | null; payment: PaymentRow } | { ok: false; error: string; status?: number };

export async function creditDeposit(paymentId: string, opts?: { userToken?: string; forceBonusCredit?: boolean }): Promise<CreditOutcome> {
  await ensureRatesLoaded();
  const db = getMysqlPool(); const conn = await db.getConnection();
  let outcome: CreditOutcome;
  try {
    await conn.beginTransaction();
    const [payments] = await conn.execute<RowDataPacket[]>("SELECT * FROM payments WHERE id = ? FOR UPDATE", [paymentId]);
    if (!payments[0]) { await conn.rollback(); return { ok: false, error: "Paiement introuvable", status: 404 }; }
    const row = payments[0]; const payment = mapPayment(row);
    const localAmount = fcfa(row.amount_minor);
    let amount = payment.currency ? toFcfaByCurrency(localAmount, payment.currency) : toFcfa(localAmount, payment.country ?? null);
    amount = Math.round(amount);
    const eligible = isEligibleForBonus(amount); const bonus = eligible ? BONUS_AMOUNT_FCFA : 0;
    const onlyBonus = Boolean(opts?.forceBonusCredit && row.credited_at && eligible && row.bonus_status !== "credited");
    if (row.credited_at && !onlyBonus) { await conn.commit(); return { ok: true, alreadyCredited: true, amountCredited: 0, bonusCredited: 0, newBalance: null, payment }; }
    const totalMinor = minor(onlyBonus ? bonus : amount + bonus);
    const [profiles] = await conn.execute<RowDataPacket[]>("SELECT balance_minor FROM profiles WHERE user_id = ? FOR UPDATE", [row.user_id]);
    if (!profiles[0]) throw new Error("Profil introuvable");
    const before = Number(profiles[0].balance_minor); const after = before + totalMinor;
    const type = onlyBonus ? "deposit_bonus" : "deposit";
    const [insert] = await conn.execute(
      `INSERT IGNORE INTO wallet_transactions (id,user_id,amount_minor,balance_after_minor,currency,type,reference_type,reference_id)
       VALUES (?,?,?,?,? ,?,'payment',?)`,
      [crypto.randomUUID(), row.user_id, totalMinor, after, row.currency, type, paymentId],
    );
    if ((insert as any).affectedRows === 0) { await conn.commit(); return { ok: true, alreadyCredited: true, amountCredited: 0, bonusCredited: 0, newBalance: null, payment }; }
    await conn.execute("UPDATE profiles SET balance_minor = ? WHERE user_id = ?", [after, row.user_id]);
    await conn.execute("INSERT INTO balance_audit_log (user_id,previous_balance_minor,new_balance_minor,reason,actor_user_id) VALUES (?,?,?,?,NULL)", [row.user_id, before, after, type]);
    if (onlyBonus) await conn.execute("UPDATE payments SET bonus_amount_minor=?, bonus_status='credited', bonus_credited_at=NOW(), balance_after_minor=? WHERE id=?", [minor(bonus), after, paymentId]);
    else await conn.execute("UPDATE payments SET status='completed', credited_at=NOW(), completed_at=NOW(), bonus_amount_minor=?, bonus_status=?, bonus_credited_at=?, balance_before_minor=?, balance_after_minor=? WHERE id=?",
      [minor(bonus), eligible ? "credited" : "not_eligible", eligible ? new Date() : null, before, after, paymentId]);
    await conn.commit();
    outcome = { ok: true, alreadyCredited: false, amountCredited: onlyBonus ? 0 : amount, bonusCredited: bonus, newBalance: fcfa(after), payment: (await fetchPayment(paymentId))! };
    if (!onlyBonus) await maybeAwardReferralBonus(payment.user_id, paymentId, amount);
    return outcome;
  } catch (err) {
    await conn.rollback(); logger.error({ err, paymentId }, "creditDeposit failed");
    return { ok: false, error: "Crédit du solde échoué (réessayez)", status: 500 };
  } finally { conn.release(); }
}
export async function markPaymentStatus(paymentId: string, status: "failed" | "rejected" | "pending", _userToken?: string): Promise<{ ok: boolean; error?: string; status?: number }> {
  const [result] = await getMysqlPool().execute("UPDATE payments SET status=? WHERE id=? AND credited_at IS NULL", [status, paymentId]);
  if ((result as any).affectedRows) return { ok: true };
  const payment = await fetchPayment(paymentId);
  return payment ? { ok: false, error: "Ce dépôt a déjà été crédité — un changement de statut nécessite un remboursement manuel.", status: 409 } : { ok: false, error: "Paiement introuvable", status: 404 };
}