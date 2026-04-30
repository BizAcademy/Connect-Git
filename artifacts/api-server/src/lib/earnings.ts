import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export interface EarningRecord {
  ts: string; // ISO timestamp
  provider_order_id: string;
  user_id: string;
  service: number;
  service_name: string;
  quantity: number;
  rate_usd: number;
  user_price_fcfa: number;
  provider_cost_usd: number;
  provider_cost_fcfa: number;
  gain_fcfa: number;
  /** SMM provider id (1, 2, 3). Defaults to 1 for legacy rows. */
  provider?: number;
}

// FCFA per USD when paying the SMM provider
const COST_FCFA_PER_USD = 600;
// FCFA per USD when billing end users (kept in sync with smm-pricing.ts)
const USER_FCFA_PER_USD = 700;
// Per-FCFA admin margin embedded in the user price.
// 100 / 700 ≈ 14.2857 % — applied to revenue when the historical provider
// rate is unknown (legacy orders backfilled from the `orders` table that
// does not preserve the per-service USD rate at order time).
const REVENUE_MARGIN_RATIO = (USER_FCFA_PER_USD - COST_FCFA_PER_USD) / USER_FCFA_PER_USD;

const FILE = path.resolve(process.cwd(), "data", "earnings.jsonl");

// ---------------------------------------------------------------------------
// Storage strategy
// ---------------------------------------------------------------------------
// Source of truth:  Supabase REST (`/rest/v1/earnings`) using the SERVICE
//                   ROLE key. Shared between preview and the published
//                   environment.
// Fallback only:    Append-only file (`data/earnings.jsonl`). Used solely
//                   when Supabase is unreachable for a single call (or the
//                   service role key is not configured at all). Reads merge
//                   the file in to avoid silent loss of those records, but
//                   the file is NOT a steady-state storage backend.
//
// Note: the previous implementation used Drizzle on the per-container
// PostgreSQL database (`helium`). That path has been removed entirely
// because each deployment had its own empty copy of the table — the very
// bug Task #10 was opened to fix. Existing rows that may have been written
// to the local database before this migration can be re-imported through
// the admin "Synchroniser" button (`POST /api/admin/earnings/backfill`),
// which scans orders and inserts any missing earnings rows.
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

function supabaseEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = SUPABASE_SERVICE_ROLE_KEY!;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

let warnedAboutMissingKey = false;
function warnOnceNoServiceRole() {
  if (warnedAboutMissingKey) return;
  warnedAboutMissingKey = true;
  logger.warn(
    "SUPABASE_SERVICE_ROLE_KEY not set — earnings ledger is writing to the local file fallback only (data/earnings.jsonl), which is NOT shared between preview and the published environment. Set SUPABASE_SERVICE_ROLE_KEY and apply migrations/003_earnings.sql so the admin earnings dashboard reflects real data in production.",
  );
}

export function computeEarning(input: {
  user_price_fcfa: number;
  rate_usd: number;
  quantity: number;
}): { provider_cost_usd: number; provider_cost_fcfa: number; gain_fcfa: number } {
  const provider_cost_usd = (input.quantity / 1000) * Number(input.rate_usd);
  const provider_cost_fcfa = Math.round(provider_cost_usd * COST_FCFA_PER_USD);
  const gain_fcfa = Math.round(input.user_price_fcfa - provider_cost_fcfa);
  return { provider_cost_usd, provider_cost_fcfa, gain_fcfa };
}

// Estimate gain & provider cost from the user-facing price alone, used for
// LEGACY orders where the provider USD rate at order time is unknown. This
// is mathematically equivalent to `computeEarning` whenever the user paid
// the default markup (USD × 700), and is a reasonable approximation for
// custom-priced services too.
//
//   gain_fcfa          = round(user_price_fcfa × (700 − 600) / 700)
//   provider_cost_fcfa = user_price_fcfa − gain_fcfa
export function estimateGainFromRevenue(user_price_fcfa: number): {
  provider_cost_fcfa: number;
  gain_fcfa: number;
} {
  const safe = Math.max(0, Math.round(Number(user_price_fcfa) || 0));
  const gain_fcfa = Math.round(safe * REVENUE_MARGIN_RATIO);
  const provider_cost_fcfa = safe - gain_fcfa;
  return { provider_cost_fcfa, gain_fcfa };
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

async function appendToSupabase(rec: EarningRecord): Promise<boolean> {
  try {
    // `Prefer: resolution=ignore-duplicates` makes the unique index on
    // provider_order_id idempotent: concurrent webhook + backfill calls
    // for the same order will not produce a 409.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/earnings`, {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "resolution=ignore-duplicates,return=minimal" }),
      body: JSON.stringify({
        ts: rec.ts,
        provider_order_id: String(rec.provider_order_id),
        user_id: rec.user_id || "",
        service: rec.service,
        service_name: rec.service_name || "",
        quantity: rec.quantity,
        rate_usd: rec.rate_usd,
        user_price_fcfa: rec.user_price_fcfa,
        provider_cost_usd: rec.provider_cost_usd,
        provider_cost_fcfa: rec.provider_cost_fcfa,
        gain_fcfa: rec.gain_fcfa,
        provider: rec.provider ?? 1,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.error(
        { status: r.status, body: body.slice(0, 200), provider_order_id: rec.provider_order_id },
        "earnings supabase insert failed",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, provider_order_id: rec.provider_order_id }, "earnings supabase insert threw");
    return false;
  }
}

async function appendToFile(rec: EarningRecord): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.appendFile(FILE, JSON.stringify(rec) + "\n", "utf8");
    return true;
  } catch (err) {
    logger.error({ err, provider_order_id: rec.provider_order_id }, "earnings file fallback also failed");
    return false;
  }
}

export async function appendEarning(rec: EarningRecord): Promise<void> {
  if (supabaseEnabled()) {
    if (await appendToSupabase(rec)) return;
    // Supabase failed for this single call — write to the file so the
    // record is not lost. An operator/cron can later re-import file rows
    // via the admin backfill endpoint.
    logger.warn(
      { provider_order_id: rec.provider_order_id },
      "earnings supabase write failed, falling back to local file (data/earnings.jsonl)",
    );
    await appendToFile(rec);
    return;
  }
  warnOnceNoServiceRole();
  await appendToFile(rec);
}

// ---------------------------------------------------------------------------
// Lookup ownership of a single provider order
// ---------------------------------------------------------------------------
//
// Used when serving order status to ensure the requester owns the order.
// Returns the user_id stored in the ledger, or null if not found.

async function findOwnerInSupabase(providerOrderId: string, provider?: number): Promise<string | null> {
  try {
    const providerFilter = typeof provider === "number" ? `&provider=eq.${provider}` : "";
    const url = `${SUPABASE_URL}/rest/v1/earnings?provider_order_id=eq.${encodeURIComponent(providerOrderId)}${providerFilter}&select=user_id&limit=1`;
    const r = await fetch(url, { headers: supabaseHeaders() });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.error({ status: r.status, body: body.slice(0, 200) }, "earnings supabase ownership lookup failed");
      return null;
    }
    const rows = (await r.json()) as Array<{ user_id: string }>;
    return rows[0]?.user_id ?? null;
  } catch (err) {
    logger.error({ err }, "earnings supabase ownership lookup threw");
    return null;
  }
}

async function findOwnerInFile(providerOrderId: string, provider?: number): Promise<string | null> {
  try {
    const txt = await fs.readFile(FILE, "utf8");
    const lines = txt.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as EarningRecord;
        if (rec.provider_order_id !== providerOrderId) continue;
        if (typeof provider === "number" && (rec.provider ?? 1) !== provider) continue;
        return rec.user_id;
      } catch { /* skip malformed line */ }
    }
  } catch { /* file doesn't exist yet */ }
  return null;
}

export async function findEarningOwner(providerOrderId: string, provider?: number): Promise<string | null> {
  if (supabaseEnabled()) {
    const owner = await findOwnerInSupabase(providerOrderId, provider);
    if (owner) return owner;
  }
  return await findOwnerInFile(providerOrderId, provider);
}

// Lookup the full earning record (user + amount paid) — used by the refund
// flow to source both the wallet owner and the refundable amount from a
// SERVER-WRITTEN ledger, never from client-writable tables like `orders`.
async function findEarningInSupabase(providerOrderId: string, provider?: number): Promise<EarningRecord | null> {
  try {
    const providerFilter = typeof provider === "number" ? `&provider=eq.${provider}` : "";
    const url = `${SUPABASE_URL}/rest/v1/earnings?provider_order_id=eq.${encodeURIComponent(providerOrderId)}${providerFilter}&select=*&limit=1`;
    const r = await fetch(url, { headers: supabaseHeaders() });
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    return rows[0] ? rowToRecord(rows[0]) : null;
  } catch {
    return null;
  }
}

async function findEarningInFile(providerOrderId: string, provider?: number): Promise<EarningRecord | null> {
  try {
    const txt = await fs.readFile(FILE, "utf8");
    for (const line of txt.split("\n").filter((l) => l.trim())) {
      try {
        const rec = JSON.parse(line) as EarningRecord;
        if (rec.provider_order_id !== providerOrderId) continue;
        if (typeof provider === "number" && (rec.provider ?? 1) !== provider) continue;
        return rec;
      } catch { /* skip */ }
    }
  } catch { /* no file */ }
  return null;
}

export async function findEarning(providerOrderId: string, provider?: number): Promise<EarningRecord | null> {
  if (supabaseEnabled()) {
    const r = await findEarningInSupabase(providerOrderId, provider);
    if (r) return r;
  }
  return await findEarningInFile(providerOrderId, provider);
}

// ---------------------------------------------------------------------------
// Read full ledger (admin)
// ---------------------------------------------------------------------------

async function readSupabase(): Promise<EarningRecord[]> {
  const out: EarningRecord[] = [];
  // Page through every row. The cap below is a safety guard against an
  // accidental infinite loop (e.g. a misbehaving PostgREST keeping returning
  // exactly PAGE_SIZE rows): with PAGE_SIZE=1000 and MAX_PAGES=10_000 the
  // ceiling is 10 million rows, far above any realistic SMM ledger size.
  // If we ever do hit it we log at error level so it is impossible to miss.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 10_000;
  let page = 0;
  for (; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    let r: Response;
    try {
      r = await fetch(
        `${SUPABASE_URL}/rest/v1/earnings?select=*&order=ts.desc`,
        {
          headers: {
            ...supabaseHeaders(),
            Range: `${from}-${to}`,
            "Range-Unit": "items",
          },
        },
      );
    } catch (err) {
      logger.error({ err }, "earnings supabase read threw");
      return out;
    }
    if (!r.ok && r.status !== 206) {
      const body = await r.text().catch(() => "");
      logger.error({ status: r.status, body: body.slice(0, 200) }, "earnings supabase read failed");
      return out;
    }
    const batch = (await r.json()) as Array<Record<string, unknown>>;
    for (const r2 of batch) {
      out.push(rowToRecord(r2));
    }
    if (batch.length < PAGE_SIZE) return out;
  }
  logger.error(
    { rows_loaded: out.length, max_pages: MAX_PAGES, page_size: PAGE_SIZE },
    "earnings supabase read TRUNCATED at MAX_PAGES — admin journal incomplete; raise MAX_PAGES",
  );
  return out;
}

function rowToRecord(r: Record<string, unknown>): EarningRecord {
  const ts = r["ts"];
  return {
    ts: ts instanceof Date ? ts.toISOString() : String(ts ?? ""),
    provider_order_id: String(r["provider_order_id"] ?? ""),
    user_id: String(r["user_id"] ?? ""),
    service: Number(r["service"] ?? 0),
    service_name: String(r["service_name"] ?? ""),
    quantity: Number(r["quantity"] ?? 0),
    rate_usd: Number(r["rate_usd"] ?? 0),
    user_price_fcfa: Number(r["user_price_fcfa"] ?? 0),
    provider_cost_usd: Number(r["provider_cost_usd"] ?? 0),
    provider_cost_fcfa: Number(r["provider_cost_fcfa"] ?? 0),
    gain_fcfa: Number(r["gain_fcfa"] ?? 0),
    provider: r["provider"] !== undefined && r["provider"] !== null ? Number(r["provider"]) : 1,
  };
}

async function readFile(): Promise<EarningRecord[]> {
  try {
    const txt = await fs.readFile(FILE, "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as EarningRecord; } catch { return null; }
      })
      .filter((r): r is EarningRecord => r !== null);
  } catch {
    return [];
  }
}

export async function readEarnings(): Promise<EarningRecord[]> {
  // Supabase is the source of truth. The file is only consulted to surface
  // records that were appended locally as a transient failure-mode fallback
  // and have not yet been re-imported. Records present in both locations
  // are deduplicated by provider_order_id.
  const result: EarningRecord[] = [];
  const seen = new Set<string>();
  // Composite dedup key — two providers can legitimately share the same
  // provider_order_id, so we must scope on (provider, provider_order_id).
  const keyOf = (r: EarningRecord) => `${r.provider ?? 1}::${r.provider_order_id}`;
  const push = (recs: EarningRecord[]) => {
    for (const r of recs) {
      if (!r.provider_order_id) continue;
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      result.push(r);
    }
  };

  if (supabaseEnabled()) {
    push(await readSupabase());
  } else {
    warnOnceNoServiceRole();
  }
  push(await readFile());

  // The route layer expects descending order by timestamp.
  result.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return result;
}
