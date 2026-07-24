// Persistance du code parrain côté navigateur.
//
// Exigence produit : quand un visiteur arrive via un lien de parrainage
// (/auth?ref=CODE), le code doit rester appliqué et verrouillé sur le
// formulaire d'inscription pendant 1 mois — même si l'utilisateur ferme
// l'onglet ou le navigateur. On utilise un cookie (30 jours) doublé d'un
// miroir localStorage : si l'un des deux survit, le code est retrouvé.

const COOKIE_NAME = "bb_ref_code";
const LS_MIRROR = "bb_ref_code_mirror";
const LS_VISITOR = "bb_visitor_id";
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
const THIRTY_DAYS_MS = THIRTY_DAYS_S * 1000;

export const REF_CODE_RE = /^[A-Z0-9]{4,20}$/;

function setCookie(name: string, value: string, maxAgeSec: number) {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSec}; path=/; SameSite=Lax`;
  } catch { /* cookies désactivés — le miroir localStorage prend le relais */ }
}

function getCookie(name: string): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m && m[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/** Enregistre le code parrain pour 30 jours (cookie + miroir localStorage). */
export function storeRefCode(code: string) {
  setCookie(COOKIE_NAME, code, THIRTY_DAYS_S);
  try {
    localStorage.setItem(LS_MIRROR, JSON.stringify({ code, exp: Date.now() + THIRTY_DAYS_MS }));
  } catch { /* stockage plein/désactivé */ }
}

/** Récupère le code parrain gelé (cookie prioritaire, sinon miroir non expiré). */
export function getStoredRefCode(): string | null {
  const fromCookie = getCookie(COOKIE_NAME);
  if (fromCookie && REF_CODE_RE.test(fromCookie)) return fromCookie;
  try {
    const raw = localStorage.getItem(LS_MIRROR);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code?: string; exp?: number };
    if (
      typeof parsed.code === "string"
      && REF_CODE_RE.test(parsed.code)
      && typeof parsed.exp === "number"
      && parsed.exp > Date.now()
    ) {
      // Auto-réparation : le cookie a disparu mais le miroir est valide.
      setCookie(COOKIE_NAME, parsed.code, Math.floor((parsed.exp - Date.now()) / 1000));
      return parsed.code;
    }
    localStorage.removeItem(LS_MIRROR);
  } catch { /* JSON corrompu */ }
  return null;
}

/** Identifiant anonyme stable du navigateur (dédoublonnage des visites). */
export function getVisitorId(): string {
  try {
    let id = localStorage.getItem(LS_VISITOR);
    if (!id) {
      id = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "")
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(LS_VISITOR, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}

/** Vérifie qu'un code existe. true / false, ou null si l'API est injoignable. */
export async function checkRefCode(code: string): Promise<boolean | null> {
  try {
    const r = await fetch(`/api/referrals/check/${encodeURIComponent(code)}`);
    if (!r.ok) return null;
    const data = (await r.json()) as { valid?: boolean };
    return data.valid === true;
  } catch {
    return null;
  }
}

/** Comptabilise la visite du lien (une seule fois par navigateur et par code). */
export function recordRefVisit(code: string) {
  const marker = `bb_ref_visited_${code}`;
  try {
    if (localStorage.getItem(marker)) return;
  } catch { /* on tente quand même — le serveur dédoublonne aussi */ }
  fetch("/api/referrals/visit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, visitor_key: getVisitorId() }),
  })
    .then(() => {
      try { localStorage.setItem(marker, "1"); } catch { /* ignore */ }
    })
    .catch(() => { /* silencieux — une visite perdue n'est pas critique */ });
}
