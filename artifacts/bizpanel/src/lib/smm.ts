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
  error?: string;
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
export const PROVIDER_ADMIN_NAMES: Record<1 | 2 | 3 | 4, string> = {
  1: "SMMpanel",
  2: "GROWFOLLOWERS",
  3: "JustAnotherPannel",
  4: "Peakerr",
};

export function providerAdminName(id: number): string {
  if (id === 1 || id === 2 || id === 3 || id === 4) return PROVIDER_ADMIN_NAMES[id];
  return `Fournisseur #${id}`;
}

// ---------------------------------------------------------------------------
// Public: list available providers (configured + admin-enabled), in display order
// ---------------------------------------------------------------------------
export interface SmmProviderPublic {
  provider_id: 1 | 2 | 3 | 4;
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

// In-memory client cache for the services catalogue. Mirrors the 5-min
// upstream cache on the API server so navigating back-and-forth between
// the picker and a provider catalogue is instantaneous after the first hit.
const SERVICES_TTL_MS = 5 * 60_000;
const servicesCache = new Map<number, { ts: number; data: SmmService[] }>();
const inflight = new Map<number, Promise<SmmService[]>>();

async function loadServicesUncached(providerId: number): Promise<SmmService[]> {
  const qs = withProvider(providerId, new URLSearchParams());
  const res = await fetch(`${API_BASE}/services?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return (data.services || []) as SmmService[];
}

export async function fetchSmmServices(providerId: number = 1): Promise<SmmService[]> {
  const hit = servicesCache.get(providerId);
  if (hit && Date.now() - hit.ts < SERVICES_TTL_MS) return hit.data;
  const ongoing = inflight.get(providerId);
  if (ongoing) return ongoing;
  const p = loadServicesUncached(providerId)
    .then((data) => {
      servicesCache.set(providerId, { ts: Date.now(), data });
      return data;
    })
    .finally(() => inflight.delete(providerId));
  inflight.set(providerId, p);
  return p;
}

// Fire-and-forget prefetch: warms the cache without surfacing errors.
// Intended to be called from the provider picker so that by the time the
// user clicks a provider, its services are already in memory.
export function prefetchSmmServices(providerId: number): void {
  const hit = servicesCache.get(providerId);
  if (hit && Date.now() - hit.ts < SERVICES_TTL_MS) return;
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
  payload: { price_fcfa?: number; hidden?: boolean },
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
  provider_id: 1 | 2 | 3 | 4;
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
  providerId: 1 | 2 | 3 | 4,
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
