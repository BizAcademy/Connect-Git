// SMM Panel API client (calls our backend proxy, not the provider directly)
import { getAuthHeaders, authedFetch } from "./authFetch";

const authHeaders = getAuthHeaders;
const fetch = authedFetch;

export interface SmmService {
  service: number;
  name: string;
  type: string;
  category: string;
  rate: string;
  min: string | number;
  max: string | number;
  refill?: boolean;
  cancel?: boolean;
  provider?: number;
  // Server-computed FCFA price per 1000 (uses admin override if set)
  price_fcfa: number;
  price_is_custom: boolean;
  hidden?: boolean;
  featured?: boolean;
}

// ---------------------------------------------------------------------------
// Per-provider USD → local currency display rates
// ---------------------------------------------------------------------------
// Mirrors server-side smm-pricing.ts. Used for client-side price display so
// users see the correct local currency amount before placing an order.
export const USD_TO_LOCAL_RATES: Record<"peakerr" | "default", Record<string, number>> = {
  peakerr: { XAF: 1000, XOF: 1050, GMD: 80,  CDF: 2700, GNF: 9000 },
  default:  { XAF: 700,  XOF: 750,  GMD: 73,  CDF: 2400, GNF: 7300 },
};

/**
 * Price per 1 000 units in LOCAL currency for display purposes.
 * - Custom (admin-set) prices are stored as FCFA; divide by fcfaPerUnit to get local.
 * - Default prices are computed directly from the provider USD rate × local rate.
 */
export function getLocalPricePerK(
  service: SmmService,
  currency: string,
  fcfaPerUnit: number,
): number {
  const cur = currency.toUpperCase();
  if (service.price_is_custom) {
    if (fcfaPerUnit === 1) return service.price_fcfa;
    return Math.round(service.price_fcfa / fcfaPerUnit);
  }
  const rates = service.provider === 4 ? USD_TO_LOCAL_RATES.peakerr : USD_TO_LOCAL_RATES.default;
  const rate = rates[cur] ?? rates["XOF"]!;
  return Math.round((Number(service.rate) * rate) / 10) * 10;
}

export interface SmmQuote {
  service: number;
  provider?: number;
  quantity: number;
  price_per_1000_fcfa: number;
  total_fcfa: number;
  price_is_custom: boolean;
  error?: string;
}

export interface SmmOrderResult {
  order?: number;
  provider?: number;
  /** Local Supabase UUID of the inserted order row (set server-side). */
  local_order_id?: string | null;
  error?: string;
  provider_unavailable?: boolean;
}

export interface SmmBalance {
  balance?: string;
  currency?: string;
  error?: string;
}

const API_BASE = "/api/smm";

function withProvider(providerId: number | undefined, qs: URLSearchParams): URLSearchParams {
  if (typeof providerId === "number") qs.set("provider", String(providerId));
  return qs;
}

// ---------------------------------------------------------------------------
// Canonical admin-side display names. Used everywhere in the admin UI
// (balance cards, providers config, services tab) so the admin never sees
// the raw "Fournisseur #1/2/3" labels — only the real panel names.
// User-facing labels remain configurable via header_title in
// smm_providers_config and are NOT overridden by these constants.
// ---------------------------------------------------------------------------
export const PROVIDER_ADMIN_NAMES: Record<1 | 3 | 4 | 5, string> = {
  1: "SMMpanel",
  3: "JustAnotherPannel",
  4: "Peakerr",
  5: "ExoSupplier",
};

export function providerAdminName(id: number): string {
  if (id === 1 || id === 3 || id === 4 || id === 5) return PROVIDER_ADMIN_NAMES[id];
  return `Fournisseur #${id}`;
}

// ---------------------------------------------------------------------------
// Public: list available providers (configured + admin-enabled), in display order
// ---------------------------------------------------------------------------
export interface SmmProviderPublic {
  provider_id: 1 | 3 | 4 | 5;
  display_order: number;
  header_title: string;
  header_text: string;
}

export async function fetchSmmProviders(): Promise<SmmProviderPublic[]> {
  const res = await fetch(`${API_BASE}/providers`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.providers || []) as SmmProviderPublic[];
}

// Client-side services cache — three-layer strategy:
//   1. In-memory Map (fastest, lost on page reload)
//   2. sessionStorage (survives navigation & soft-reload within the tab)
//   3. HTTP fetch with If-None-Match (lets the server return 304 + gzip for new data)
// TTL is 25 min — slightly under the server's 30 min window so the client
// re-validates before the server evicts its own copy.
const SERVICES_TTL_MS = 25 * 60_000;
const SS_KEY = (pid: number) => `smm_svc_v2_${pid}`;

interface SvcEntry { ts: number; etag: string; data: SmmService[] }
const memCache = new Map<number, SvcEntry>();
const inflight = new Map<number, Promise<SmmService[]>>();

function ssRead(providerId: number): SvcEntry | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY(providerId));
    if (!raw) return null;
    return JSON.parse(raw) as SvcEntry;
  } catch { return null; }
}

function ssWrite(providerId: number, entry: SvcEntry): void {
  try { sessionStorage.setItem(SS_KEY(providerId), JSON.stringify(entry)); } catch { /* quota */ }
}

async function loadServices(providerId: number): Promise<SmmService[]> {
  const qs = withProvider(providerId, new URLSearchParams());
  const url = `${API_BASE}/services?${qs.toString()}`;
  const existing = memCache.get(providerId) ?? ssRead(providerId);
  const headers: HeadersInit = {};
  if (existing?.etag) headers["If-None-Match"] = existing.etag;
  const res = await fetch(url, { headers });
  if (res.status === 304 && existing) {
    // Server says nothing changed — refresh timestamps and re-use cached data
    const refreshed: SvcEntry = { ...existing, ts: Date.now() };
    memCache.set(providerId, refreshed);
    ssWrite(providerId, refreshed);
    return existing.data;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error);
  const data = (payload.services || []) as SmmService[];
  const etag = res.headers.get("ETag") ?? "";
  const entry: SvcEntry = { ts: Date.now(), etag, data };
  memCache.set(providerId, entry);
  ssWrite(providerId, entry);
  return data;
}

export async function fetchSmmServices(providerId: number = 1): Promise<SmmService[]> {
  // 1. In-memory hit
  const mem = memCache.get(providerId);
  if (mem && Date.now() - mem.ts < SERVICES_TTL_MS) return mem.data;
  // 2. sessionStorage hit
  const ss = ssRead(providerId);
  if (ss && Date.now() - ss.ts < SERVICES_TTL_MS) {
    memCache.set(providerId, ss);
    return ss.data;
  }
  // 3. Deduplicated network fetch
  const ongoing = inflight.get(providerId);
  if (ongoing) return ongoing;
  const p = loadServices(providerId).finally(() => inflight.delete(providerId));
  inflight.set(providerId, p);
  return p;
}

// Fire-and-forget prefetch: warms the cache without surfacing errors.
// Called on provider picker mount and hover so the catalogue is ready
// before the user even clicks.
export function prefetchSmmServices(providerId: number): void {
  const mem = memCache.get(providerId);
  if (mem && Date.now() - mem.ts < SERVICES_TTL_MS) return;
  const ss = ssRead(providerId);
  if (ss && Date.now() - ss.ts < SERVICES_TTL_MS) { memCache.set(providerId, ss); return; }
  if (inflight.has(providerId)) return;
  fetchSmmServices(providerId).catch(() => { /* silent */ });
}

export async function fetchSmmBalance(providerId: number = 1): Promise<SmmBalance> {
  const headers = await authHeaders();
  const qs = withProvider(providerId, new URLSearchParams());
  const res = await fetch(`${API_BASE}/balance?${qs.toString()}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function placeSmmOrder(input: {
  service: number | string;
  link: string;
  quantity: number | string;
  provider?: number;
}): Promise<SmmOrderResult> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const body = { ...input, provider: input.provider ?? 1 };
  const res = await fetch(`${API_BASE}/order`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function fetchSmmQuote(
  service: number | string,
  quantity: number | string,
  providerId: number = 1,
): Promise<SmmQuote> {
  const headers = await authHeaders();
  const qs = withProvider(providerId, new URLSearchParams({
    service: String(service),
    quantity: String(quantity),
  }));
  const res = await fetch(`${API_BASE}/quote?${qs.toString()}`, { headers });
  return res.json();
}

// Admin: aggregated earnings + daily series
export interface AdminEarnings {
  summary: {
    today: { gain: number; revenue: number; orders: number };
    month: { gain: number; revenue: number; orders: number };
    year: { gain: number; revenue: number; orders: number };
    total: { gain: number; revenue: number; orders: number };
  };
  projections: {
    daily_avg_30d: number;
    quarterly: number;
    semi_annual: number;
    annual: number;
    month_run_rate: number;
    year_run_rate: number;
  };
  window?: {
    from: string;
    to: string;
    days: number;
    total: { gain: number; revenue: number; orders: number };
  };
  series: { date: string; gain: number; revenue: number; count: number }[];
}

export interface AdminEarningsQuery {
  days?: number;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  all?: boolean;
}

export async function fetchAdminEarnings(query: AdminEarningsQuery = {}): Promise<AdminEarnings> {
  const headers = await authHeaders();
  const qs = new URLSearchParams();
  if (query.all) qs.set("all", "1");
  else if (query.from) {
    qs.set("from", query.from);
    if (query.to) qs.set("to", query.to);
  } else if (query.days) {
    qs.set("days", String(query.days));
  }
  const url = `/api/admin/earnings${qs.toString() ? `?${qs.toString()}` : ""}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Admin: backfill earnings ledger from existing Supabase orders
export interface BackfillResult {
  ok: boolean;
  total_orders_scanned: number;
  inserted: number;
  recomputed?: number;
  skipped_already_present: number;
  skipped_no_external_id?: number;
  note?: string;
}
export async function backfillAdminEarnings(): Promise<BackfillResult> {
  const headers = await authHeaders();
  const res = await fetch(`/api/admin/earnings/backfill`, { method: "POST", headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Admin: get SMM Panel provider balance (per-provider)
export interface SmmProviderBalance {
  balance_usd: number | null;
  balance_fcfa_equiv: number | null;
  currency: string;
  provider?: number;
}
export async function fetchAdminSmmBalance(providerId: number = 1): Promise<SmmProviderBalance> {
  const headers = await authHeaders();
  const qs = withProvider(providerId, new URLSearchParams());
  const res = await fetch(`/api/admin/smm-balance?${qs.toString()}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Admin: list ALL services (including hidden) with current pricing overrides
export async function fetchAdminSmmPricing(providerId: number = 1): Promise<SmmService[]> {
  const headers = await authHeaders();
  const qs = withProvider(providerId, new URLSearchParams());
  const res = await fetch(`/api/admin/smm-pricing?${qs.toString()}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.services || []) as SmmService[];
}

// Admin: set price/hidden for a service (price in FCFA per 1000)
export async function updateAdminSmmPricing(
  serviceId: number,
  payload: { price_fcfa?: number; hidden?: boolean; featured?: boolean },
  providerId: number = 1,
): Promise<void> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const qs = withProvider(providerId, new URLSearchParams());
  const res = await fetch(`/api/admin/smm-pricing/${serviceId}?${qs.toString()}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

// Admin: rescale ALL custom prices for a provider by a multiplicative factor.
// Used e.g. when the USD→FCFA conversion rate changes for one provider
// (Peakerr passing from ×700 to ×1000 → factor = 1000/700).
export async function rescaleAdminSmmPricing(
  providerId: number,
  factor: number,
): Promise<{ updated: number }> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const qs = withProvider(providerId, new URLSearchParams());
  const res = await fetch(`/api/admin/smm-pricing/rescale?${qs.toString()}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ factor }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return await res.json();
}

// Admin: revert pricing to default for a service
export async function resetAdminSmmPricing(serviceId: number, providerId: number = 1): Promise<void> {
  const headers = await authHeaders();
  const qs = withProvider(providerId, new URLSearchParams());
  const res = await fetch(`/api/admin/smm-pricing/${serviceId}?${qs.toString()}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

export async function fetchSmmOrderStatus(orderId: number | string, providerId?: number) {
  const headers = await authHeaders();
  const qs = new URLSearchParams({ order: String(orderId) });
  if (typeof providerId === "number") qs.set("provider", String(providerId));
  const res = await fetch(`${API_BASE}/status?${qs.toString()}`, { headers });
  return res.json();
}

// Admin-only: force a sync + idempotent refund for an order at the provider.
export interface AdminRefundResult {
  status: string;
  previous_status?: string;
  refunded: boolean;
  refunded_amount?: number;
  user_id?: string;
  provider?: number;
  error?: string;
}
// Force a sync + idempotent refund using the LOCAL primary key — unambiguous
// across providers (the server resolves the row by id and reads its provider).
export async function adminForceOrderRefund(localOrderId: string): Promise<AdminRefundResult> {
  const headers = await authHeaders();
  const res = await fetch(
    `/api/admin/orders/by-id/${encodeURIComponent(localOrderId)}/refund`,
    { method: "POST", headers },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { status: "", refunded: false, error: data?.error || `HTTP ${res.status}` };
  }
  return data as AdminRefundResult;
}

// ---------------------------------------------------------------------------
// Admin: provider config (display order, enabled, header text per provider)
// ---------------------------------------------------------------------------
export interface AdminProviderConfig {
  provider_id: 1 | 3 | 4 | 5;
  display_order: number;
  enabled: boolean;
  header_title: string;
  header_text: string;
  configured: boolean;
}

export async function fetchAdminProviders(): Promise<AdminProviderConfig[]> {
  const headers = await authHeaders();
  const res = await fetch(`/api/admin/providers`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.providers || []) as AdminProviderConfig[];
}

export async function updateAdminProvider(
  providerId: 1 | 3 | 4 | 5,
  patch: Partial<Pick<AdminProviderConfig, "display_order" | "enabled" | "header_title" | "header_text">>,
): Promise<void> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const res = await fetch(`/api/admin/providers/${providerId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}
