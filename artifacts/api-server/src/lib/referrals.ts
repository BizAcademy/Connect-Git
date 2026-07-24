// Système d'affiliation — logique métier côté serveur.
//
// Règle (validée par le propriétaire) : « bonus reporté » — le bonus s'applique
// au PREMIER dépôt complété d'au moins `referral_min_deposit_fcfa` (défaut
// 2000 FCFA, montant APRÈS conversion en FCFA), même si des dépôts plus petits
// l'ont précédé. Tant qu'aucun dépôt qualifié n'existe, la ligne `referrals`
// reste en statut 'pending'.
//
// Toutes les écritures passent par la clé service_role : le trigger SQL de la
// migration 018 interdit toute modification de balance par un autre rôle.

import { logger } from "./logger";

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

// ── Configuration (table settings, avec valeurs par défaut) ────────────────

export interface ReferralConfig {
  /** % du premier dépôt qualifié versé au parrain (défaut 5). */
  referrerPct: number;
  /** % du premier dépôt qualifié versé au filleul (défaut 2). */
  referredPct: number;
  /** Dépôt minimum en FCFA pour déclencher les bonus (défaut 2000). */
  minDepositFcfa: number;
}

const DEFAULT_CONFIG: ReferralConfig = { referrerPct: 5, referredPct: 2, minDepositFcfa: 2000 };
const CONFIG_TTL_MS = 60_000;
let configCache: { cfg: ReferralConfig; at: number } | null = null;

export async function getReferralConfig(): Promise<ReferralConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.cfg;
  const cfg: ReferralConfig = { ...DEFAULT_CONFIG };
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/settings?key=in.(referral_referrer_pct,referral_referred_pct,referral_min_deposit_fcfa)&select=key,value`,
        { headers: svcHeaders() },
      );
      if (r.ok) {
        const rows = (await r.json()) as { key: string; value: string }[];
        for (const row of rows) {
          const v = parseFloat(row.value);
          if (!Number.isFinite(v) || v < 0) continue;
          if (row.key === "referral_referrer_pct") cfg.referrerPct = v;
          if (row.key === "referral_referred_pct") cfg.referredPct = v;
          if (row.key === "referral_min_deposit_fcfa") cfg.minDepositFcfa = v;
        }
      }
    } catch (err) {
      logger.warn({ err }, "getReferralConfig: settings read failed — using defaults");
    }
  }
  configCache = { cfg, at: Date.now() };
  return cfg;
}

// ── Attribution du bonus de parrainage ──────────────────────────────────────
//
// Machine à états (colonne referrals.status) :
//   pending    → en attente d'un premier dépôt qualifié
//   processing → dépôt qualifié réclamé (CAS), montants figés, crédits en cours
//   paid       → les deux bonus crédités
//
// Chaque crédit (« jambe » parrain / filleul) est exécuté par la fonction SQL
// award_referral_leg (migration 020) dans UNE transaction Postgres : crédit du
// solde ET pose du drapeau *_credited_at ensemble, verrou ligne inclus. Le
// drapeau est donc une PREUVE de crédit — pas une simple réclamation :
//   - rejouable à l'infini sans double paiement (drapeau posé → no-op),
//   - une coupure en plein vol annule tout (la ligne reste `processing`),
//   - aucune compensation côté Node nécessaire.
// Une ligne bloquée en `processing` est reprise automatiquement par
// recoverStuckReferrals() (scanner) et par tout nouveau dépôt du filleul
// → aucun bonus ne peut être perdu silencieusement.

interface ReferralRow {
  id: string;
  referrer_user_id: string;
  referred_user_id: string;
  status: string;
  referrer_bonus_fcfa: number | null;
  referred_bonus_fcfa: number | null;
  referrer_credited_at: string | null;
  referred_credited_at: string | null;
}

const REFERRAL_SELECT =
  "id,referrer_user_id,referred_user_id,status,referrer_bonus_fcfa,referred_bonus_fcfa,referrer_credited_at,referred_credited_at";

interface AwardLegResult {
  ok?: boolean;
  already?: boolean;
  credited?: number;
  paid?: boolean;
  error?: string;
  status?: string;
}

/**
 * Règle une jambe (parrain ou filleul) via la fonction SQL atomique
 * award_referral_leg. Renvoie true si la jambe est payée (maintenant ou avant).
 * En cas d'échec ou d'exception, renvoie false : la ligne reste `processing`
 * et la reprise automatique rejouera l'appel — sans risque, la fonction SQL
 * est idempotente.
 */
async function settleLeg(referral: ReferralRow, leg: "referrer" | "referred"): Promise<boolean> {
  const flagCol: "referrer_credited_at" | "referred_credited_at" =
    leg === "referrer" ? "referrer_credited_at" : "referred_credited_at";
  if (referral[flagCol]) return true; // preuve de crédit déjà posée

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/award_referral_leg`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({ p_referral_id: referral.id, p_leg: leg }),
    });
    if (!r.ok) {
      const body = await r.text();
      if (r.status === 404 || body.includes("42883")) {
        logger.error(
          { referralId: referral.id },
          "award_referral_leg RPC absente — migration 020 incomplète (exécutez la version à jour)",
        );
      } else {
        logger.error(
          { referralId: referral.id, leg, status: r.status, body: body.slice(0, 150) },
          "referral leg RPC failed — recovery will retry",
        );
      }
      return false;
    }
    const out = (await r.json()) as AwardLegResult;
    if (out.ok) {
      if (!out.already) {
        logger.info({ referralId: referral.id, leg, credited: out.credited }, "referral leg credited (atomic)");
      }
      if (out.paid) logger.info({ referralId: referral.id }, "referral fully paid");
      return true;
    }
    if (out.status === "paid") return true; // finalisé par un appel concurrent
    logger.error({ referralId: referral.id, leg, error: out.error }, "referral leg refused by RPC");
    return false;
  } catch (err) {
    // Pas d'ambiguïté financière : la transaction SQL est tout-ou-rien. Si
    // l'appel a abouti côté DB, le drapeau est posé et le prochain passage
    // le verra ; sinon rien n'a été écrit. Aucune compensation nécessaire.
    logger.error({ err, referralId: referral.id, leg }, "referral leg RPC threw — recovery will retry");
    return false;
  }
}

/**
 * Règle les deux jambes d'un parrainage en `processing`. La finalisation
 * processing → paid est faite PAR la fonction SQL dès que les deux preuves de
 * crédit sont posées. Si une jambe échoue, la ligne reste `processing` et la
 * reprise automatique s'en chargera.
 */
async function settleReferral(referral: ReferralRow): Promise<void> {
  await settleLeg(referral, "referrer");
  await settleLeg(referral, "referred");
}

/**
 * Appelée après CHAQUE crédit de dépôt réussi (webhook, polling, admin,
 * scanner — tous passent par creditDeposit). Ne fait rien si :
 *  - l'utilisateur n'a pas de parrainage en attente,
 *  - le montant (FCFA) est sous le seuil minimum (le parrainage reste pending),
 *  - le bonus a déjà été payé (CAS sur status → idempotent).
 * Reprend aussi une attribution interrompue (statut processing).
 *
 * Ne lève jamais : toute erreur est loggée sans impacter le crédit du dépôt.
 */
export async function maybeAwardReferralBonus(
  referredUserId: string,
  paymentId: string,
  amountFcfa: number,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  if (!Number.isFinite(amountFcfa) || amountFcfa <= 0) return;

  // 1. Parrainage à traiter pour ce filleul ?
  const pr = await fetch(
    `${SUPABASE_URL}/rest/v1/referrals?referred_user_id=eq.${encodeURIComponent(referredUserId)}&status=in.(pending,processing)&select=${REFERRAL_SELECT}&limit=1`,
    { headers: svcHeaders() },
  );
  if (!pr.ok) {
    // 42P01 = table absente (migration 020 pas encore appliquée) — silencieux.
    const body = await pr.text();
    if (!body.includes("42P01")) {
      logger.warn({ status: pr.status, body: body.slice(0, 150) }, "referral lookup failed");
    }
    return;
  }
  const found = (await pr.json()) as ReferralRow[];
  const referral = found[0];
  if (!referral) return;

  // 2. Attribution interrompue → reprise avec les montants déjà figés
  //    (le dépôt courant n'entre pas en compte).
  if (referral.status === "processing") {
    await settleReferral(referral);
    return;
  }

  // 3. Seuil minimum (règle « bonus reporté » : sous le seuil, on ne consomme
  //    PAS le parrainage — un dépôt qualifié ultérieur le déclenchera).
  const cfg = await getReferralConfig();
  if (amountFcfa < cfg.minDepositFcfa) {
    logger.info(
      { referredUserId, paymentId, amountFcfa, min: cfg.minDepositFcfa },
      "referral: deposit below threshold — bonus stays pending",
    );
    return;
  }

  const referrerBonus = Math.floor((amountFcfa * cfg.referrerPct) / 100);
  const referredBonus = Math.floor((amountFcfa * cfg.referredPct) / 100);

  // 4. Réclamation atomique pending → processing (un seul gagnant), montants figés.
  const claim = await fetch(
    `${SUPABASE_URL}/rest/v1/referrals?id=eq.${encodeURIComponent(referral.id)}&status=eq.pending&select=${REFERRAL_SELECT}`,
    {
      method: "PATCH",
      headers: { ...svcHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({
        status: "processing",
        qualifying_payment_id: paymentId,
        qualifying_amount_fcfa: Math.round(amountFcfa),
        referrer_bonus_fcfa: referrerBonus,
        referred_bonus_fcfa: referredBonus,
      }),
    },
  );
  if (!claim.ok) {
    logger.error({ referralId: referral.id, status: claim.status }, "referral claim PATCH failed");
    return;
  }
  const claimed = (await claim.json()) as ReferralRow[];
  if (!claimed[0]) return; // réclamé par un appel concurrent

  logger.info(
    { referralId: referral.id, paymentId, amountFcfa, referrerBonus, referredBonus },
    "referral qualified deposit claimed — crediting bonuses",
  );
  await settleReferral(claimed[0]);
}

/**
 * Reprise automatique : re-règle les parrainages bloqués en `processing`
 * (crédit échoué ou serveur interrompu en plein milieu). Appelée
 * périodiquement par le scanner de paiements. Sûre en concurrence (CAS par
 * jambe) et silencieuse tant que la migration 020 n'est pas appliquée.
 */
export async function recoverStuckReferrals(limit = 10): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?status=eq.processing&select=${REFERRAL_SELECT}&order=created_at.asc&limit=${limit}`,
      { headers: svcHeaders() },
    );
    if (!r.ok) return; // table absente ou indisponible — prochain passage
    const rows = (await r.json()) as ReferralRow[];
    for (const row of rows) {
      logger.warn({ referralId: row.id }, "referral recovery: resuming stuck referral");
      await settleReferral(row);
    }
  } catch (err) {
    logger.warn({ err }, "referral recovery failed — will retry next scan");
  }
}

// ── Helpers pour les routes ─────────────────────────────────────────────────

const CODE_RE = /^[A-Z0-9]{4,20}$/;

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/** Renvoie le user_id du propriétaire d'un code, ou null si le code n'existe pas. */
export async function findCodeOwner(code: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?referral_code=eq.${encodeURIComponent(code)}&select=user_id&limit=1`,
    { headers: svcHeaders() },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCodeJs(): string {
  let out = "BB";
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Garantit qu'un utilisateur possède un referral_code (auto-réparation pour
 * les comptes créés entre le déploiement du code et l'exécution de la
 * migration). Renvoie le code, ou null si impossible.
 */
export async function ensureReferralCode(userId: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const read = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=referral_code`,
    { headers: svcHeaders() },
  );
  if (!read.ok) return null;
  const rows = (await read.json()) as { referral_code: string | null }[];
  if (!rows[0]) return null;
  if (rows[0].referral_code) return rows[0].referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCodeJs();
    const w = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&referral_code=is.null`,
      {
        method: "PATCH",
        headers: { ...svcHeaders(), Prefer: "return=representation" },
        body: JSON.stringify({ referral_code: code }),
      },
    );
    if (w.ok) {
      const updated = (await w.json()) as { referral_code: string | null }[];
      if (updated.length > 0) return updated[0]!.referral_code;
      // 0 ligne : un appel concurrent a déjà posé un code → relire.
      const re = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=referral_code`,
        { headers: svcHeaders() },
      );
      if (re.ok) {
        const rrows = (await re.json()) as { referral_code: string | null }[];
        return rrows[0]?.referral_code ?? null;
      }
      return null;
    }
    // 409 = collision de code (unique_violation) → nouvelle tentative.
    if (w.status !== 409) {
      logger.warn({ userId, status: w.status }, "ensureReferralCode: PATCH failed");
      return null;
    }
  }
  return null;
}
