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
import { getCurrencyInfo, getEffectiveRateByCurrency } from "../lib/currency";
import { ensureRatesLoaded } from "../lib/deposits";

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

    // Insertion simple : l'index unique partiel (code, visitor_key) fait le
    // dédoublonnage. PostgREST ne peut pas cibler un index partiel via
    // `on_conflict` (42P10), donc un doublon renvoie 409/23505 = déjà comptée.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/referral_visits`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({ code, visitor_key: visitorKey }),
    });
    if (!r.ok && r.status !== 409) {
      const body = await r.text();
      if (!body.includes("42P01") && !body.includes("23505")) {
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
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=referral_code,affiliate_earnings,country,currency`,
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
    const profiles = (await pr.json()) as {
      referral_code: string | null;
      affiliate_earnings: number | null;
      country: string | null;
      currency: string | null;
    }[];
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

    // Seuil minimum converti dans la devise de l'utilisateur, avec les MÊMES
    // taux que ceux appliqués au crédit des dépôts (overrides admin inclus).
    await ensureRatesLoaded();
    const currencyCode = (profiles[0].currency || getCurrencyInfo(profiles[0].country).currency).toUpperCase();
    const rate = getEffectiveRateByCurrency(currencyCode);
    const minDepositLocal = rate > 0 ? Math.ceil(cfg.minDepositFcfa / rate) : cfg.minDepositFcfa;

    res.json({
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
        first_deposits_total_fcfa: qualifiedTotal,
        earned_fcfa: Number(profiles[0].affiliate_earnings || 0),
      },
    });
  } catch (err) {
    logger.error({ err }, "referrals/me failed");
    res.status(500).json({ error: "Erreur interne" });
  }
});

// ── GET /api/referrals/transactions ─────────────────────────────────────────
// Commissions de parrainage créditées de l'utilisateur, au format « journal » :
// une ligne par jambe payée (commission du parrain / bonus de bienvenue du
// filleul). Source : table referrals — les drapeaux *_credited_at sont les
// preuves de crédit posées par la fonction SQL atomique.
router.get("/referrals/transactions", requireUser, async (req: AuthedRequest, res: Response) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.json([]);
    return;
  }
  const userId = req.userId!;
  try {
    const enc = encodeURIComponent(userId);
    const [asReferrerRes, asReferredRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/referrals?referrer_user_id=eq.${enc}&referrer_credited_at=not.is.null&select=id,referred_user_id,referrer_bonus_fcfa,referrer_credited_at&order=referrer_credited_at.desc&limit=200`,
        { headers: svcHeaders() },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/referrals?referred_user_id=eq.${enc}&referred_credited_at=not.is.null&select=id,referrer_user_id,referred_bonus_fcfa,referred_credited_at&limit=5`,
        { headers: svcHeaders() },
      ),
    ]);
    const asReferrer = asReferrerRes.ok
      ? ((await asReferrerRes.json()) as {
          id: string; referred_user_id: string;
          referrer_bonus_fcfa: number | null; referrer_credited_at: string | null;
        }[])
      : [];
    const asReferred = asReferredRes.ok
      ? ((await asReferredRes.json()) as {
          id: string; referrer_user_id: string;
          referred_bonus_fcfa: number | null; referred_credited_at: string | null;
        }[])
      : [];

    // Noms des contreparties (une seule requête).
    const otherIds = Array.from(new Set([
      ...asReferrer.map((r) => r.referred_user_id),
      ...asReferred.map((r) => r.referrer_user_id),
    ].filter(Boolean)));
    const names = new Map<string, string>();
    if (otherIds.length > 0) {
      const pr2 = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?user_id=in.(${otherIds.join(",")})&select=user_id,username`,
        { headers: svcHeaders() },
      );
      if (pr2.ok) {
        for (const p of (await pr2.json()) as { user_id: string; username: string | null }[]) {
          if (p.username) names.set(p.user_id, p.username);
        }
      }
    }

    const short = (id: string) => id.replace(/-/g, "").slice(0, 8).toUpperCase();
    const out: {
      id: string; kind: "commission"; amount_fcfa: number;
      created_at: string; detail: string; reference: string;
    }[] = [];
    for (const r of asReferrer) {
      const amount = Number(r.referrer_bonus_fcfa || 0);
      if (amount <= 0 || !r.referrer_credited_at) continue;
      const who = names.get(r.referred_user_id);
      out.push({
        id: `${r.id}-referrer`, kind: "commission", amount_fcfa: amount,
        created_at: r.referrer_credited_at,
        detail: `Commission de parrainage${who ? ` · filleul ${who}` : ""}`,
        reference: `PAR-${short(r.id)}`,
      });
    }
    for (const r of asReferred) {
      const amount = Number(r.referred_bonus_fcfa || 0);
      if (amount <= 0 || !r.referred_credited_at) continue;
      const who = names.get(r.referrer_user_id);
      out.push({
        id: `${r.id}-referred`, kind: "commission", amount_fcfa: amount,
        created_at: r.referred_credited_at,
        detail: `Bonus de bienvenue parrainage${who ? ` · via ${who}` : ""}`,
        reference: `PAR-${short(r.id)}`,
      });
    }
    out.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    res.json(out);
  } catch (err) {
    logger.warn({ err }, "referrals/transactions failed");
    res.json([]);
  }
});

export default router;
