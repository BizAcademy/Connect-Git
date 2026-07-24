// Routes du système d'affiliation.
//
//   GET  /api/referrals/config      (public)  — pourcentages + dépôt minimum
//   GET  /api/referrals/check/:code (public)  — le code existe-t-il ?
//   POST /api/referrals/visit       (public)  — comptabilise une visite de lien
//   GET  /api/referrals/me          (connecté) — code + statistiques du parrain

import { Router, type IRouter, type Response } from "express";
import { requireUser, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  ensureReferralCode,
  findCodeOwner,
  getReferralConfig,
  normalizeCode,
} from "../lib/referrals";

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

function svcHeaders(): Record<string, string> {
  const key = SUPABASE_SERVICE_ROLE_KEY || "";
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

const router: IRouter = Router();

// ── GET /api/referrals/config ───────────────────────────────────────────────
router.get("/referrals/config", async (_req, res: Response) => {
  const cfg = await getReferralConfig();
  res.json({
    referrer_pct: cfg.referrerPct,
    referred_pct: cfg.referredPct,
    min_deposit_fcfa: cfg.minDepositFcfa,
  });
});

// ── GET /api/referrals/check/:code ──────────────────────────────────────────
router.get("/referrals/check/:code", async (req, res: Response) => {
  const code = normalizeCode(req.params["code"]);
  if (!code) {
    res.json({ valid: false });
    return;
  }
  try {
    const owner = await findCodeOwner(code);
    res.json({ valid: owner !== null });
  } catch (err) {
    logger.warn({ err }, "referrals/check failed");
    res.status(503).json({ valid: false, error: "Vérification indisponible" });
  }
});

// ── POST /api/referrals/visit ───────────────────────────────────────────────
// Corps : { code: string, visitor_key?: string }
// Répond toujours 204 (pas d'énumération de codes possible via cette route).
router.post("/referrals/visit", async (req, res: Response) => {
  res.status(204).end();

  // Traitement en arrière-plan — la réponse est déjà partie.
  try {
    const code = normalizeCode((req.body as Record<string, unknown> | undefined)?.["code"]);
    if (!code || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

    const rawKey = (req.body as Record<string, unknown>)?.["visitor_key"];
    const visitorKey =
      typeof rawKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(rawKey) ? rawKey : null;

    // N'enregistre que les visites de codes réels.
    const owner = await findCodeOwner(code);
    if (!owner) return;

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_visits?on_conflict=code,visitor_key`,
      {
        method: "POST",
        headers: { ...svcHeaders(), Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({ code, visitor_key: visitorKey }),
      },
    );
    if (!r.ok) {
      const body = await r.text();
      if (!body.includes("42P01")) {
        logger.warn({ status: r.status, body: body.slice(0, 150) }, "referral visit insert failed");
      }
    }
  } catch (err) {
    logger.warn({ err }, "referral visit processing failed");
  }
});

// ── GET /api/referrals/me ───────────────────────────────────────────────────
router.get("/referrals/me", requireUser, async (req: AuthedRequest, res: Response) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: "Service non configuré" });
    return;
  }
  const userId = req.userId!;
  try {
    // Profil : code + gains cumulés.
    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=referral_code,affiliate_earnings`,
      { headers: svcHeaders() },
    );
    if (!pr.ok) {
      const body = await pr.text();
      if (body.includes("42703")) {
        // Colonne absente : migration 020 pas encore exécutée.
        res.status(503).json({ error: "Migration 020 requise (colonnes de parrainage absentes)" });
        return;
      }
      logger.error({ status: pr.status, body: body.slice(0, 200) }, "referrals/me profile read failed");
      res.status(502).json({ error: "Lecture du profil impossible" });
      return;
    }
    const profiles = (await pr.json()) as { referral_code: string | null; affiliate_earnings: number | null }[];
    if (!profiles[0]) {
      res.status(404).json({ error: "Profil introuvable" });
      return;
    }

    let code = profiles[0].referral_code;
    if (!code) {
      code = await ensureReferralCode(userId);
      if (!code) {
        res.status(500).json({ error: "Impossible de générer votre code de parrainage" });
        return;
      }
    }

    // Statistiques — en parallèle : visites (count), lignes referrals.
    const [visitsRes, refsRes, cfg] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/referral_visits?code=eq.${encodeURIComponent(code)}&select=id&limit=1`,
        { headers: { ...svcHeaders(), Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" } },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/referrals?referrer_user_id=eq.${encodeURIComponent(userId)}&select=status,qualifying_amount_fcfa,referrer_bonus_fcfa`,
        { headers: svcHeaders() },
      ),
      getReferralConfig(),
    ]);

    let visits = 0;
    if (visitsRes.ok || visitsRes.status === 206) {
      const cr = visitsRes.headers.get("content-range");
      const m = cr ? /\/(\d+)$/.exec(cr) : null;
      if (m) visits = parseInt(m[1]!, 10);
    }

    let signups = 0;
    let paidCount = 0;
    let qualifiedTotal = 0;
    if (refsRes.ok) {
      const rows = (await refsRes.json()) as {
        status: string;
        qualifying_amount_fcfa: number | null;
        referrer_bonus_fcfa: number | null;
      }[];
      signups = rows.length;
      for (const row of rows) {
        if (row.status === "paid") {
          paidCount += 1;
          qualifiedTotal += Number(row.qualifying_amount_fcfa || 0);
        }
      }
    }

    res.json({
      code,
      referrer_pct: cfg.referrerPct,
      referred_pct: cfg.referredPct,
      min_deposit_fcfa: cfg.minDepositFcfa,
      stats: {
        visits,
        signups,
        paid_referrals: paidCount,
        first_deposits_total_fcfa: qualifiedTotal,
        earned_fcfa: Number(profiles[0].affiliate_earnings || 0),
      },
    });
  } catch (err) {
    logger.error({ err }, "referrals/me failed");
    res.status(500).json({ error: "Erreur interne" });
  }
});

export default router;
