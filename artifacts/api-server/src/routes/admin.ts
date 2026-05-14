import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { requireUser, requireAdmin, type AuthedRequest } from "../lib/auth";
import { loadPricing, setEntry, deleteEntry, enrichServices, usdToFcfaRate } from "../lib/smm-pricing";
import { invalidateServicesCache } from "./smm";
import {
  callProvider,
  parseProviderId,
  getProvider,
  loadProviderConfig,
  updateProviderConfig,
  ALL_PROVIDER_IDS,
  type ProviderId,
} from "../lib/smm-providers";
import { readEarnings, appendEarning, estimateGainFromRevenue } from "../lib/earnings";
import {
  creditDeposit,
  markPaymentStatus,
  BONUS_THRESHOLD_FCFA,
  BONUS_AMOUNT_FCFA,
} from "../lib/deposits";
import {
  listUnavailableOperators,
  clearOperatorHealth,
  COOLDOWN_MS,
} from "../lib/operator-health";
import { bustCountriesCache } from "../lib/afribapay";
import {
  NON_CFA_COUNTRIES_INFO,
  setRateOverrides,
} from "../lib/currency";

const router: IRouter = Router();

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] || process.env["VITE_SUPABASE_ANON_KEY"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

function serviceRoleHeaders(): Record<string, string> {
  const key = SUPABASE_SERVICE_ROLE_KEY!;
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

// GET /api/admin/earnings — aggregated platform earnings + daily series
//
// Query params (all optional):
//   - days=N  : window length in days (default 30, max 3650 = ~10 years)
//               When `from` is provided, `days` is ignored.
//   - from=YYYY-MM-DD  : explicit window start (inclusive)
//   - to=YYYY-MM-DD    : explicit window end (inclusive, default = today)
//   - all=1            : return EVERY day from the very first earning
//                        record up to today (capped at 3650 days)
//
// Always returns a continuous daily series — every day in the window is
// present even when no order was placed (gain/revenue/count = 0). This is
// what the admin "Journal quotidien" UI relies on.
router.get("/admin/earnings", requireUser, requireAdmin, async (req, res) => {
  try {
    const all = await readEarnings();
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const ONE_DAY = 86400_000;
    const MAX_DAYS = 3650;

    const parseDate = (v: unknown): Date | null => {
      if (typeof v !== "string") return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m) return null;
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return isNaN(d.getTime()) ? null : d;
    };

    const wantAll = req.query.all === "1" || req.query.all === "true";
    const fromQ = parseDate(req.query.from);
    const toQ = parseDate(req.query.to) ?? startOfDay;

    let windowStart: Date;
    let windowEnd: Date = new Date(Date.UTC(toQ.getUTCFullYear(), toQ.getUTCMonth(), toQ.getUTCDate()));

    if (wantAll) {
      if (all.length > 0) {
        const minTs = all.reduce((min, r) => {
          const t = new Date(r.ts).getTime();
          return t < min ? t : min;
        }, Date.now());
        const minDate = new Date(minTs);
        windowStart = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), minDate.getUTCDate()));
      } else {
        // No earnings yet — return a single-day window (today) instead of
        // silently widening to 30 days, so the journal contract is explicit.
        windowStart = windowEnd;
      }
    } else if (fromQ) {
      windowStart = fromQ;
    } else {
      const daysParam = Number(req.query.days);
      const days = Number.isFinite(daysParam) && daysParam > 0
        ? Math.min(Math.floor(daysParam), MAX_DAYS)
        : 30;
      windowStart = new Date(windowEnd.getTime() - (days - 1) * ONE_DAY);
    }

    // Safety: clamp window to MAX_DAYS
    const spanDays = Math.floor((windowEnd.getTime() - windowStart.getTime()) / ONE_DAY) + 1;
    if (spanDays > MAX_DAYS) {
      windowStart = new Date(windowEnd.getTime() - (MAX_DAYS - 1) * ONE_DAY);
    }
    if (windowStart > windowEnd) windowStart = windowEnd;

    // ---- Aggregate ---------------------------------------------------
    let today = 0, month = 0, year = 0, total = 0;
    let countToday = 0, countMonth = 0, countYear = 0, countTotal = 0;
    let revenue_today = 0, revenue_month = 0, revenue_year = 0, revenue_total = 0;

    const byDay = new Map<string, { gain: number; revenue: number; count: number }>();

    // Pre-fill EVERY day of the requested window so the series is continuous.
    const totalDays = Math.floor((windowEnd.getTime() - windowStart.getTime()) / ONE_DAY) + 1;
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(windowStart.getTime() + i * ONE_DAY);
      const k = d.toISOString().slice(0, 10);
      byDay.set(k, { gain: 0, revenue: 0, count: 0 });
    }

    // Also keep a 30-day rolling bucket for projections (independent of window).
    const rolling30Start = new Date(startOfDay.getTime() - 29 * ONE_DAY);
    let rolling30Gain = 0;

    const windowEndExclusive = windowEnd.getTime() + ONE_DAY;

    for (const r of all) {
      const t = new Date(r.ts);
      const ts = t.getTime();
      total += r.gain_fcfa; countTotal++; revenue_total += r.user_price_fcfa;
      if (t >= startOfYear) { year += r.gain_fcfa; countYear++; revenue_year += r.user_price_fcfa; }
      if (t >= startOfMonth) { month += r.gain_fcfa; countMonth++; revenue_month += r.user_price_fcfa; }
      if (t >= startOfDay) { today += r.gain_fcfa; countToday++; revenue_today += r.user_price_fcfa; }
      if (t >= rolling30Start) rolling30Gain += r.gain_fcfa;

      if (ts >= windowStart.getTime() && ts < windowEndExclusive) {
        const k = t.toISOString().slice(0, 10);
        const cur = byDay.get(k);
        if (cur) {
          cur.gain += r.gain_fcfa;
          cur.revenue += r.user_price_fcfa;
          cur.count++;
        }
      }
    }

    const dayOfMonth = now.getUTCDate();
    const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / ONE_DAY) + 1;
    const dailyAvg30 = rolling30Gain / 30;

    const series = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, gain: v.gain, revenue: v.revenue, count: v.count }));

    // Window totals (sum of the series we just built)
    const window_total = series.reduce(
      (acc, p) => {
        acc.gain += p.gain;
        acc.revenue += p.revenue;
        acc.orders += p.count;
        return acc;
      },
      { gain: 0, revenue: 0, orders: 0 },
    );

    res.json({
      summary: {
        today: { gain: today, revenue: revenue_today, orders: countToday },
        month: { gain: month, revenue: revenue_month, orders: countMonth },
        year:  { gain: year,  revenue: revenue_year,  orders: countYear },
        total: { gain: total, revenue: revenue_total, orders: countTotal },
      },
      projections: {
        daily_avg_30d: Math.round(dailyAvg30),
        quarterly: Math.round(dailyAvg30 * 90),
        semi_annual: Math.round(dailyAvg30 * 182),
        annual: Math.round(dailyAvg30 * 365),
        month_run_rate: dayOfMonth > 0 ? Math.round((month / dayOfMonth) * 30) : 0,
        year_run_rate: dayOfYear > 0 ? Math.round((year / dayOfYear) * 365) : 0,
      },
      window: {
        from: windowStart.toISOString().slice(0, 10),
        to: windowEnd.toISOString().slice(0, 10),
        days: totalDays,
        total: window_total,
      },
      series,
    });
  } catch (err) {
    logger.error({ err }, "admin earnings error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/admin/earnings/backfill — fill earnings ledger from existing
// Supabase `orders` rows that have no matching earnings record yet. This
// recovers historical revenue/order count for orders placed BEFORE the
// server-side billing rewrite that introduced the earnings ledger.
//
// The provider USD rate at order time is NOT stored in the `orders` table,
// so for legacy orders we estimate the gain from the user-paid price using
// the platform's default markup (USD × 700 user vs USD × 600 provider →
// 100/700 ≈ 14.29 % of revenue). This is exact for default-priced services
// and a close approximation for custom-priced ones.
//
// In addition to inserting missing rows, this endpoint also UPDATES any
// pre-existing earnings rows whose gain_fcfa is 0 (typically rows created
// by an earlier version of this same backfill that hard-coded gain to 0).
router.post("/admin/earnings/backfill", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: "Supabase non configuré" });
  }
  const SERVICE_ROLE = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  try {
    const existing = await readEarnings();
    // Composite key: two providers can legitimately return the same numeric
    // order id, so dedup must be scoped on (provider, provider_order_id).
    const seenKey = (provider: number | null | undefined, orderId: string) => {
      const p = provider === 3 || provider === 4 || provider === 5 ? provider : 1;
      return `${p}::${orderId}`;
    };
    const seen = new Set(existing.map((r) => seenKey(r.provider, r.provider_order_id)));

    // -----------------------------------------------------------------
    // 0) Recompute gain for already-present rows where gain_fcfa = 0.
    //    Requires the service role key (rows are RLS-protected). If the
    //    key is not configured, we skip silently — the warning is already
    //    logged by lib/earnings.ts on boot.
    // -----------------------------------------------------------------
    let recomputed = 0;
    if (SERVICE_ROLE) {
      const headersSrv: Record<string, string> = {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      };
      for (const r of existing) {
        if (r.gain_fcfa !== 0) continue;
        if (!r.user_price_fcfa || r.user_price_fcfa <= 0) continue;
        const { provider_cost_fcfa, gain_fcfa } = estimateGainFromRevenue(r.user_price_fcfa);
        if (gain_fcfa === 0) continue;
        try {
          const recProvider = r.provider === 3 || r.provider === 4 || r.provider === 5 ? r.provider : 1;
          const patch = await fetch(
            `${SUPABASE_URL}/rest/v1/earnings?provider_order_id=eq.${encodeURIComponent(r.provider_order_id)}&provider=eq.${recProvider}`,
            {
              method: "PATCH",
              headers: headersSrv,
              body: JSON.stringify({ provider_cost_fcfa, gain_fcfa }),
            },
          );
          if (patch.ok) recomputed++;
          else {
            const txt = await patch.text().catch(() => "");
            logger.warn(
              { status: patch.status, body: txt.slice(0, 200), provider_order_id: r.provider_order_id },
              "backfill: gain recompute PATCH failed",
            );
          }
        } catch (err) {
          logger.warn({ err, provider_order_id: r.provider_order_id }, "backfill: gain recompute threw");
        }
      }
    }

    // Page through ALL orders (admin RLS policy must allow viewing all orders).
    type OrderRow = {
      id: string;
      user_id: string;
      external_order_id: string | null;
      price: number;
      quantity: number;
      service_name: string | null;
      created_at: string;
      provider: number | null;
    };
    const allOrders: OrderRow[] = [];
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 100; // 100k cap is more than enough for any single backfill
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const ordersRes = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?select=id,user_id,external_order_id,price,quantity,service_name,created_at,provider&order=created_at.desc`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${req.userToken!}`,
            Range: `${from}-${to}`,
            "Range-Unit": "items",
          },
        },
      );
      if (!ordersRes.ok && ordersRes.status !== 206) {
        const txt = await ordersRes.text();
        logger.error({ status: ordersRes.status, body: txt.slice(0, 200) }, "backfill: orders fetch failed");
        return res.status(502).json({ error: "Impossible de lire les commandes Supabase" });
      }
      const batch = (await ordersRes.json()) as OrderRow[];
      allOrders.push(...batch);
      if (batch.length < PAGE_SIZE) break; // last page
    }

    let inserted = 0, skipped = 0, skipped_no_external_id = 0;
    for (const o of allOrders) {
      // Only backfill orders that have a real provider order id. Orders without
      // an external_order_id were never sent to the provider (debit may not
      // have happened either) — including them would inflate revenue from
      // potentially client-fabricated rows.
      if (!o.external_order_id) { skipped_no_external_id++; continue; }
      const key = seenKey(o.provider, String(o.external_order_id));
      if (seen.has(key)) { skipped++; continue; }
      const userPrice = Number(o.price) || 0;
      const { provider_cost_fcfa, gain_fcfa } = estimateGainFromRevenue(userPrice);
      try {
        // Pull provider from the row so historical earnings stay attributed
        // to the right SMM provider (1, 2, or 3). Legacy rows where the
        // column is NULL default to provider 1, which matches the schema
        // default applied by the SQL migration.
        const orderProvider = (o.provider === 3 || o.provider === 4 || o.provider === 5) ? o.provider : 1;
        await appendEarning({
          ts: o.created_at,
          provider_order_id: key,
          user_id: o.user_id || "",
          service: 0,
          service_name: o.service_name || "",
          quantity: Number(o.quantity) || 0,
          rate_usd: 0,
          user_price_fcfa: userPrice,
          provider_cost_usd: 0,
          provider_cost_fcfa,
          gain_fcfa,
          provider: orderProvider,
        });
        seen.add(key);
        inserted++;
      } catch (e) {
        logger.error({ err: e, orderId: o.id }, "backfill: insert failed for order");
      }
    }

    res.json({
      ok: true,
      total_orders_scanned: allOrders.length,
      inserted,
      recomputed,
      skipped_already_present: skipped,
      skipped_no_external_id,
      note: "Pour les commandes anciennes, le gain est estimé à partir du chiffre d'affaires en utilisant la marge par défaut de la plateforme (USD × 700 utilisateur vs USD × 600 fournisseur pour les fournisseurs 1/3/5, USD × 1000 vs USD × 600 pour Peakerr/4). Les nouvelles commandes calculent le gain exactement à partir du prix réellement payé et du coût réel fournisseur.",
    });
  } catch (err) {
    logger.error({ err }, "earnings backfill error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/admin/smm-balance?provider=N — provider account balance (USD) + FCFA equivalent
router.get("/admin/smm-balance", requireUser, requireAdmin, async (req, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  try {
    const data = await callProvider(providerId, "balance");
    const usd = Number(data?.balance);
    res.json({
      balance_usd: Number.isFinite(usd) ? usd : null,
      // Same USD→FCFA rate used everywhere user-facing for catalog pricing
      // (see lib/smm-pricing.ts). Per-provider: Peakerr (4) = 1000, others = 700.
      // Keeping a single rate per provider avoids confusing the admin: a $10
      // balance shown as "≈ 10 000 FCFA" (Peakerr) or "≈ 7 000 FCFA" (autres)
      // matches the per-1000 prices the user actually pays.
      balance_fcfa_equiv: Number.isFinite(usd) ? Math.round(usd * usdToFcfaRate(providerId)) : null,
      currency: data?.currency || "USD",
      provider: providerId,
      raw: data,
    });
  } catch (err) {
    logger.error({ err, providerId }, "admin smm balance error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/admin/smm-pricing?provider=N — list ALL services (no hidden filter), with admin pricing merged
router.get("/admin/smm-pricing", requireUser, requireAdmin, async (req, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  try {
    const raw = await callProvider(providerId, "services");
    const enriched = await enrichServices(raw, providerId);
    res.json({ services: enriched, provider: providerId });
  } catch (err) {
    logger.error({ err, providerId }, "admin pricing list error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/admin/smm-pricing/:serviceId?provider=N  body: { price_fcfa?: number, hidden?: boolean, featured?: boolean }
router.put("/admin/smm-pricing/:serviceId", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  const id = Number(req.params["serviceId"]);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "service invalide" });

  const { price_fcfa, hidden, featured } = req.body || {};
  const entry: { price_fcfa: number; hidden?: boolean; featured?: boolean } = { price_fcfa: 0 };

  if (price_fcfa !== undefined && price_fcfa !== null && price_fcfa !== "") {
    const p = Number(price_fcfa);
    if (!Number.isFinite(p) || p < 0 || p > 100_000_000) {
      return res.status(400).json({ error: "price_fcfa invalide" });
    }
    entry.price_fcfa = Math.round(p);
  } else {
    const map = await loadPricing(providerId);
    const existing = map[String(id)];
    if (!existing && hidden === undefined && featured === undefined) {
      return res.status(400).json({ error: "Rien à mettre à jour" });
    }
    entry.price_fcfa = existing?.price_fcfa ?? 0;
  }
  if (typeof hidden === "boolean") entry.hidden = hidden;
  if (typeof featured === "boolean") entry.featured = featured;

  await setEntry(id, entry, providerId);
  invalidateServicesCache(providerId);
  res.json({ ok: true, service: id, provider: providerId, ...entry });
});

// POST /api/admin/smm-pricing/rescale?provider=N  body: { factor: number }
// Multiplie tous les prix custom du fournisseur par le facteur (arrondi aux 10 FCFA).
// Utilisé par exemple pour Peakerr lors du passage de USD×700 à USD×1000
// (factor = 1000/700 ≈ 1.4286). Hidden/featured ne sont pas modifiés.
router.post("/admin/smm-pricing/rescale", requireUser, requireAdmin, async (req, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  const factor = Number((req.body as Record<string, unknown> | undefined)?.["factor"]);
  if (!Number.isFinite(factor) || factor <= 0 || factor > 100) {
    return res.status(400).json({ error: "factor invalide (attendu : nombre > 0 et ≤ 100)" });
  }
  const map = await loadPricing(providerId);
  let updated = 0;
  for (const [id, entry] of Object.entries(map)) {
    if (typeof entry?.price_fcfa === "number" && entry.price_fcfa > 0) {
      const next = Math.round((entry.price_fcfa * factor) / 10) * 10;
      if (next !== entry.price_fcfa) {
        await setEntry(id, { ...entry, price_fcfa: next }, providerId);
        updated++;
      }
    }
  }
  invalidateServicesCache(providerId);
  logger.info({ providerId, factor, updated }, "admin smm-pricing rescaled");
  res.json({ ok: true, provider: providerId, factor, updated });
});

// DELETE /api/admin/smm-pricing/:serviceId?provider=N  → revert to default pricing & visible
router.delete("/admin/smm-pricing/:serviceId", requireUser, requireAdmin, async (req, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  const id = Number(req.params["serviceId"]);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "service invalide" });
  await deleteEntry(id, providerId);
  invalidateServicesCache(providerId);
  res.json({ ok: true, provider: providerId });
});

// =====================================================================
// PROVIDER CONFIG (display order, enabled, header text per provider)
// =====================================================================

// GET /api/admin/providers — list all 3 provider config rows + runtime info
router.get("/admin/providers", requireUser, requireAdmin, async (_req, res) => {
  try {
    const cfg = await loadProviderConfig();
    const out = cfg.map((c) => ({
      ...c,
      configured: getProvider(c.provider_id)?.configured ?? false,
    }));
    res.json({ providers: out });
  } catch (err) {
    logger.error({ err }, "admin providers list error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/admin/providers/:id  body: { display_order?, enabled?, header_title?, header_text? }
// `display_order` is constrained to 1–5 and is globally unique across the
// five providers. When the admin moves provider P to slot N, the provider
// currently sitting in slot N is automatically swapped to P's previous slot
// (server-side) so the UI never has to coordinate two writes.
router.put("/admin/providers/:id", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params["id"]);
  if (id !== 1 && id !== 3 && id !== 4 && id !== 5) {
    return res.status(400).json({ error: "provider id invalide (1, 3, 4 ou 5)" });
  }
  const b = (req.body || {}) as Record<string, unknown>;
  type ProviderPatch = Partial<{
    display_order: number;
    enabled: boolean;
    header_title: string;
    header_text: string;
  }>;
  const patch: ProviderPatch = {};
  if (b["display_order"] !== undefined && b["display_order"] !== null && b["display_order"] !== "") {
    const n = Number(b["display_order"]);
    if (!Number.isFinite(n) || (n !== 1 && n !== 2 && n !== 3 && n !== 4)) {
      return res.status(400).json({ error: "display_order invalide (1, 2, 3 ou 4)" });
    }
    patch.display_order = n;
  }
  if (typeof b["enabled"] === "boolean") patch.enabled = b["enabled"];
  if (typeof b["header_title"] === "string") {
    const t = (b["header_title"] as string).trim();
    if (t.length === 0 || t.length > 120) return res.status(400).json({ error: "header_title invalide (1–120 caractères)" });
    patch.header_title = t;
  }
  if (typeof b["header_text"] === "string") {
    const t = b["header_text"] as string;
    if (t.length > 500) return res.status(400).json({ error: "header_text trop long (500 max)" });
    patch.header_text = t;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Rien à mettre à jour" });

  // If display_order changes, swap with whichever provider currently sits there.
  // Two non-transactional PATCHes are required (Supabase REST has no
  // multi-row transaction). To avoid leaving the table in a corrupted state
  // (two rows sharing the same display_order) if the second PATCH fails,
  // we explicitly roll back the first one.
  if (typeof patch.display_order === "number") {
    const all = await loadProviderConfig();
    const me = all.find((p) => p.provider_id === id);
    const other = all.find((p) => p.provider_id !== id && p.display_order === patch.display_order);
    if (other && me && me.display_order !== patch.display_order) {
      const previousOtherOrder = other.display_order;
      const previousMyOrder = me.display_order;
      const swap = await updateProviderConfig(other.provider_id, { display_order: previousMyOrder });
      if (!swap.ok) return res.status(500).json({ error: swap.error || "Échec du swap d'ordre" });
      const out = await updateProviderConfig(id as ProviderId, patch);
      if (!out.ok) {
        // Roll back the swap so we never persist a duplicate display_order.
        const rollback = await updateProviderConfig(other.provider_id, {
          display_order: previousOtherOrder,
        });
        return res.status(500).json({
          error: out.error || "Erreur serveur",
          rollback: rollback.ok ? "ok" : "manual_check_required",
        });
      }
      return res.json({ ok: true, provider: id });
    }
  }

  const out = await updateProviderConfig(id as ProviderId, patch);
  if (!out.ok) return res.status(500).json({ error: out.error || "Erreur serveur" });
  res.json({ ok: true, provider: id });
});

// Side-effect: keep ALL_PROVIDER_IDS referenced so it stays in the bundle.
void ALL_PROVIDER_IDS;

// =====================================================================
// DEPOSITS / BONUS ADMIN
// =====================================================================

interface DepositFilter {
  from?: string;          // ISO date (YYYY-MM-DD)
  to?: string;            // ISO date (YYYY-MM-DD)
  period?: string;        // 'today' | '7d' | '30d' | 'all'
  status?: string;        // 'completed' | 'pending' | 'rejected' | 'failed' | 'all'
  bonus_status?: string;  // 'credited' | 'pending' | 'not_eligible' | 'all'
  search?: string;        // matches reference, username or email (ilike)
  min_amount?: string;
  max_amount?: string;
  min_user_deposits?: string; // keep only deposits whose user has >= N completed deposits overall
  limit?: string;
}

interface PaymentApi {
  id: string; user_id: string; amount: number; status: string;
  method: string; reference: string | null; created_at: string;
  bonus_amount: number | null; bonus_status: string | null;
  bonus_credited_at: string | null; credited_at: string | null;
}

interface ProfileLite { user_id: string; username: string | null; email: string | null; }

function periodToFromIso(period: string | undefined): string | null {
  const now = new Date();
  switch ((period || "").toLowerCase()) {
    case "today": {
      const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString();
    }
    case "7d": {
      const d = new Date(now); d.setDate(d.getDate() - 7); return d.toISOString();
    }
    case "30d": {
      const d = new Date(now); d.setDate(d.getDate() - 30); return d.toISOString();
    }
    default: return null;
  }
}

// GET /api/admin/deposits — paginated, filterable list
// GET /api/admin/transactions
//
// Unified admin journal of deposits + orders + refunds, sourced server-side
// via the service-role key (does NOT depend on RLS), with pagination &
// filters. Returns rows newest-first, ready to render as a single feed:
//
//   { rows: TxRow[], total_count?: number, has_more: boolean }
//   TxRow = { id, kind: "deposit"|"order"|"refund", created_at, amount,
//             status, user_id, user_label, user_email, detail, reference,
//             external_order_id?, refunded_at?, refunded_amount? }
//
// Query params (all optional):
//   - type=order|deposit|refund|all  (default all)
//   - status=<string>                (default any)
//   - from=<ISO|YYYY-MM-DD>          (created_at >= from)
//   - to=<ISO|YYYY-MM-DD>            (created_at <= to)
//   - search=<string>                (matches reference, service, user)
//   - limit=N                        (default 200, max 1000)
//   - offset=N                       (default 0)
router.get("/admin/transactions", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Configuration serveur manquante (SUPABASE_SERVICE_ROLE_KEY)" });
  }
  const q = req.query as Record<string, string | undefined>;
  const type = (q.type || "all").toLowerCase();
  const statusF = (q.status || "").toLowerCase();
  const search = (q.search || "").replace(/[%,()]/g, "").trim();
  const limit = Math.min(Math.max(parseInt(q.limit || "200", 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(q.offset || "0", 10) || 0, 0);
  const fromIso = q.from ? new Date(q.from).toISOString() : null;
  const toIso = q.to
    ? (() => {
        const d = new Date(q.to!);
        d.setHours(23, 59, 59, 999);
        return d.toISOString();
      })()
    : null;

  const headers = serviceRoleHeaders();
  // Wider page on the underlying tables so we can merge & sort in-memory
  // before paginating the unified feed.
  const FETCH = Math.min(limit + offset + 200, 2000);

  const buildOrderUrl = () => {
    const p = new URLSearchParams();
    p.set("select", "id,user_id,created_at,price,status,service_name,service_category,link,external_order_id,quantity,refunded_at,refunded_amount,provider");
    p.set("order", "created_at.desc");
    p.set("limit", String(FETCH));
    if (fromIso) p.append("created_at", `gte.${fromIso}`);
    if (toIso) p.append("created_at", `lte.${toIso}`);
    if (statusF && type === "order") p.append("status", `eq.${statusF}`);
    return `${SUPABASE_URL}/rest/v1/orders?${p.toString()}`;
  };
  const buildPayUrl = () => {
    const p = new URLSearchParams();
    p.set("select", "id,user_id,created_at,amount,status,method,reference,operator,country,phone_number,transaction_id,order_id,currency");
    p.set("order", "created_at.desc");
    p.set("limit", String(FETCH));
    if (fromIso) p.append("created_at", `gte.${fromIso}`);
    if (toIso) p.append("created_at", `lte.${toIso}`);
    if (statusF && type === "deposit") p.append("status", `eq.${statusF}`);
    return `${SUPABASE_URL}/rest/v1/payments?${p.toString()}`;
  };

  try {
    const wantOrders = type === "all" || type === "order" || type === "refund";
    const wantPays = type === "all" || type === "deposit";
    const [ordRes, payRes] = await Promise.all([
      wantOrders ? fetch(buildOrderUrl(), { headers }) : Promise.resolve(null as any),
      wantPays ? fetch(buildPayUrl(), { headers }) : Promise.resolve(null as any),
    ]);
    const orders: any[] = ordRes && ordRes.ok ? await ordRes.json() : [];
    const pays: any[] = payRes && payRes.ok ? await payRes.json() : [];

    // Resolve user labels in one query
    const userIds = Array.from(new Set([
      ...orders.map((o) => o.user_id),
      ...pays.map((p) => p.user_id),
    ].filter(Boolean)));
    const profiles = new Map<string, { username?: string; email?: string }>();
    if (userIds.length > 0) {
      const pr = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?user_id=in.(${userIds.join(",")})&select=user_id,username,email&limit=${userIds.length}`,
        { headers },
      );
      if (pr.ok) {
        for (const row of (await pr.json()) as any[]) {
          profiles.set(row.user_id, { username: row.username, email: row.email });
        }
      }
    }
    const labelFor = (uid: string) => profiles.get(uid)?.username || profiles.get(uid)?.email || uid?.slice(0, 8) || "?";

    type TxRow = {
      id: string; kind: "deposit" | "order" | "refund"; created_at: string;
      amount: number; status: string; user_id: string;
      user_label: string; user_email?: string;
      detail: string; reference: string | null;
      external_order_id?: string | null;
      refunded_at?: string | null; refunded_amount?: number | null;
      provider?: number | null;
    };
    const all: TxRow[] = [];
    if (type === "all" || type === "order") {
      for (const o of orders) {
        all.push({
          id: `o-${o.id}`, kind: "order", created_at: o.created_at,
          amount: Number(o.price), status: o.status, user_id: o.user_id,
          user_label: labelFor(o.user_id), user_email: profiles.get(o.user_id)?.email,
          detail: `${o.service_category || ""} · ${o.service_name || ""}`.replace(/^· /, "").trim(),
          reference: o.external_order_id ? `#${o.external_order_id}` : null,
          external_order_id: o.external_order_id || null,
          refunded_at: o.refunded_at, refunded_amount: o.refunded_amount,
          provider: typeof o.provider === "number" ? o.provider : null,
        });
      }
    }
    if (type === "all" || type === "refund") {
      for (const o of orders) {
        if (o.refunded_at && Number(o.refunded_amount) > 0) {
          all.push({
            id: `r-${o.id}`, kind: "refund", created_at: o.refunded_at,
            amount: Number(o.refunded_amount), status: "completed", user_id: o.user_id,
            user_label: labelFor(o.user_id), user_email: profiles.get(o.user_id)?.email,
            detail: `Remboursement · ${o.service_name || ""}`,
            reference: o.external_order_id ? `#${o.external_order_id}` : null,
            external_order_id: o.external_order_id || null,
          });
        }
      }
    }
    if (type === "all" || type === "deposit") {
      for (const p of pays) {
        // Build a rich label: "Dépôt · AFRIBAPAY · ORANGE-CI · CI · 07XX…"
        const parts: string[] = [`Dépôt · ${(p.method || "").toUpperCase()}`];
        if (p.operator) parts.push(String(p.operator).toUpperCase());
        if (p.country)  parts.push(String(p.country).toUpperCase());
        if (p.phone_number) parts.push(String(p.phone_number));
        // Reference shown in the admin journal: AfribaPay txid wins, else order_id, else legacy reference.
        const ref = p.transaction_id || p.order_id || p.reference || null;
        all.push({
          id: `p-${p.id}`, kind: "deposit", created_at: p.created_at,
          amount: Number(p.amount), status: p.status, user_id: p.user_id,
          user_label: labelFor(p.user_id), user_email: profiles.get(p.user_id)?.email,
          detail: parts.join(" · "),
          reference: ref,
        });
      }
    }

    let merged = all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (search) {
      const s = search.toLowerCase();
      merged = merged.filter((r) =>
        r.user_label.toLowerCase().includes(s) ||
        (r.user_email || "").toLowerCase().includes(s) ||
        r.detail.toLowerCase().includes(s) ||
        (r.reference || "").toLowerCase().includes(s),
      );
    }
    if (statusF && type === "all") {
      merged = merged.filter((r) => r.status === statusF);
    }

    const total = merged.length;
    const page = merged.slice(offset, offset + limit);
    return res.json({ rows: page, total_count: total, has_more: offset + page.length < total });
  } catch (err) {
    logger.error({ err }, "admin/transactions failed");
    return res.status(500).json({ error: "Erreur lecture transactions" });
  }
});

router.get("/admin/deposits", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: "Supabase non configuré" });
  }
  const q = req.query as DepositFilter;
  const limit = Math.min(Math.max(parseInt(q.limit || "200", 10) || 200, 1), 1000);

  const headers: Record<string, string> = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${req.userToken!}`,
  };

  // --- Resolve text search → also match username/email by first finding matching user_ids ---
  let extraUserIds: string[] = [];
  const cleanSearch = q.search ? q.search.replace(/[%,()]/g, "").trim() : "";
  if (cleanSearch) {
    try {
      const pr = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?select=user_id&or=(username.ilike.*${cleanSearch}*,email.ilike.*${cleanSearch}*)&limit=200`,
        { headers },
      );
      if (pr.ok) {
        const rows = (await pr.json()) as Array<{ user_id: string }>;
        extraUserIds = rows.map((r) => r.user_id).filter(Boolean);
      }
    } catch (err) {
      logger.warn({ err }, "admin/deposits: search profiles lookup failed");
    }
  }

  // Build PostgREST query string
  const params = new URLSearchParams();
  params.set("select", "id,user_id,amount,status,method,reference,created_at,bonus_amount,bonus_status,bonus_credited_at,credited_at");
  params.set("order", "created_at.desc");
  params.set("limit", String(limit));

  if (q.status && q.status !== "all") params.append("status", `eq.${q.status}`);
  if (q.bonus_status && q.bonus_status !== "all") params.append("bonus_status", `eq.${q.bonus_status}`);

  // Period (quick) takes precedence over `from` if both supplied
  const periodFrom = periodToFromIso(q.period);
  if (periodFrom) params.append("created_at", `gte.${periodFrom}`);
  else if (q.from) params.append("created_at", `gte.${new Date(q.from).toISOString()}`);
  if (q.to) {
    const end = new Date(q.to);
    end.setHours(23, 59, 59, 999);
    params.append("created_at", `lte.${end.toISOString()}`);
  }
  if (q.min_amount) params.append("amount", `gte.${parseInt(q.min_amount, 10)}`);
  if (q.max_amount) params.append("amount", `lte.${parseInt(q.max_amount, 10)}`);

  if (cleanSearch) {
    // Combine reference match + user_id IN (matching users)
    const orParts = [`reference.ilike.*${cleanSearch}*`];
    if (extraUserIds.length) orParts.push(`user_id.in.(${extraUserIds.join(",")})`);
    // Always keep direct user_id substring match as a fallback for raw IDs
    orParts.push(`user_id.ilike.*${cleanSearch}*`);
    params.append("or", `(${orParts.join(",")})`);
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/payments?${params.toString()}`, { headers });
    if (!r.ok) {
      const body = await r.text();
      logger.error({ status: r.status, body: body.slice(0, 200) }, "admin/deposits fetch failed");
      return res.status(502).json({ error: "Lecture des dépôts échouée" });
    }
    let rows = (await r.json()) as PaymentApi[];

    // --- Optional filter: min_user_deposits (≥ N completed deposits per user, all-time) ---
    const minN = parseInt(q.min_user_deposits || "", 10);
    if (Number.isFinite(minN) && minN >= 1) {
      try {
        const allUserIds = Array.from(new Set(rows.map((p) => p.user_id))).filter(Boolean);
        if (allUserIds.length) {
          const cr = await fetch(
            `${SUPABASE_URL}/rest/v1/payments?select=user_id&status=eq.completed&user_id=in.(${allUserIds.join(",")})&limit=10000`,
            { headers },
          );
          if (cr.ok) {
            const counts: Record<string, number> = {};
            for (const row of (await cr.json()) as Array<{ user_id: string }>) {
              counts[row.user_id] = (counts[row.user_id] || 0) + 1;
            }
            rows = rows.filter((p) => (counts[p.user_id] || 0) >= minN);
          }
        }
      } catch (err) {
        logger.warn({ err }, "admin/deposits: min_user_deposits lookup failed");
      }
    }

    // --- Enrich with user profile info (username + email) ---
    const userIds = Array.from(new Set(rows.map((p) => p.user_id))).filter(Boolean);
    let profilesByUid: Record<string, ProfileLite> = {};
    if (userIds.length) {
      try {
        const pr = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?select=user_id,username,email&user_id=in.(${userIds.join(",")})`,
          { headers },
        );
        if (pr.ok) {
          for (const p of (await pr.json()) as ProfileLite[]) {
            profilesByUid[p.user_id] = p;
          }
        }
      } catch (err) {
        logger.warn({ err }, "admin/deposits: profile enrich failed");
      }
    }

    // Counters (over the filtered set returned)
    let totalAmount = 0;
    let bonusPending = 0;
    let bonusCreditedCount = 0;
    let bonusCreditedFcfa = 0;
    let bonusEligibleCount = 0;
    for (const p of rows) {
      totalAmount += Number(p.amount || 0);
      if (p.bonus_status === "pending") bonusPending++;
      if (p.bonus_status === "credited") {
        bonusCreditedCount++;
        bonusCreditedFcfa += Number(p.bonus_amount || 0);
      }
      if (Number(p.amount || 0) >= BONUS_THRESHOLD_FCFA) bonusEligibleCount++;
    }

    const enriched = rows.map((p) => ({
      ...p,
      user_username: profilesByUid[p.user_id]?.username ?? null,
      user_email: profilesByUid[p.user_id]?.email ?? null,
    }));

    return res.json({
      deposits: enriched,
      counters: {
        total: rows.length,
        total_amount_fcfa: totalAmount,
        bonus_pending: bonusPending,
        bonus_credited: bonusCreditedCount,
        bonus_credited_fcfa: bonusCreditedFcfa,
        bonus_eligible: bonusEligibleCount,
      },
      bonus_rule: { threshold_fcfa: BONUS_THRESHOLD_FCFA, bonus_fcfa: BONUS_AMOUNT_FCFA },
    });
  } catch (err) {
    logger.error({ err }, "admin/deposits unexpected error");
    return res.status(500).json({ error: "Erreur interne" });
  }
});

// POST /api/admin/deposits/:id/status  body: { status: "completed"|"failed"|"rejected"|"pending" }
//   - "completed" → triggers credit (idempotent)
//   - others → marks status; refuses if already credited
router.post("/admin/deposits/:id/status", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const id = String(req.params["id"]);
  const status = String((req.body ?? {}).status || "").toLowerCase();
  if (!id) return res.status(400).json({ error: "id manquant" });
  if (!["completed", "failed", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "statut invalide" });
  }

  if (status === "completed") {
    const out = await creditDeposit(id, { userToken: req.userToken });
    if (!out.ok) return res.status(out.status || 500).json({ error: out.error });
    return res.json({
      ok: true,
      already_credited: out.alreadyCredited,
      amount_credited: out.amountCredited,
      bonus_credited: out.bonusCredited,
      new_balance: out.newBalance,
    });
  }

  const out = await markPaymentStatus(id, status as "failed" | "rejected" | "pending", req.userToken);
  if (!out.ok) return res.status(out.status || 500).json({ error: out.error });
  return res.json({ ok: true });
});

// POST /api/admin/deposits/:id/credit-bonus
//   - For an already-completed deposit ≥ 5 000 FCFA where the bonus was
//     never given (bonus_status !== 'credited'), retry only the bonus part.
router.post("/admin/deposits/:id/credit-bonus", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const id = String(req.params["id"]);
  if (!id) return res.status(400).json({ error: "id manquant" });

  const out = await creditDeposit(id, { userToken: req.userToken, forceBonusCredit: true });
  if (!out.ok) return res.status(out.status || 500).json({ error: out.error });
  return res.json({
    ok: true,
    already_credited: out.alreadyCredited,
    bonus_credited: out.bonusCredited,
    new_balance: out.newBalance,
  });
});

// =====================================================================
// USER MANAGEMENT (full edit + password reset)
// =====================================================================
//
// All three endpoints below require admin role and use the SERVICE ROLE
// key. The browser MUST NEVER call Supabase admin APIs directly — the
// service-role key is server-only.

interface AuthUserLite {
  id: string;
  email: string | null;
  phone: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

async function fetchAuthUser(userId: string): Promise<AuthUserLite | null> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: serviceRoleHeaders(),
  });
  if (!r.ok) return null;
  const data = await r.json() as Record<string, unknown>;
  return {
    id: String(data.id ?? userId),
    email: (data.email as string | null) ?? null,
    phone: (data.phone as string | null) ?? null,
    created_at: (data.created_at as string) ?? "",
    last_sign_in_at: (data.last_sign_in_at as string | null) ?? null,
  };
}

// GET /api/admin/users/total-balance
// Renvoie la somme des soldes de tous les utilisateurs + leur nombre.
// Utilisé par la carte "Solde total" dans le panneau admin (mise à jour
// en temps réel via Supabase Realtime côté client + repli polling 15 s).
router.get("/admin/users/total-balance", requireUser, requireAdmin, async (_req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Configuration serveur manquante" });
  }
  try {
    const params = new URLSearchParams();
    params.set("select", "balance");
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${params.toString()}`, {
      headers: {
        ...serviceRoleHeaders(),
        Range: "0-1000000",
        "Range-Unit": "items",
        Prefer: "count=exact",
      },
    });
    if (!r.ok && r.status !== 206) {
      const body = await r.text();
      logger.error({ status: r.status, body: body.slice(0, 200) }, "admin/users/total-balance failed");
      return res.status(502).json({ error: "Lecture des soldes impossible" });
    }
    const rows = await r.json() as Array<{ balance: number | string | null }>;
    const total = rows.reduce((sum, row) => sum + (Number(row.balance) || 0), 0);
    const range = r.headers.get("content-range");
    let count = rows.length;
    if (range && /\/(\d+)$/.test(range)) {
      count = Number(range.match(/\/(\d+)$/)![1]);
    }
    res.json({
      total_balance: Math.round(total),
      user_count: count,
      currency: "FCFA",
    });
  } catch (err) {
    logger.error({ err }, "admin/users/total-balance error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/admin/users?search=&limit=&offset=
router.get("/admin/users", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Configuration serveur manquante" });
  }
  const q = req.query as Record<string, string | undefined>;
  const search = (q.search || "").replace(/[%,()]/g, "").trim();
  const limit = Math.min(Math.max(parseInt(q.limit || "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(q.offset || "0", 10) || 0, 0);

  const params = new URLSearchParams();
  params.set("select", "user_id,username,email,phone,whatsapp,country,balance,is_active,created_at,affiliate_earnings");
  params.set("order", "created_at.desc");
  if (search) {
    const s = `*${search}*`;
    params.set("or", `(username.ilike.${s},email.ilike.${s},phone.ilike.${s})`);
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${params.toString()}`, {
    headers: {
      ...serviceRoleHeaders(),
      Range: `${offset}-${offset + limit - 1}`,
      "Range-Unit": "items",
      Prefer: "count=exact",
    },
  });
  if (!r.ok && r.status !== 206) {
    const body = await r.text();
    logger.error({ status: r.status, body: body.slice(0, 200) }, "admin/users list failed");
    return res.status(502).json({ error: "Lecture des utilisateurs impossible" });
  }
  let rows = await r.json() as Array<Record<string, unknown>>;
  const range = r.headers.get("content-range");
  let totalCount: number | null = null;
  if (range && /\/(\d+)$/.test(range)) {
    totalCount = Number(range.match(/\/(\d+)$/)![1]);
  }

  // Enrich rows whose profiles.email is empty by falling back to auth.users.email.
  // Done per-row only when needed; in steady-state profiles.email is populated at signup.
  const missing = rows.filter(r => !r["email"] || String(r["email"]).trim() === "");
  // Bounded concurrency (8 parallel) so a page with many missing emails
  // doesn't open hundreds of sockets at once.
  if (missing.length > 0) {
    const CONCURRENCY = 8;
    for (let i = 0; i < missing.length; i += CONCURRENCY) {
      const batch = missing.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row) => {
        const id = String(row["user_id"] || "");
        if (!id) return;
        const au = await fetchAuthUser(id);
        if (au?.email) row["email"] = au.email;
      }));
    }
  }

  res.json({ users: rows, total_count: totalCount, has_more: rows.length === limit });
});

// PATCH /api/admin/users/:userId — body: { username?, email?, phone?, whatsapp?, country?, balance?, is_active? }
router.patch("/admin/users/:userId", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Configuration serveur manquante" });
  }
  const userId = req.params["userId"];
  if (!userId || !/^[0-9a-fA-F-]{36}$/.test(userId)) {
    return res.status(400).json({ error: "user_id invalide" });
  }
  const b = (req.body || {}) as Record<string, unknown>;
  const profilePatch: Record<string, unknown> = {};
  if (typeof b.username === "string") profilePatch["username"] = b.username.trim();
  if (typeof b.email === "string") {
    const e = b.email.trim().toLowerCase();
    // Empty string means "no change" — clearing the email is not allowed
    // (would desync auth.users.email which cannot be empty either).
    if (e !== "") profilePatch["email"] = e;
  }
  if (typeof b.phone === "string") profilePatch["phone"] = b.phone.trim();
  if (typeof b.whatsapp === "string") profilePatch["whatsapp"] = b.whatsapp.trim();
  if (typeof b.country === "string") profilePatch["country"] = b.country.trim();
  if (b.balance !== undefined && b.balance !== null && b.balance !== "") {
    const bal = Number(b.balance);
    if (!Number.isFinite(bal) || bal < 0) return res.status(400).json({ error: "Solde invalide" });
    profilePatch["balance"] = Math.round(bal);
  }
  if (typeof b.is_active === "boolean") profilePatch["is_active"] = b.is_active;

  const newEmail = typeof profilePatch["email"] === "string" ? (profilePatch["email"] as string) : null;
  if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).json({ error: "Email invalide" });
  }

  // 1) Propagate email to auth.users FIRST so a failure (e.g. email already
  //    taken) does not leave profiles.email out of sync with auth.users.email.
  if (newEmail) {
    const r = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: serviceRoleHeaders(),
        body: JSON.stringify({ email: newEmail, email_confirm: true }),
      },
    );
    if (!r.ok) {
      const body = await r.text();
      logger.error({ status: r.status, body: body.slice(0, 300) }, "admin/users auth email update failed");
      // Common upstream case: email already in use by another account.
      const friendly = /already|exists|taken|duplicate/i.test(body)
        ? "Cet email est déjà utilisé par un autre compte"
        : "Mise à jour de l'email impossible";
      return res.status(502).json({ error: friendly });
    }
  }

  // 2) Update profile row (RLS bypassed via service role)
  if (Object.keys(profilePatch).length > 0) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: { ...serviceRoleHeaders(), Prefer: "return=representation" },
        body: JSON.stringify(profilePatch),
      },
    );
    if (!r.ok) {
      const body = await r.text();
      logger.error({ status: r.status, body: body.slice(0, 200) }, "admin/users patch profile failed");
      return res.status(502).json({ error: "Mise à jour du profil impossible" });
    }
  }

  res.json({ ok: true });
});

// POST /api/admin/users/:userId/password — body: { password }
router.post("/admin/users/:userId/password", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Configuration serveur manquante" });
  }
  const userId = req.params["userId"];
  if (!userId || !/^[0-9a-fA-F-]{36}$/.test(userId)) {
    return res.status(400).json({ error: "user_id invalide" });
  }
  const password = (req.body && typeof req.body.password === "string") ? req.body.password : "";
  if (password.length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères" });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: "Mot de passe trop long" });
  }
  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "PUT",
      headers: serviceRoleHeaders(),
      body: JSON.stringify({ password }),
    },
  );
  if (!r.ok) {
    const body = await r.text();
    logger.error({ status: r.status, body: body.slice(0, 300) }, "admin/users password update failed");
    return res.status(502).json({ error: "Réinitialisation du mot de passe impossible : " + body.slice(0, 200) });
  }
  res.json({ ok: true, user_id: userId });
});

// ---------------------------------------------------------------------------
// AfribaPay operator health (circuit breaker) — admin diagnostics
// ---------------------------------------------------------------------------
// GET /api/admin/operators/health → liste des opérateurs masqués
router.get("/admin/operators/health", requireUser, requireAdmin, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    cooldown_ms: COOLDOWN_MS,
    unavailable: listUnavailableOperators(),
  });
});

// POST /api/admin/operators/health/clear → réinitialiser (tout, ou un pays/opérateur)
//   body: { country?: "CI", operator?: "orange" }  (vide = tout vider)
router.post("/admin/operators/health/clear", requireUser, requireAdmin, (req: AuthedRequest, res) => {
  const country = req.body?.country ? String(req.body.country) : undefined;
  const operator = req.body?.operator ? String(req.body.operator) : undefined;
  const cleared = clearOperatorHealth(country, operator);
  // Vider aussi le cache de la liste pour que la réapparition soit instantanée
  bustCountriesCache();
  res.json({ ok: true, cleared });
});

// ---------------------------------------------------------------------------
// Taux de conversion des devises non-CFA (configurable par l'admin)
// ---------------------------------------------------------------------------

/** Load currency rate rows from the settings table. */
async function fetchCurrencyRateSettings(): Promise<Record<string, number>> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return {};
  try {
    const keys = NON_CFA_COUNTRIES_INFO.map(c => `currency_rate_${c.code}`);
    const filter = keys.map(k => `key=eq.${encodeURIComponent(k)}`).join(",");
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?or=(${filter})&select=key,value`,
      { headers: serviceRoleHeaders() },
    );
    if (!r.ok) return {};
    const rows = (await r.json()) as { key: string; value: string }[];
    const overrides: Record<string, number> = {};
    for (const row of rows) {
      const m = /^currency_rate_([A-Z]{2})$/i.exec(row.key);
      if (m && m[1]) {
        const parsed = parseFloat(row.value);
        if (Number.isFinite(parsed) && parsed > 0) {
          overrides[m[1].toUpperCase()] = parsed;
        }
      }
    }
    return overrides;
  } catch (err) {
    logger.error({ err }, "fetchCurrencyRateSettings failed");
    return {};
  }
}

// GET /api/admin/currencies — liste des taux de conversion non-CFA
router.get("/admin/currencies", requireUser, requireAdmin, async (_req, res) => {
  const overrides = await fetchCurrencyRateSettings();
  // Populate the in-memory cache so subsequent deposit conversions pick up
  // the admin-configured rates without hitting Supabase again.
  setRateOverrides(overrides);

  const rates = NON_CFA_COUNTRIES_INFO.map(c => ({
    country: c.code,
    name: c.name,
    currency: c.currency,
    symbol: c.symbol,
    fcfaPerUnit: overrides[c.code] ?? c.defaultFcfaPerUnit,
    default: c.defaultFcfaPerUnit,
  }));

  res.set("Cache-Control", "no-store");
  res.json({ rates });
});

// PUT /api/admin/currencies — modifier le taux d'un pays
//   body: { country: "CD", fcfaPerUnit: 0.28 }
router.put("/admin/currencies", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Configuration serveur manquante" });
  }

  const country = req.body?.country;
  const fcfaPerUnit = req.body?.fcfaPerUnit;

  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country.toUpperCase())) {
    return res.status(400).json({ error: "Paramètre country invalide (code ISO 2 lettres requis)" });
  }
  const upperCountry = country.toUpperCase();

  const allowed = NON_CFA_COUNTRIES_INFO.map(c => c.code);
  if (!allowed.includes(upperCountry)) {
    return res.status(400).json({ error: `Pays non modifiable : ${upperCountry}. Seuls ${allowed.join(", ")} sont configurables.` });
  }

  const rate = typeof fcfaPerUnit === "number" ? fcfaPerUnit : parseFloat(String(fcfaPerUnit));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
    return res.status(400).json({ error: "Taux invalide (doit être un nombre positif)" });
  }

  const settingKey = `currency_rate_${upperCountry}`;

  // Upsert the rate into the settings table.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/settings`,
    {
      method: "POST",
      headers: { ...serviceRoleHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ key: settingKey, value: String(rate) }),
    },
  );
  if (!r.ok) {
    const body = await r.text();
    logger.error({ status: r.status, body: body.slice(0, 300) }, "admin/currencies upsert failed");
    return res.status(502).json({ error: "Impossible de sauvegarder le taux" });
  }

  // Refresh the in-memory cache with the latest values from DB.
  const latest = await fetchCurrencyRateSettings();
  setRateOverrides(latest);
  logger.info({ country: upperCountry, fcfaPerUnit: rate }, "admin: currency rate updated");

  res.json({ ok: true, country: upperCountry, fcfaPerUnit: rate });
});

// DELETE /api/admin/currencies/:country — remettre le taux par défaut
router.delete("/admin/currencies/:country", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Configuration serveur manquante" });
  }

  const upperCountry = String(req.params["country"] ?? "").toUpperCase();
  const allowed = NON_CFA_COUNTRIES_INFO.map(c => c.code);
  if (!allowed.includes(upperCountry)) {
    return res.status(400).json({ error: `Pays non modifiable : ${upperCountry}` });
  }

  const settingKey = `currency_rate_${upperCountry}`;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(settingKey)}`,
    { method: "DELETE", headers: serviceRoleHeaders() },
  );
  if (!r.ok) {
    return res.status(502).json({ error: "Suppression impossible" });
  }

  // Refresh cache with the remaining overrides — the deleted key is gone from
  // the DB so it won't appear in `latest`, and subsequent getCurrencyInfo()
  // calls will correctly fall back to the hardcoded default for that country.
  const latest = await fetchCurrencyRateSettings();
  setRateOverrides(latest);

  logger.info({ country: upperCountry }, "admin: currency rate reset to default");
  res.json({ ok: true });
});

export default router;
