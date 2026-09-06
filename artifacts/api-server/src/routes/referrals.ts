// Routes du système d'affiliation.
import { Router, type IRouter, type Response } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { requireUser, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  ensureReferralCode,
  findCodeOwner,
  getReferralConfig,
  normalizeCode,
} from "../lib/referrals";
import { getCurrencyInfo, getEffectiveRateByCurrency } from "../lib/currency";
import { ensureRatesLoaded } from "../lib/deposits";
import { getMysqlPool } from "../lib/mysql";

const router: IRouter = Router();
const asIso = (value: unknown): string => new Date(String(value)).toISOString();

router.get("/referrals/config", async (_req, res: Response) => {
  const cfg = await getReferralConfig();
  res.json({
    referrer_pct: cfg.referrerPct,
    referred_pct: cfg.referredPct,
    min_deposit_fcfa: cfg.minDepositFcfa,
  });
});

router.get("/referrals/check/:code", async (req, res: Response) => {
  const code = normalizeCode(req.params["code"]);
  if (!code) return res.json({ valid: false });
  try {
    return res.json({ valid: (await findCodeOwner(code)) !== null });
  } catch (err) {
    logger.warn({ err }, "referrals/check failed");
    return res.status(503).json({ valid: false, error: "Vérification indisponible" });
  }
});

// Always responds 204, so this endpoint cannot be used to enumerate codes.
router.post("/referrals/visit", async (req, res: Response) => {
  res.status(204).end();
  try {
    const code = normalizeCode((req.body as Record<string, unknown> | undefined)?.["code"]);
    if (!code || !(await findCodeOwner(code))) return;
    const rawKey = (req.body as Record<string, unknown> | undefined)?.["visitor_key"];
    const visitorKey = typeof rawKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(rawKey)
      ? rawKey
      : null;
    // MySQL unique indexes allow several NULL values, matching anonymous visit
    // behaviour while deduplicating browser-provided visitor keys.
    await getMysqlPool().execute(
      "INSERT IGNORE INTO referral_visits (code, visitor_key) VALUES (?, ?)",
      [code, visitorKey],
    );
  } catch (err) {
    logger.warn({ err }, "referral visit processing failed");
  }
});

router.get("/referrals/me", requireUser, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  try {
    const [profiles] = await getMysqlPool().execute<RowDataPacket[]>(
      `SELECT referral_code, affiliate_earnings_minor, country, currency
       FROM profiles WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    const profile = profiles[0];
    if (!profile) return res.status(404).json({ error: "Profil introuvable" });

    let code = profile.referral_code ? String(profile.referral_code) : null;
    if (!code) {
      code = await ensureReferralCode(userId);
      if (!code) return res.status(500).json({ error: "Impossible de générer votre code de parrainage" });
    }
    const [[visitRows], [refRows], cfg] = await Promise.all([
      getMysqlPool().execute<(RowDataPacket & { count: number })[]>(
        "SELECT COUNT(*) AS count FROM referral_visits WHERE code = ?", [code],
      ),
      getMysqlPool().execute<RowDataPacket[]>(
        `SELECT status, qualifying_amount_minor, referrer_bonus_minor
         FROM referrals WHERE referrer_user_id = ?`,
        [userId],
      ),
      getReferralConfig(),
    ]);
    const visits = Number(visitRows[0]?.count || 0);
    const signups = refRows.length;
    let paidCount = 0;
    let qualifiedTotalMinor = 0;
    for (const row of refRows) {
      if (row.status === "paid") {
        paidCount += 1;
        qualifiedTotalMinor += Number(row.qualifying_amount_minor || 0);
      }
    }

    await ensureRatesLoaded();
    const currencyCode = String(profile.currency || getCurrencyInfo(profile.country).currency).toUpperCase();
    const rate = getEffectiveRateByCurrency(currencyCode);
    const minDepositLocal = rate > 0 ? Math.ceil(cfg.minDepositFcfa / rate) : cfg.minDepositFcfa;
    return res.json({
      code,
      referrer_pct: cfg.referrerPct,
      referred_pct: cfg.referredPct,
      min_deposit_fcfa: cfg.minDepositFcfa,
      currency: currencyCode,
      min_deposit_local: minDepositLocal,
      stats: {
        visits,
        signups,
        paid_referrals: paidCount,
        first_deposits_total_fcfa: qualifiedTotalMinor / 100,
        earned_fcfa: Number(profile.affiliate_earnings_minor || 0) / 100,
      },
    });
  } catch (err) {
    logger.error({ err }, "referrals/me failed");
    return res.status(500).json({ error: "Erreur interne" });
  }
});

router.get("/referrals/transactions", requireUser, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  try {
    const [[asReferrerRows], [asReferredRows]] = await Promise.all([
      getMysqlPool().execute<RowDataPacket[]>(
        `SELECT r.id, r.referred_user_id, r.referrer_bonus_minor, r.referrer_credited_at,
                p.username AS counterparty_name
         FROM referrals r LEFT JOIN profiles p ON p.user_id = r.referred_user_id
         WHERE r.referrer_user_id = ? AND r.referrer_credited_at IS NOT NULL
         ORDER BY r.referrer_credited_at DESC LIMIT 200`,
        [userId],
      ),
      getMysqlPool().execute<RowDataPacket[]>(
        `SELECT r.id, r.referrer_user_id, r.referred_bonus_minor, r.referred_credited_at,
                p.username AS counterparty_name
         FROM referrals r LEFT JOIN profiles p ON p.user_id = r.referrer_user_id
         WHERE r.referred_user_id = ? AND r.referred_credited_at IS NOT NULL
         ORDER BY r.referred_credited_at DESC LIMIT 5`,
        [userId],
      ),
    ]);
    const out: Array<{
      id: string; kind: "commission"; amount_fcfa: number;
      created_at: string; detail: string; reference: string;
    }> = [];
    const short = (id: string) => id.replace(/-/g, "").slice(0, 8).toUpperCase();
    for (const row of asReferrerRows) {
      const amount = Number(row.referrer_bonus_minor || 0) / 100;
      if (amount <= 0 || !row.referrer_credited_at) continue;
      const who = row.counterparty_name ? String(row.counterparty_name) : "";
      out.push({
        id: `${row.id}-referrer`, kind: "commission", amount_fcfa: amount,
        created_at: asIso(row.referrer_credited_at),
        detail: `Commission de parrainage${who ? ` · filleul ${who}` : ""}`,
        reference: `PAR-${short(String(row.id))}`,
      });
    }
    for (const row of asReferredRows) {
      const amount = Number(row.referred_bonus_minor || 0) / 100;
      if (amount <= 0 || !row.referred_credited_at) continue;
      const who = row.counterparty_name ? String(row.counterparty_name) : "";
      out.push({
        id: `${row.id}-referred`, kind: "commission", amount_fcfa: amount,
        created_at: asIso(row.referred_credited_at),
        detail: `Bonus de bienvenue parrainage${who ? ` · via ${who}` : ""}`,
        reference: `PAR-${short(String(row.id))}`,
      });
    }
    out.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return res.json(out);
  } catch (err) {
    logger.warn({ err }, "referrals/transactions failed");
    return res.json([]);
  }
});

export default router;