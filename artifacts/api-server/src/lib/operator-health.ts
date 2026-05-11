import { logger } from "./logger";

/**
 * Circuit-breaker / health tracker for AfribaPay Mobile Money operators.
 *
 * AfribaPay's `/v1/countries` endpoint is a STATIC catalogue — it does not
 * publish per-operator availability. So we infer availability from real
 * payment attempts:
 *   - When a `payin` (or OTP request) fails with a server-side / availability
 *     style error, we mark the operator as unavailable for `COOLDOWN_MS`.
 *   - When a `payin` succeeds (or AfribaPay returns a clearly user-side
 *     error like "wrong OTP", "insufficient user funds"), we clear the flag.
 *   - `listAllowedCountries()` filters out operators currently in cooldown.
 *
 * State lives in memory only (per process). On restart everything is
 * cleared, which is safe — the next failed attempt re-marks it.
 */

export const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

interface HealthEntry {
  unavailableUntil: number;   // epoch ms
  lastError: string;
  lastFailureAt: number;
  failureCount: number;
}

const state = new Map<string, HealthEntry>();

function key(country: string, operator: string): string {
  return `${String(country).toUpperCase()}:${String(operator).toLowerCase()}`;
}

/**
 * Decide if an error message / HTTP status indicates the OPERATOR (not the
 * user) is at fault. Be conservative: false positives would hide working
 * operators from everyone.
 */
export function isOperatorAvailabilityError(args: {
  httpStatus?: number | null;
  message?: string | null;
  payload?: unknown;
}): boolean {
  const { httpStatus, message, payload } = args;

  // Server-side HTTP errors → operator/AfribaPay infra problem
  if (typeof httpStatus === "number" && httpStatus >= 500) return true;

  const haystack = [
    message ?? "",
    typeof payload === "string" ? payload : "",
    payload && typeof payload === "object" ? JSON.stringify(payload) : "",
  ].join(" ").toLowerCase();

  if (!haystack) return false;

  // Strong availability signals
  const availabilityPatterns = [
    /operator\s+(not|un)?available/i,
    /operator\s+(is\s+)?down/i,
    /operator\s+offline/i,
    /service\s+(is\s+)?(unavailable|indisponible|down|offline)/i,
    /service\s+momentan/i,                 // "momentanément indisponible"
    /provider\s+(unavailable|down|offline)/i,
    /maintenance/i,
    /temporair?ement\s+indisponible/i,     // "temporairement indisponible"
    /momentan[eé]ment\s+indisponible/i,
    /timeout/i,
    /gateway\s+(timeout|error)/i,
    /upstream/i,
    /try\s+again\s+later/i,
    /r[eé]essayez\s+plus\s+tard/i,
  ];
  if (availabilityPatterns.some((re) => re.test(haystack))) return true;

  return false;
}

/**
 * Errors clearly caused by the USER (not the operator). When we see one of
 * these we DON'T mark the operator unavailable — and we even clear any
 * previous flag, since the operator is obviously responding.
 */
export function isUserSideError(args: { message?: string | null; payload?: unknown }): boolean {
  const haystack = [
    args.message ?? "",
    typeof args.payload === "string" ? args.payload : "",
    args.payload && typeof args.payload === "object" ? JSON.stringify(args.payload) : "",
  ].join(" ").toLowerCase();
  if (!haystack) return false;
  const userPatterns = [
    /invalid\s+(otp|code)/i,
    /wrong\s+(otp|code|pin)/i,
    /code\s+otp\s+(invalide|incorrect)/i,
    /insufficient\s+(user\s+)?(funds|balance)/i,
    /solde\s+insuffisant/i,
    /invalid\s+phone/i,
    /num[eé]ro\s+invalide/i,
    /invalid\s+amount/i,
    /montant\s+invalide/i,
    /not\s+a\s+(subscriber|customer)/i,
    /cancell?ed\s+by\s+(user|customer)/i,
    /annul[eé]\s+par/i,
  ];
  return userPatterns.some((re) => re.test(haystack));
}

export function markOperatorFailure(country: string, operator: string, errorMsg: string): void {
  if (!country || !operator) return;
  const k = key(country, operator);
  const prev = state.get(k);
  const entry: HealthEntry = {
    unavailableUntil: Date.now() + COOLDOWN_MS,
    lastError: String(errorMsg).slice(0, 300),
    lastFailureAt: Date.now(),
    failureCount: (prev?.failureCount ?? 0) + 1,
  };
  state.set(k, entry);
  logger.warn(
    { country, operator, until: new Date(entry.unavailableUntil).toISOString(), failureCount: entry.failureCount, err: entry.lastError },
    "operator marked unavailable",
  );
}

export function markOperatorOk(country: string, operator: string): void {
  if (!country || !operator) return;
  const k = key(country, operator);
  if (state.delete(k)) {
    logger.info({ country, operator }, "operator marked healthy (cleared cooldown)");
  }
}

export function isOperatorUnavailable(country: string, operator: string): boolean {
  const k = key(country, operator);
  const e = state.get(k);
  if (!e) return false;
  if (e.unavailableUntil <= Date.now()) {
    state.delete(k); // expired — auto-clean
    return false;
  }
  return true;
}

export interface OperatorHealthSnapshot {
  country: string;
  operator: string;
  unavailableUntil: string;
  lastError: string;
  lastFailureAt: string;
  failureCount: number;
}

export function listUnavailableOperators(): OperatorHealthSnapshot[] {
  const now = Date.now();
  const out: OperatorHealthSnapshot[] = [];
  for (const [k, v] of state.entries()) {
    if (v.unavailableUntil <= now) { state.delete(k); continue; }
    const [country, operator] = k.split(":");
    out.push({
      country: country!,
      operator: operator!,
      unavailableUntil: new Date(v.unavailableUntil).toISOString(),
      lastError: v.lastError,
      lastFailureAt: new Date(v.lastFailureAt).toISOString(),
      failureCount: v.failureCount,
    });
  }
  return out;
}

export function clearOperatorHealth(country?: string, operator?: string): number {
  if (!country) {
    const n = state.size;
    state.clear();
    logger.info({ cleared: n }, "operator health: cleared all");
    return n;
  }
  if (operator) {
    return state.delete(key(country, operator)) ? 1 : 0;
  }
  // clear all operators for a country
  let n = 0;
  const prefix = `${country.toUpperCase()}:`;
  for (const k of [...state.keys()]) {
    if (k.startsWith(prefix)) { state.delete(k); n++; }
  }
  return n;
}
