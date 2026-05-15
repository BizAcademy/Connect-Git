import { Router, type IRouter, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";
import { requireUser, requireAdmin, type AuthedRequest } from "../lib/auth";
import { enrichServices, defaultPriceFcfa, defaultPriceFcfaForCurrency, loadPricing } from "../lib/smm-pricing";
import { appendEarning, computeEarning, estimateGainFromRevenue, findEarning, findEarningOwner } from "../lib/earnings";
import {
  callProvider,
  getProvider,
  parseProviderId,
  ALL_PROVIDER_IDS,
  loadProviderConfig,
  type ProviderId,
} from "../lib/smm-providers";
import {
  FINAL_REFUND_STATUSES,
  mapProviderStatus,
  isSupportedServiceType,
} from "../lib/smm-status";

const router: IRouter = Router();

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] || process.env["VITE_SUPABASE_ANON_KEY"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

function serviceRoleHeaders(): Record<string, string> {
  const key = SUPABASE_SERVICE_ROLE_KEY!;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  logger.warn(
    "Supabase is not configured for SMM orders: set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY) as server secrets. Order requests will return HTTP 503 until these are provided.",
  );
}

// Cache TTL: 30 minutes (provider service lists rarely change)
const CACHE_TTL_MS = 30 * 60_000;

// Raw services cache — used by order placement and admin routes
const svcCache: Map<number, { ts: number; data: any[] }> = new Map();
async function getRawServices(providerId: ProviderId): Promise<any[]> {
  const hit = svcCache.get(providerId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const data = await callProvider(providerId, "services");
  svcCache.set(providerId, { ts: Date.now(), data });
  return data;
}

// Enriched & filtered cache — the final public-facing list, pre-computed once.
// Avoids re-running enrichServices + filter on every /smm/services request.
const enrichedCache: Map<number, { ts: number; services: any[]; etag: string }> = new Map();
const enrichedInflight: Map<number, Promise<{ services: any[]; etag: string }>> = new Map();

async function getEnrichedServices(
  providerId: ProviderId,
): Promise<{ services: any[]; etag: string }> {
  const hit = enrichedCache.get(providerId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit;

  const ongoing = enrichedInflight.get(providerId);
  if (ongoing) return ongoing;

  const p = (async () => {
    const raw = await getRawServices(providerId);
    const enriched = await enrichServices(raw, providerId);
    const services = enriched.filter(
      (s) => !s.hidden && isSupportedServiceType(s.type),
    );
    const etag = `"${providerId}-${Date.now()}"`;
    const entry = { ts: Date.now(), services, etag };
    enrichedCache.set(providerId, entry);
    return entry;
  })().finally(() => enrichedInflight.delete(providerId));

  enrichedInflight.set(providerId, p);
  return p;
}

// Warm the cache for all providers at server startup (fire-and-forget)
export async function warmServicesCache(): Promise<void> {
  for (const pid of ALL_PROVIDER_IDS) {
    try {
      await getEnrichedServices(pid as ProviderId);
      logger.info({ providerId: pid }, "services cache warmed");
    } catch (err) {
      logger.warn({ err, providerId: pid }, "services cache warm failed");
    }
  }
}

// --- Tiny in-memory rate limiter for /order ------------------------------
const orderHits = new Map<string, { count: number; resetAt: number }>();
function rateLimitOrders(req: AuthedRequest, res: Response, next: NextFunction) {
  const key = req.userId || req.ip || "anon";
  const now = Date.now();
  const entry = orderHits.get(key);
  if (!entry || entry.resetAt < now) {
    orderHits.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (entry.count >= 10) {
    return res.status(429).json({ error: "Trop de commandes, réessayez dans 1 minute" });
  }
  entry.count += 1;
  next();
}

// --- Supabase helpers (server-side, using user's JWT token) --------------

function supabaseHeaders(userToken: string): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY!,
    Authorization: `Bearer ${userToken}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

// Country → ISO currency code (mirrors frontend currency.ts COUNTRY_CURRENCY)
const COUNTRY_TO_CURRENCY: Record<string, string> = {
  BJ: "XOF", BF: "XOF", CI: "XOF", GW: "XOF", ML: "XOF", NE: "XOF", SN: "XOF", TG: "XOF",
  CM: "XAF", CF: "XAF", TD: "XAF", CG: "XAF", GQ: "XAF", GA: "XAF",
  CD: "CDF", GN: "GNF", GM: "GMD",
};
function countryToCurrency(country: string | null | undefined): string {
  if (!country) return "XOF";
  return COUNTRY_TO_CURRENCY[country.toUpperCase()] ?? "XOF";
}

/** Fetch the user's country from their Supabase profile (uses their session token). */
async function getUserCountry(userId: string, userToken: string): Promise<string | null> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=country&limit=1`;
    const r = await fetch(url, { headers: supabaseHeaders(userToken) });
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ country: string | null }>;
    return rows[0]?.country ?? null;
  } catch {
    return null;
  }
}

async function getUserBalance(userId: string, userToken: string): Promise<number | null> {
  const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=balance`;
  const r = await fetch(url, { headers: supabaseHeaders(userToken) });
  if (!r.ok) return null;
  const rows = await r.json() as { balance: number }[];
  if (!rows || rows.length === 0) return null;
  return Number(rows[0].balance);
}

async function debitBalance(
  userId: string,
  userToken: string,
  currentBalance: number,
  amount: number,
): Promise<number | null> {
  const newBalance = currentBalance - amount;
  const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&balance=eq.${currentBalance}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders(userToken),
    body: JSON.stringify({ balance: newBalance }),
  });
  if (!r.ok) return null;
  const rows = await r.json() as { balance: number }[];
  if (!rows || rows.length === 0) return null;
  return Number(rows[0].balance);
}

async function refundBalance(userId: string, userToken: string, amount: number): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await getUserBalance(userId, userToken);
    if (current === null) {
      logger.error({ userId }, "refund: could not read balance");
      return;
    }
    const newBalance = current + amount;
    const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&balance=eq.${current}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: supabaseHeaders(userToken),
      body: JSON.stringify({ balance: newBalance }),
    });
    if (!r.ok) {
      logger.error({ userId, attempt }, "refund: PATCH request failed");
      return;
    }
    const rows = await r.json() as { balance: number }[];
    if (rows && rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  logger.error({ userId }, "refund: exhausted CAS retries, balance may not be restored");
}

// --- Routes --------------------------------------------------------------

// Public: list of enabled providers (display order, header text). No
// credentials are ever returned. Used by the user-facing provider picker.
router.get("/smm/providers", async (_req, res) => {
  try {
    const cfg = await loadProviderConfig();
    const visible = cfg
      .filter((p) => p.enabled && getProvider(p.provider_id)?.configured)
      .map((p) => ({
        provider_id: p.provider_id,
        display_order: p.display_order,
        header_title: p.header_title,
        header_text: p.header_text,
      }));
    res.json({ providers: visible });
  } catch (err) {
    logger.error({ err }, "smm providers list error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Public: list services for a given provider (default = 1).
// Hides:
//   - services explicitly marked hidden in the pricing override
//   - services whose `type` requires extra parameters our generic order
//     endpoint does not collect (Custom Comments, Mentions, Polls,
//     Subscriptions, Comment Likes). Ordering them would only fail at the
//     provider and trigger a manual refund. See lib/smm-status.ts.
router.get("/smm/services", async (req, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  try {
    const { services, etag } = await getEnrichedServices(providerId);
    // Let browsers & proxies cache for 5 minutes; allow stale for 30 min while revalidating
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=1800");
    res.setHeader("ETag", etag);
    // Fast path: client already has this version
    if (req.headers["if-none-match"] === etag) {
      res.sendStatus(304);
      return;
    }
    res.json({ services, provider: providerId });
  } catch (err) {
    logger.error({ err, providerId }, "SMM services error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Admin only: provider-wide balance for a specific provider
router.get("/smm/balance", requireUser, requireAdmin, async (req, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  try {
    const data = await callProvider(providerId, "balance");
    res.json({ ...data, provider: providerId });
  } catch (err) {
    logger.error({ err, providerId }, "SMM balance error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Authenticated + rate-limited: place order with server-side billing enforcement
router.post("/smm/order", requireUser, rateLimitOrders, async (req: AuthedRequest, res) => {
  const { service, link, quantity, provider } = req.body || {};
  const providerId = parseProviderId(provider);

  const serviceNum = Number(service);
  const qtyNum = Number(quantity);
  const linkStr = typeof link === "string" ? link.trim() : "";

  if (!Number.isInteger(serviceNum) || serviceNum <= 0) {
    return res.status(400).json({ error: "service invalide" });
  }
  if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 10_000_000) {
    return res.status(400).json({ error: "quantity invalide (1 — 10 000 000)" });
  }
  if (!linkStr || linkStr.length < 5 || linkStr.length > 500 || !/^https?:\/\//i.test(linkStr)) {
    return res.status(400).json({ error: "link doit être une URL http(s) valide" });
  }
  const providerRuntime = getProvider(providerId);
  if (!providerRuntime?.configured) {
    return res.status(400).json({ error: `Fournisseur SMM #${providerId} non configuré` });
  }
  // Also enforce the admin's "enabled" toggle from smm_providers_config.
  // Without this, a user could bypass the picker by hand-crafting a request
  // for a disabled provider whose env keys still happen to be set.
  const cfgList = await loadProviderConfig();
  const cfgRow = cfgList.find((c) => c.provider_id === providerId);
  if (cfgRow && cfgRow.enabled === false) {
    return res.status(403).json({ error: `Fournisseur SMM #${providerId} actuellement désactivé` });
  }

  const userId = req.userId!;
  const userToken = req.userToken!;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    logger.error("SMM order rejected: Supabase env vars missing");
    return res
      .status(503)
      .json({ error: "Service temporairement indisponible — configuration serveur incomplète" });
  }

  try {
    const raw = await getRawServices(providerId);
    const svc = raw.find((s: any) => Number(s.service) === serviceNum);
    if (!svc) {
      return res.status(404).json({ error: "Service introuvable" });
    }
    // Defence in depth: even though the public catalogue hides services
    // whose type our generic payload cannot satisfy (Custom Comments,
    // Mentions, Polls, Subscriptions, ...), reject them server-side too.
    // Otherwise a client that cached the old list (or crafted a request by
    // hand) could submit one and get charged for an order the provider
    // would refuse, forcing a refund cycle.
    if (!isSupportedServiceType(svc.type)) {
      return res.status(400).json({
        error: "Type de service non supporté (paramètres additionnels requis)",
      });
    }
    const pricingMap = await loadPricing(providerId);
    const override = pricingMap[String(serviceNum)];
    if (override?.hidden) {
      return res.status(403).json({ error: "Service non disponible" });
    }

    const userCountry = await getUserCountry(userId, userToken);
    const userCurrency = countryToCurrency(userCountry);
    const pricePerK =
      typeof override?.price_fcfa === "number"
        ? override.price_fcfa
        : defaultPriceFcfaForCurrency(svc.rate, providerId, userCurrency);
    const totalPrice = Math.ceil((qtyNum / 1000) * pricePerK);

    const currentBalance = await getUserBalance(userId, userToken);
    if (currentBalance === null) {
      return res.status(500).json({ error: "Impossible de lire votre solde" });
    }
    if (currentBalance < totalPrice) {
      return res.status(402).json({ error: "Solde insuffisant. Rechargez votre compte." });
    }

    const newBalance = await debitBalance(userId, userToken, currentBalance, totalPrice);
    if (newBalance === null) {
      return res.status(409).json({ error: "Solde modifié entre-temps, veuillez réessayer." });
    }

    let providerData: any;
    try {
      providerData = await callProvider(providerId, "add", { service: serviceNum, link: linkStr, quantity: qtyNum });
    } catch (providerErr) {
      logger.error({ err: providerErr, userId, providerId }, "SMM provider call failed — refunding");
      await refundBalance(userId, userToken, totalPrice);
      return res.status(502).json({ error: "Le fournisseur n'a pas accepté la commande" });
    }

    if (providerData?.error) {
      logger.warn({ providerData, userId, providerId }, "SMM provider returned error body — refunding");
      await refundBalance(userId, userToken, totalPrice);
      const rawMsg = String(providerData.error || "");
      // Détection "solde fournisseur insuffisant" — afficher un message orienté
      // utilisateur (vert côté UI) plutôt que l'erreur technique du fournisseur.
      const isInsufficientFunds = /not\s*enough\s*funds|insufficient\s*(funds|balance)|solde\s*insuffisant/i.test(rawMsg);
      if (isInsufficientFunds) {
        return res.status(503).json({
          error: "SERVICE MOMENTANÉMENT INDISPONIBLE VEILLEZ CHANGER DE FOURNISSEURS",
          provider_unavailable: true,
        });
      }
      return res.status(502).json({ error: rawMsg || "Le fournisseur n'a pas accepté la commande" });
    }

    // -----------------------------------------------------------------------
    // Persist the order server-side (service role key → bypasses RLS).
    // Previously this was done client-side which caused "invisible orders"
    // when the user's JWT had expired or the browser closed before the insert.
    // -----------------------------------------------------------------------
    const externalOrderId = String(providerData.order ?? providerData.id ?? "");
    let localOrderId: string | null = null;
    if (SUPABASE_URL) {
      try {
        const insertHeaders = SUPABASE_SERVICE_ROLE_KEY
          ? serviceRoleHeaders()
          : supabaseHeaders(userToken);
        const insRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
          method: "POST",
          headers: insertHeaders,
          body: JSON.stringify({
            user_id: userId,
            service_name: String(svc.name ?? serviceNum),
            service_category: String(svc.category ?? ""),
            link: linkStr,
            quantity: qtyNum,
            price: totalPrice,
            status: "processing",
            external_order_id: externalOrderId,
            provider: providerId,
          }),
        });
        if (insRes.ok) {
          const rows = (await insRes.json()) as Array<{ id: string }>;
          localOrderId = rows[0]?.id ?? null;
          logger.info({ userId, externalOrderId, localOrderId, providerId }, "order: local record saved");
        } else {
          const txt = await insRes.text().catch(() => "");
          logger.error(
            { status: insRes.status, body: txt.slice(0, 300), userId, externalOrderId },
            "order: local insert failed — order IS placed at provider, balance debited",
          );
        }
      } catch (insErr) {
        logger.error(
          { err: insErr, userId, externalOrderId },
          "order: local insert exception — order IS placed at provider, balance debited",
        );
      }
    }

    // Earnings are recorded on order COMPLETION (in syncOrderInternal),
    // not here at creation — so only confirmed completed orders appear
    // in the admin revenue dashboard.
    res.json({ ...providerData, provider: providerId, local_order_id: localOrderId });
  } catch (err) {
    logger.error({ err, userId, providerId }, "SMM order error");
    res.status(500).json({ error: "Erreur interne lors de la commande" });
  }
});

// GET /api/smm/user-orders — user's own orders via service-role (bypasses RLS)
router.get("/smm/user-orders", requireUser, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.json([]);
  try {
    const userId = req.userId!;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
      { headers: serviceRoleHeaders() },
    );
    if (!r.ok) {
      req.log.error({ status: r.status }, "user-orders: supabase error");
      return res.json([]);
    }
    const data = (await r.json()) as unknown[];
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    req.log.error({ err }, "user-orders: exception");
    res.json([]);
  }
});

// GET /api/smm/user-payments — user's own payments via service-role (bypasses RLS)
router.get("/smm/user-payments", requireUser, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.json([]);
  try {
    const userId = req.userId!;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
      { headers: serviceRoleHeaders() },
    );
    if (!r.ok) {
      req.log.error({ status: r.status }, "user-payments: supabase error");
      return res.json([]);
    }
    const data = (await r.json()) as unknown[];
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    req.log.error({ err }, "user-payments: exception");
    res.json([]);
  }
});

// Authenticated: server-side price quote
router.get("/smm/quote", requireUser, async (req, res) => {
  const providerId = parseProviderId(req.query["provider"]);
  const serviceNum = Number(req.query["service"]);
  const qtyNum = Number(req.query["quantity"]);
  if (!Number.isInteger(serviceNum) || serviceNum <= 0) {
    return res.status(400).json({ error: "service invalide" });
  }
  if (!Number.isInteger(qtyNum) || qtyNum < 1) {
    return res.status(400).json({ error: "quantity invalide" });
  }
  try {
    const raw = await getRawServices(providerId);
    const svc = raw.find((s: any) => Number(s.service) === serviceNum);
    if (!svc) return res.status(404).json({ error: "service introuvable" });
    const map = await loadPricing(providerId);
    const override = map[String(serviceNum)];
    if (override?.hidden) return res.status(403).json({ error: "Service non disponible" });
    const quoterCountry = await getUserCountry((req as AuthedRequest).userId!, (req as AuthedRequest).userToken!);
    const quoterCurrency = countryToCurrency(quoterCountry);
    const pricePerK =
      typeof override?.price_fcfa === "number"
        ? override.price_fcfa
        : defaultPriceFcfaForCurrency(svc.rate, providerId, quoterCurrency);
    const total = Math.ceil((qtyNum / 1000) * pricePerK);
    res.json({
      service: serviceNum,
      provider: providerId,
      quantity: qtyNum,
      price_per_1000_fcfa: pricePerK,
      total_fcfa: total,
      price_is_custom: typeof override?.price_fcfa === "number",
    });
  } catch (err) {
    logger.error({ err, providerId }, "SMM quote error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Authenticated: order status — only for orders the user owns
router.get("/smm/status", requireUser, async (req: AuthedRequest, res) => {
  const order = req.query["order"];
  if (!order) return res.status(400).json({ error: "order id required" });
  const providerId = parseProviderId(req.query["provider"]);

  const orderStr = String(order);
  const userId = req.userId!;

  try {
    let ownerUserId = await findEarningOwner(orderStr, providerId);
    if (!ownerUserId && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      // Earnings are only written on completion; for in-progress orders fall back to orders table
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/orders?external_order_id=eq.${encodeURIComponent(orderStr)}&provider=eq.${providerId}&select=user_id&limit=1`,
          { headers: serviceRoleHeaders() },
        );
        if (r.ok) {
          const rows = (await r.json()) as Array<{ user_id: string }>;
          ownerUserId = rows[0]?.user_id ?? null;
        }
      } catch { /* ignore */ }
    }
    if (!ownerUserId || ownerUserId !== userId) {
      return res.status(403).json({ error: "Commande introuvable ou accès refusé" });
    }

    const data = await callProvider(providerId, "status", { order: orderStr });
    res.json({ ...data, provider: providerId });
  } catch (err) {
    logger.error({ err, providerId }, "SMM status error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Internal helper: sync a single order with its SMM provider's status.
// Provider id is sourced from the local `orders.provider` column (defaults to
// 1 for legacy rows). Idempotent auto-refund applies as before.
// ---------------------------------------------------------------------------
export async function syncOrderInternal(opts: {
  /** Local UUID (PK) — preferred path (no ambiguity across providers). */
  localOrderId?: string;
  /** SMM provider's order id. Required together with `providerId`. */
  externalId?: string;
  /** Required when calling with `externalId` — disambiguates colliding ids. */
  providerId?: ProviderId;
  expectedUserId?: string;
  forceRefund?: boolean;
}): Promise<{
  ok: true;
  status: string;
  previous_status?: string;
  refunded: boolean;
  refunded_amount?: number;
  user_id?: string;
  provider?: number;
} | { ok: false; status: number; error: string }> {
  const { localOrderId, externalId: extIn, providerId: providerIn, expectedUserId, forceRefund } = opts;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 503, error: "Configuration serveur manquante (SUPABASE_SERVICE_ROLE_KEY)" };
  }
  if (!localOrderId && !(extIn && providerIn)) {
    return { ok: false, status: 400, error: "syncOrderInternal: localOrderId ou (externalId + providerId) requis" };
  }

  // 1) Look up the local `orders` row first.
  //    - With `localOrderId`: PK lookup — unambiguous.
  //    - With `(externalId, providerId)`: composite scope — required since two
  //      providers can return the same numeric order id.
  const lookupHeader = serviceRoleHeaders();
  const lookupQuery = localOrderId
    ? `?id=eq.${encodeURIComponent(localOrderId)}`
    : `?external_order_id=eq.${encodeURIComponent(extIn!)}` +
      `&provider=eq.${providerIn}`;
  const orderLookupUrl =
    `${SUPABASE_URL}/rest/v1/orders` + lookupQuery +
    `&select=id,user_id,status,refunded_at,refunded_amount,provider,external_order_id,price,service,service_name,quantity&limit=1`;
  const lookupRes = await fetch(orderLookupUrl, { headers: lookupHeader });
  if (!lookupRes.ok) {
    const txt = await lookupRes.text().catch(() => "");
    logger.error({ status: lookupRes.status, body: txt.slice(0, 200), localOrderId, externalId: extIn, providerId: providerIn }, "sync: order lookup failed");
    return { ok: false, status: 502, error: "Lecture commande impossible" };
  }
  const rows = (await lookupRes.json()) as Array<{
    id: string; user_id: string; status: string;
    refunded_at: string | null; refunded_amount: number | null;
    provider: number | null;
    external_order_id: string | null;
    price: number | null;
    service: number | null;
    service_name: string | null;
    quantity: number | null;
  }>;
  if (!rows || rows.length === 0) {
    return { ok: false, status: 404, error: "Commande introuvable" };
  }
  const order = rows[0]!;
  const providerId: ProviderId = (order.provider === 3 || order.provider === 4 || order.provider === 5)
    ? order.provider
    : 1;
  const externalId = order.external_order_id || extIn || "";
  if (!externalId) {
    return { ok: false, status: 404, error: "Commande sans identifiant fournisseur" };
  }

  // 2) Source the wallet owner and refundable amount from the SERVER-WRITTEN
  //    earnings ledger, scoped to the resolved provider so order ids cannot
  //    collide across providers.
  //    FALLBACK: if no earnings record exists (legacy orders or missed write),
  //    we fall back to orders.user_id and orders.price so the refund is never
  //    silently skipped just because the earnings ledger is incomplete.
  const earning = await findEarning(externalId, providerId);
  const trustedUserId: string | null = earning?.user_id ?? order.user_id ?? null;
  const earningsAmount: number = earning ? Math.max(0, Math.round(Number(earning.user_price_fcfa) || 0)) : 0;
  const orderPriceFallback: number = Math.max(0, Math.round(Number(order.price) || 0));
  // Use earnings amount when available; fall back to the order price for
  // orders placed before the earnings ledger was introduced.
  const trustedAmount: number = earningsAmount > 0 ? earningsAmount : orderPriceFallback;

  if (expectedUserId && !earning) {
    return { ok: false, status: 404, error: "Commande introuvable dans le journal serveur" };
  }
  if (expectedUserId && trustedUserId && trustedUserId !== expectedUserId) {
    return { ok: false, status: 403, error: "Accès refusé" };
  }

  if (!trustedUserId) {
    logger.error({ orderId: order.id, externalId }, "sync: cannot determine wallet owner — skipping refund");
  }

  // 3) Query the matching SMM provider for the up-to-date status
  let providerStatus = "";
  if (!forceRefund) {
    try {
      const provider = await callProvider(providerId, "status", { order: externalId });
      if (provider?.error) {
        return { ok: false, status: 502, error: String(provider.error) };
      }
      providerStatus = mapProviderStatus(provider?.status);
    } catch (err) {
      logger.error({ err, externalId, providerId }, "sync: provider call failed");
      return { ok: false, status: 502, error: "Fournisseur SMM injoignable" };
    }
  }

  const newStatus = forceRefund ? "refunded" : (providerStatus || order.status);
  let refunded = false;
  let refundedAmount: number | undefined;

  if (newStatus && newStatus !== order.status) {
    const patchUrl = `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}`;
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: { ...serviceRoleHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() }),
    });
    if (!patchRes.ok) {
      const txt = await patchRes.text().catch(() => "");
      logger.warn({ status: patchRes.status, body: txt.slice(0, 200), id: order.id }, "sync: status PATCH failed");
    }
  }

  // Record earnings when the order first transitions to "completed".
  // Only confirmed completed orders contribute to the admin revenue dashboard.
  if (newStatus === "completed" && order.status !== "completed") {
    try {
      const userPriceFcfa = Math.max(0, Math.round(Number(order.price) || 0));
      const { provider_cost_fcfa, gain_fcfa } = estimateGainFromRevenue(userPriceFcfa);
      await appendEarning({
        ts: new Date().toISOString(),
        provider_order_id: externalId,
        user_id: order.user_id,
        service: Number(order.service ?? 0),
        service_name: String(order.service_name ?? order.service ?? ""),
        quantity: Number(order.quantity ?? 0),
        rate_usd: 0,
        user_price_fcfa: userPriceFcfa,
        provider_cost_usd: 0,
        provider_cost_fcfa,
        gain_fcfa,
        provider: providerId,
      });
    } catch (e) {
      logger.error({ err: e }, "earnings on completion failed (non-fatal)");
    }
  }

  const eligibleByProvider = FINAL_REFUND_STATUSES.has(newStatus);
  if ((eligibleByProvider || forceRefund) && !order.refunded_at && trustedAmount > 0) {
    const amount = Math.round(trustedAmount);
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/smm_refund_order`, {
      method: "POST",
      headers: serviceRoleHeaders(),
      body: JSON.stringify({ p_order_id: order.id, p_amount: amount }),
    });
    if (!rpcRes.ok) {
      const txt = await rpcRes.text().catch(() => "");
      logger.error(
        { status: rpcRes.status, body: txt.slice(0, 300), orderId: order.id, userId: order.user_id, amount },
        "auto-refund: RPC smm_refund_order failed — order NOT refunded, will retry on next sync",
      );
    } else {
      const rrows = (await rpcRes.json().catch(() => null)) as
        | Array<{ refunded: boolean; refunded_amount: number; user_id: string; new_balance: number }>
        | null;
      const row = rrows && rrows[0];
      if (row?.refunded) {
        refunded = true;
        refundedAmount = row.refunded_amount;
        logger.info(
          { orderId: order.id, userId: order.user_id, amount, externalId, newBalance: row.new_balance },
          "auto-refund credited (atomic RPC)",
        );
      } else {
        logger.info({ orderId: order.id }, "auto-refund: already refunded (idempotent no-op)");
      }
    }
  }

  return {
    ok: true,
    status: newStatus || order.status,
    previous_status: order.status,
    refunded,
    refunded_amount: refundedAmount,
    user_id: order.user_id,
    provider: providerId,
  };
}

function parseProviderQuery(q: unknown): ProviderId | null {
  const n = Number(q);
  if (n === 1 || n === 3 || n === 4 || n === 5) return n as ProviderId;
  return null;
}

router.post("/smm/orders/:externalId/sync", requireUser, async (req: AuthedRequest, res) => {
  const externalId = String(req.params["externalId"] || "");
  if (!externalId) return res.status(400).json({ error: "externalId requis" });
  const providerId = parseProviderQuery(req.query["provider"]);
  if (!providerId) return res.status(400).json({ error: "provider requis (1, 3, 4 ou 5)" });
  const result = await syncOrderInternal({ externalId, providerId, expectedUserId: req.userId });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({
    status: result.status,
    previous_status: result.previous_status,
    refunded: result.refunded,
    refunded_amount: result.refunded_amount,
    provider: result.provider,
  });
});

router.post("/admin/orders/:externalId/sync", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const externalId = String(req.params["externalId"] || "");
  if (!externalId) return res.status(400).json({ error: "externalId requis" });
  const providerId = parseProviderQuery(req.query["provider"]);
  if (!providerId) return res.status(400).json({ error: "provider requis (1, 3, 4 ou 5)" });
  const result = await syncOrderInternal({ externalId, providerId });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({
    status: result.status,
    previous_status: result.previous_status,
    refunded: result.refunded,
    refunded_amount: result.refunded_amount,
    user_id: result.user_id,
    provider: result.provider,
  });
});

router.post("/admin/orders/:externalId/refund", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const externalId = String(req.params["externalId"] || "");
  if (!externalId) return res.status(400).json({ error: "externalId requis" });
  const providerId = parseProviderQuery(req.query["provider"]);
  if (!providerId) return res.status(400).json({ error: "provider requis (1, 3, 4 ou 5)" });
  const result = await syncOrderInternal({ externalId, providerId, forceRefund: true });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({
    status: result.status,
    previous_status: result.previous_status,
    refunded: result.refunded,
    refunded_amount: result.refunded_amount,
    user_id: result.user_id,
    provider: result.provider,
  });
});

// Admin cancel: asks the SMM provider to cancel the order, then forces a
// local refund + status flip regardless of the provider response. This
// makes the user whole instantly even if the provider has already pushed
// the order beyond the cancellable point — the provider error (if any) is
// surfaced back to the admin so they know the actual upstream outcome.
router.post("/admin/orders/:externalId/cancel", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const externalId = String(req.params["externalId"] || "");
  if (!externalId) return res.status(400).json({ error: "externalId requis" });
  const providerId = parseProviderQuery(req.query["provider"]);
  if (!providerId) return res.status(400).json({ error: "provider requis (1, 3, 4 ou 5)" });

  let providerCancel: { ok: boolean; raw?: unknown; error?: string } = { ok: true };
  try {
    const raw = await callProvider(providerId, "cancel", { orders: externalId });
    if (raw && typeof raw === "object" && "error" in (raw as Record<string, unknown>) && (raw as { error: unknown }).error) {
      providerCancel = { ok: false, raw, error: String((raw as { error: unknown }).error) };
    } else if (Array.isArray(raw) && raw.length > 0 && (raw[0] as { error?: unknown }).error) {
      providerCancel = { ok: false, raw, error: String((raw[0] as { error: unknown }).error) };
    } else {
      providerCancel = { ok: true, raw };
    }
  } catch (err) {
    providerCancel = { ok: false, error: (err as Error).message };
  }

  const result = await syncOrderInternal({ externalId, providerId, forceRefund: true });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, provider_cancel: providerCancel });
  }
  return res.json({
    status: result.status,
    previous_status: result.previous_status,
    refunded: result.refunded,
    refunded_amount: result.refunded_amount,
    user_id: result.user_id,
    provider: result.provider,
    provider_cancel: providerCancel,
  });
});

// PK-based admin refund — unambiguous, no need to know the provider.
router.post("/admin/orders/by-id/:id/refund", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  const id = String(req.params["id"] || "");
  if (!id) return res.status(400).json({ error: "id requis" });
  const result = await syncOrderInternal({ localOrderId: id, forceRefund: true });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({
    status: result.status,
    previous_status: result.previous_status,
    refunded: result.refunded,
    refunded_amount: result.refunded_amount,
    user_id: result.user_id,
    provider: result.provider,
  });
});

// Cache invalidation helper (specific provider, or all when omitted).
// Clears both the raw upstream cache and the enriched-response cache.
export function invalidateServicesCache(providerId?: number): void {
  if (typeof providerId === "number") {
    svcCache.delete(providerId);
    enrichedCache.delete(providerId);
  } else {
    svcCache.clear();
    enrichedCache.clear();
  }
}

// Re-exports so other modules don't need to know about the providers module.
export { ALL_PROVIDER_IDS };

export default router;
