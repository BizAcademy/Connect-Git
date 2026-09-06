import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { logger } from "./logger";
import { getMysqlPool } from "./mysql";

export interface ReferralConfig { referrerPct: number; referredPct: number; minDepositFcfa: number; }
const DEFAULT_CONFIG: ReferralConfig = { referrerPct: 5, referredPct: 2, minDepositFcfa: 2000 };
let configCache: { cfg: ReferralConfig; at: number } | null = null;
export async function getReferralConfig(): Promise<ReferralConfig> {
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.cfg;
  const cfg = { ...DEFAULT_CONFIG };
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
    "SELECT `key`,`value` FROM settings WHERE `key` IN ('referral_referrer_pct','referral_referred_pct','referral_min_deposit_fcfa')",
  );
  for (const row of rows) {
    const n = Number(row.value); if (!Number.isFinite(n) || n < 0) continue;
    if (row.key === "referral_referrer_pct") cfg.referrerPct = n;
    if (row.key === "referral_referred_pct") cfg.referredPct = n;
    if (row.key === "referral_min_deposit_fcfa") cfg.minDepositFcfa = n;
  }
  configCache = { cfg, at: Date.now() }; return cfg;
}
const minor = (n: number) => Math.round(n * 100);

/** Claims a qualifying referral and credits both legs in one InnoDB transaction. */
export async function maybeAwardReferralBonus(referredUserId: string, paymentId: string, amountFcfa: number): Promise<void> {
  if (!Number.isFinite(amountFcfa) || amountFcfa <= 0) return;
  const cfg = await getReferralConfig(); const conn = await getMysqlPool().getConnection();
  try {
    await conn.beginTransaction();
    const [found] = await conn.execute<RowDataPacket[]>(
      "SELECT * FROM referrals WHERE referred_user_id=? AND status IN ('pending','processing') FOR UPDATE", [referredUserId],
    );
    const r = found[0]; if (!r) { await conn.commit(); return; }
    if (r.status === "pending") {
      if (amountFcfa < cfg.minDepositFcfa) { await conn.commit(); return; }
      const referrerBonus = minor(Math.floor(amountFcfa * cfg.referrerPct / 100));
      const referredBonus = minor(Math.floor(amountFcfa * cfg.referredPct / 100));
      await conn.execute(
        "UPDATE referrals SET status='processing',qualifying_payment_id=?,qualifying_amount_minor=?,referrer_bonus_minor=?,referred_bonus_minor=? WHERE id=?",
        [paymentId, minor(Math.round(amountFcfa)), referrerBonus, referredBonus, r.id],
      );
      r.referrer_bonus_minor = referrerBonus; r.referred_bonus_minor = referredBonus;
    }
    // Lock balances in a stable UUID order, avoiding deadlocks between recovery calls.
    const ids = [String(r.referrer_user_id), String(r.referred_user_id)].sort();
    const [profiles] = await conn.execute<RowDataPacket[]>("SELECT user_id,balance_minor FROM profiles WHERE user_id IN (?,?) ORDER BY user_id FOR UPDATE", ids);
    if (profiles.length !== 2) throw new Error("Referral profile missing");
    const balances = new Map(profiles.map(p => [String(p.user_id), Number(p.balance_minor)]));
    const legs: Array<["referrer" | "referred", string, number, string]> = [
      ["referrer", String(r.referrer_user_id), Number(r.referrer_bonus_minor), "referral_referrer_bonus"],
      ["referred", String(r.referred_user_id), Number(r.referred_bonus_minor), "referral_referred_bonus"],
    ];
    for (const [leg, userId, amount, type] of legs) {
      const flag = `${leg}_credited_at`;
      if (r[flag]) continue;
      const before = balances.get(userId)!; const after = before + amount;
      const [insert] = await conn.execute(
        "INSERT IGNORE INTO wallet_transactions (id,user_id,amount_minor,balance_after_minor,currency,type,reference_type,reference_id) VALUES (?,?,?,?, 'XOF',?,'referral',?)",
        [crypto.randomUUID(), userId, amount, after, type, r.id],
      );
      if ((insert as any).affectedRows) {
        await conn.execute("UPDATE profiles SET balance_minor=?, affiliate_earnings_minor=affiliate_earnings_minor + ? WHERE user_id=?", [after, leg === "referrer" ? amount : 0, userId]);
        await conn.execute("INSERT INTO balance_audit_log (user_id,previous_balance_minor,new_balance_minor,reason,actor_user_id) VALUES (?,?,?,?,NULL)", [userId, before, after, type]);
        balances.set(userId, after);
      }
      await conn.execute(`UPDATE referrals SET ${flag}=COALESCE(${flag},NOW()) WHERE id=?`, [r.id]);
    }
    await conn.execute("UPDATE referrals SET status='paid',paid_at=COALESCE(paid_at,NOW()) WHERE id=? AND referrer_credited_at IS NOT NULL AND referred_credited_at IS NOT NULL", [r.id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); logger.error({ err, referredUserId, paymentId }, "referral bonus failed"); }
  finally { conn.release(); }
}
export async function recoverStuckReferrals(limit = 10): Promise<void> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT referred_user_id,qualifying_payment_id,qualifying_amount_minor FROM referrals WHERE status='processing' ORDER BY created_at ASC LIMIT ?", [limit]);
  for (const row of rows) await maybeAwardReferralBonus(String(row.referred_user_id), String(row.qualifying_payment_id), Number(row.qualifying_amount_minor) / 100);
}
const CODE_RE = /^[A-Z0-9]{4,20}$/;
export function normalizeCode(raw: unknown): string | null { const code = typeof raw === "string" ? raw.trim().toUpperCase() : ""; return CODE_RE.test(code) ? code : null; }
export async function findCodeOwner(code: string): Promise<string | null> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT user_id FROM profiles WHERE referral_code=? LIMIT 1", [code]);
  return rows[0] ? String(rows[0].user_id) : null;
}
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export async function ensureReferralCode(userId: string): Promise<string | null> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT referral_code FROM profiles WHERE user_id=? LIMIT 1", [userId]);
  if (!rows[0]) return null; if (rows[0].referral_code) return String(rows[0].referral_code);
  for (let n = 0; n < 5; n++) {
    let code = "BB"; for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    try {
      const [result] = await getMysqlPool().execute("UPDATE profiles SET referral_code=? WHERE user_id=? AND referral_code IS NULL", [code, userId]);
      if ((result as any).affectedRows) return code;
      const [again] = await getMysqlPool().execute<RowDataPacket[]>("SELECT referral_code FROM profiles WHERE user_id=?", [userId]);
      return again[0]?.referral_code ? String(again[0].referral_code) : null;
    } catch (err: any) { if (err?.code !== "ER_DUP_ENTRY") throw err; }
  } return null;
}