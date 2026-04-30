import crypto from "node:crypto";
import { logger } from "./logger";

const API_USER = process.env["AFRIBAPAY_API_USER"] ?? "";
const API_KEY = process.env["AFRIBAPAY_API_KEY"] ?? "";
const MERCHANT_KEY = process.env["AFRIBAPAY_MERCHANT_KEY"] ?? "";
const API_BASE = (process.env["AFRIBAPAY_API_BASE"] || "https://api.afribapay.com").replace(/\/+$/, "");

const EXCLUDED_COUNTRIES = new Set(["GN", "CD"]);

export class AfribapayNotConfiguredError extends Error {
  constructor() {
    super("Service de paiement non configuré");
    this.name = "AfribapayNotConfiguredError";
  }
}

export class AfribapayApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, payload: unknown, message?: string) {
    super(message || `AfribaPay HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

export function isAfribapayConfigured(): boolean {
  return Boolean(API_USER && API_KEY && MERCHANT_KEY);
}

function ensureConfigured(): void {
  if (!isAfribapayConfigured()) throw new AfribapayNotConfiguredError();
}

export function isCountryExcluded(code: string | undefined | null): boolean {
  if (!code) return false;
  return EXCLUDED_COUNTRIES.has(String(code).toUpperCase());
}

// ---------------------------------------------------------------------------
// Token cache (Bearer)
// ---------------------------------------------------------------------------
interface TokenEntry {
  token: string;
  expiresAt: number; // epoch ms
}
let cachedToken: TokenEntry | null = null;
// Single in-flight promise shared across all concurrent callers (prevents token flood)
let tokenInflight: Promise<TokenEntry> | null = null;
// After a 401/auth failure, back off for this long before retrying
let tokenBackoffUntil = 0;
const TOKEN_BACKOFF_MS = 20_000; // 20 s cooldown after auth failure

async function fetchNewToken(): Promise<TokenEntry> {
  ensureConfigured();
  const basic = Buffer.from(`${API_USER}:${API_KEY}`).toString("base64");
  const r = await fetch(`${API_BASE}/v1/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* ignore */ }
  if (!r.ok) {
    logger.error({ status: r.status, body }, "AfribaPay token fetch failed");
    // Activate backoff so concurrent/subsequent callers don't immediately retry
    tokenBackoffUntil = Date.now() + TOKEN_BACKOFF_MS;
    throw new AfribapayApiError(r.status, body, "Échec récupération du token AfribaPay");
  }
  const token = body?.access_token || body?.token || body?.data?.access_token;
  const expiresIn = Number(body?.expires_in || body?.data?.expires_in || 90000);
  if (!token) {
    throw new AfribapayApiError(500, body, "Token AfribaPay introuvable dans la réponse");
  }
  // Renew 60s before actual expiry
  return { token, expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000 };
}

async function getToken(): Promise<string> {
  // Valid cached token
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  // Back off after a recent failure — don't hammer AfribaPay
  if (Date.now() < tokenBackoffUntil) {
    const waitSec = Math.ceil((tokenBackoffUntil - Date.now()) / 1000);
    throw new AfribapayApiError(503, null, `AfribaPay auth en attente (${waitSec}s)`);
  }
  // Share a single inflight request among all concurrent callers
  if (tokenInflight) return tokenInflight.then((e) => e.token);
  tokenInflight = fetchNewToken()
    .then((entry) => { cachedToken = entry; return entry; })
    .finally(() => { tokenInflight = null; });
  return tokenInflight.then((e) => e.token);
}

/**
 * Clear all cached token state and backoff.
 * Call this after manually confirming credentials are valid to force a fresh token fetch.
 */
export function resetTokenState(): void {
  cachedToken = null;
  tokenInflight = null;
  tokenBackoffUntil = 0;
  logger.info("AfribaPay token state reset — next request will fetch a fresh token");
}

/** Returns current token backoff state (for diagnostics). */
export function getTokenDiagnostics(): { hasToken: boolean; tokenExpiresAt: number | null; backoffUntil: number; backoffActive: boolean } {
  return {
    hasToken: cachedToken !== null && cachedToken.expiresAt > Date.now(),
    tokenExpiresAt: cachedToken?.expiresAt ?? null,
    backoffUntil: tokenBackoffUntil,
    backoffActive: Date.now() < tokenBackoffUntil,
  };
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<any> {
  ensureConfigured();
  const token = await getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers });
  let body: any = null;
  const text = await r.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  // Token might have been revoked — try once more with a fresh token.
  if (r.status === 401 && cachedToken) {
    cachedToken = null;
    const token2 = await getToken();
    headers.Authorization = `Bearer ${token2}`;
    const r2 = await fetch(`${API_BASE}${path}`, { ...init, headers });
    const text2 = await r2.text();
    let body2: any = null;
    try { body2 = text2 ? JSON.parse(text2) : null; } catch { body2 = text2; }
    if (!r2.ok) throw new AfribapayApiError(r2.status, body2);
    return body2;
  }

  if (!r.ok) throw new AfribapayApiError(r.status, body);
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CountryOperator {
  code: string;          // operator code, e.g. "orange-ci"
  name: string;          // display name
  otp_required: boolean;
  currency?: string;
}
export interface CountryEntry {
  code: string;          // ISO2, e.g. "CI"
  name: string;
  prefix?: string;       // dial prefix, e.g. "+225"
  currency?: string;
  operators: CountryOperator[];
}

export async function listCountries(): Promise<CountryEntry[]> {
  const data = await authedFetch("/v1/countries", { method: "GET" });

  // Normalize to a flat array of raw country rows regardless of API shape:
  //   • array:  [{country_code, operators, ...}, ...]          (production)
  //   • object: {BF: {country_code, currencies: {XOF: {operators}}, ...}, ...} (sandbox)
  //   • {data: <one of the above>}                             (both envs)
  const inner = data?.data ?? data;
  let rows: any[];
  if (Array.isArray(inner)) {
    rows = inner;
  } else if (inner && typeof inner === "object") {
    // sandbox: keys are ISO-2 country codes, values are country objects
    rows = Object.values(inner);
  } else {
    rows = [];
  }

  const normalized: CountryEntry[] = rows.map((row: any) => {
    const code = String(row.code || row.country_code || row.iso2 || "").toUpperCase();

    // Operators may live directly on row.operators OR nested inside row.currencies.<CUR>.operators
    let ops: any[] = [];
    if (Array.isArray(row.operators)) {
      ops = row.operators;
    } else if (row.currencies && typeof row.currencies === "object") {
      // Pick first currency's operators (sandbox structure)
      const firstCur = Object.values(row.currencies)[0] as any;
      ops = Array.isArray(firstCur?.operators) ? firstCur.operators : [];
    } else if (Array.isArray(row.providers)) {
      ops = row.providers;
    }

    // Derive currency
    let currency: string | undefined;
    if (row.currency) {
      currency = String(row.currency);
    } else if (row.currencies && typeof row.currencies === "object") {
      currency = Object.keys(row.currencies)[0];
    }

    return {
      code,
      name: String(row.name || row.country_name || code),
      prefix: String(row.prefix || row.dial_code || row.phone_prefix || "").replace(/^0+/, "") || undefined,
      currency,
      operators: ops.map((op: any) => ({
        code: String(op.code || op.operator_code || op.id || op.name || ""),
        name: String(op.name || op.operator_name || op.display_name || op.code || ""),
        otp_required: Boolean(
          op.otp_required === true || op.otp_required === 1 || op.otp_required === "1",
        ),
        currency,
      })).filter((op) => op.code),
    };
  }).filter((c) => c.code && c.operators.length > 0);

  return normalized;
}

export async function listAllowedCountries(): Promise<CountryEntry[]> {
  const all = await listCountries();
  return all.filter((c) => !isCountryExcluded(c.code));
}

export async function getBalance(): Promise<unknown> {
  return authedFetch("/v1/balance", { method: "GET" });
}

export interface PayinParams {
  operator: string;
  country: string;
  phone_number: string;
  amount: number;
  currency: string;
  order_id: string;
  notify_url: string;
  otp_code?: string;
}
export interface PayinResponse {
  transaction_id?: string;
  order_id?: string;
  status?: string;
  message?: string;
  raw?: unknown;
}

export async function payin(params: PayinParams): Promise<PayinResponse> {
  ensureConfigured();
  if (isCountryExcluded(params.country)) {
    throw new AfribapayApiError(400, null, "Pays non supporté");
  }
  const body: Record<string, unknown> = {
    operator: params.operator,
    country: String(params.country).toUpperCase(),
    phone_number: params.phone_number,
    amount: params.amount,
    currency: params.currency,
    order_id: params.order_id,
    merchant_key: MERCHANT_KEY,
    notify_url: params.notify_url,
  };
  if (params.otp_code) body["otp_code"] = params.otp_code;
  const data = await authedFetch("/v1/pay/payin", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const inner = data?.data ?? data;
  return {
    transaction_id: inner?.transaction_id || inner?.transactionId || undefined,
    order_id: inner?.order_id || params.order_id,
    status: inner?.status || data?.status || undefined,
    message: inner?.message || data?.message || undefined,
    raw: data,
  };
}

export async function requestOtp(params: { operator: string; country: string; phone_number: string }): Promise<unknown> {
  ensureConfigured();
  if (isCountryExcluded(params.country)) {
    throw new AfribapayApiError(400, null, "Pays non supporté");
  }
  return authedFetch("/v1/pay/otp", {
    method: "POST",
    body: JSON.stringify({
      operator: params.operator,
      country: String(params.country).toUpperCase(),
      phone_number: params.phone_number,
      merchant_key: MERCHANT_KEY,
    }),
  });
}

export interface StatusResponse {
  status: string;     // raw provider status
  transaction_id?: string;
  order_id?: string;
  amount?: number;
  raw?: unknown;
}

export async function getStatus(orderId: string): Promise<StatusResponse> {
  let data: any;
  try {
    data = await authedFetch(`/v1/status?order_id=${encodeURIComponent(orderId)}`, { method: "GET" });
  } catch (err) {
    // AfribaPay sandbox returns HTTP 429 for finalized transactions but
    // still embeds the real status inside payload.data — extract it.
    if (err instanceof AfribapayApiError && err.status === 429) {
      const p = err.payload as Record<string, any> | null;
      const inner = p?.data ?? p;
      if (inner && typeof inner === "object") {
        const s = String((inner as any).status || "").toUpperCase();
        if (s) {
          return {
            status: s,
            transaction_id: (inner as any).transaction_id || (inner as any).transactionId || undefined,
            order_id: (inner as any).order_id || orderId,
            amount: (inner as any).amount != null ? Number((inner as any).amount) : undefined,
            raw: p,
          };
        }
      }
    }
    throw err;
  }
  const inner = data?.data ?? data;
  return {
    status: String(inner?.status || data?.status || "").toUpperCase(),
    transaction_id: inner?.transaction_id || inner?.transactionId || undefined,
    order_id: inner?.order_id || orderId,
    amount: inner?.amount != null ? Number(inner.amount) : undefined,
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification (HMAC-SHA256 of raw body, secret = API_KEY)
// ---------------------------------------------------------------------------
export function verifyWebhookSignature(rawBody: string | Buffer, headerSign: string | undefined | null): boolean {
  if (!API_KEY) return false;
  if (!headerSign) return false;
  const data = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const computed = crypto.createHmac("sha256", API_KEY).update(data, "utf8").digest("hex");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(String(headerSign).trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------
export function isSuccessStatus(s: string | undefined | null): boolean {
  if (!s) return false;
  const x = String(s).toUpperCase();
  return ["SUCCESS", "SUCCESSFUL", "COMPLETED", "PAID", "OK", "APPROVED"].includes(x);
}
export function isFailureStatus(s: string | undefined | null): boolean {
  if (!s) return false;
  const x = String(s).toUpperCase();
  return ["FAILED", "REJECTED", "CANCELLED", "CANCELED", "ERROR", "EXPIRED", "DECLINED"].includes(x);
}
