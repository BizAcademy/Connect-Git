// Background poller: every minute, scan recent non-final orders and ask
// the SMM provider for their up-to-date status. Orders whose status actually
// changed (or that are eligible for an automatic refund) are then handed to
// `syncFn` (the heavy syncOrderInternal path) which performs the DB update,
// idempotent refund and earnings reconciliation.
//
// Optimisation: instead of calling the provider once per pending order, we
// group orders by provider and use the multi-order status endpoint
// (`action=status&orders=1,2,3` — up to 100 ids per call). On a quiet system
// this collapses N HTTP calls per minute into 1 per active provider, making
// the "near real-time" sync feel much closer to instant without hammering the
// provider API.

import { logger } from "./logger";
import { callProvider, ALL_PROVIDER_IDS, type ProviderId } from "./smm-providers";
import { mapProviderStatus, FINAL_REFUND_STATUSES } from "./smm-status";

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const SMM_API_KEY = process.env["SMM_PANEL_API_KEY"];
const SMM_API_URL = process.env["SMM_PANEL_API_URL"];

const POLL_INTERVAL_MS = 60_000;
const WINDOW_DAYS = 30;
const BATCH_LIMIT = 100;
// Provider-side cap for `action=status&orders=...`. Documented as 100 by
// the major panels (JAP, Peakerr). Stay one below to leave headroom.
const PROVIDER_STATUS_BATCH = 100;
const SYNC_CONCURRENCY = 4;

const FINAL_STATUSES = [
  "completed", "canceled", "cancelled", "refunded", "failed",
];

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let started = false;
let tickInFlight = false;

export type PollerProviderId = ProviderId;

interface OrderRow {
  id: string;
  external_order_id: string;
  status: string;
  user_id: string;
  provider: number | null;
}

async function fetchPendingOrders(): Promise<OrderRow[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
  const notIn = `(${FINAL_STATUSES.map(s => `"${s}"`).join(",")})`;
  const url =
    `${SUPABASE_URL}/rest/v1/orders` +
    `?select=id,external_order_id,status,user_id,provider` +
    `&external_order_id=not.is.null` +
    `&status=not.in.${encodeURIComponent(notIn)}` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc` +
    `&limit=${BATCH_LIMIT}`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    logger.warn({ status: r.status, body: body.slice(0, 200) }, "order-poller: fetch failed");
    return [];
  }
  return (await r.json()) as OrderRow[];
}

export type PollerSyncFn = (
  externalId: string,
  providerId: PollerProviderId,
) => Promise<{ ok: boolean; status?: string; refunded?: boolean }>;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetches the upstream status for many orders at once using the provider's
 * multi-order endpoint. Returns a Map keyed by external order id (as string)
 * containing the raw provider status string. Orders the provider does not
 * recognise are silently omitted from the map; the caller falls back to a
 * single-order sync which surfaces the error properly.
 */
async function batchProviderStatuses(
  providerId: PollerProviderId,
  externalIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (externalIds.length === 0) return out;
  for (const ids of chunk(externalIds, PROVIDER_STATUS_BATCH)) {
    let resp: any;
    try {
      resp = await callProvider(providerId, "status", { orders: ids.join(",") });
    } catch (err) {
      logger.warn({ err, providerId, count: ids.length }, "order-poller: batch status call failed");
      continue;
    }
    // Two documented response shapes:
    //   - keyed-object: { "23501": { status, charge, ... }, "10": { error } }
    //   - array variant some panels return:
    //       [ { order: 23501, status: "..." }, ... ]
    if (Array.isArray(resp)) {
      for (const row of resp) {
        const id = row?.order != null ? String(row.order) : null;
        if (!id || row?.error) continue;
        const s = row.status;
        if (typeof s === "string" && s.length > 0) out.set(id, s);
      }
    } else if (resp && typeof resp === "object") {
      for (const [id, body] of Object.entries(resp as Record<string, any>)) {
        if (!body || body.error) continue;
        const s = (body as any).status;
        if (typeof s === "string" && s.length > 0) out.set(String(id), s);
      }
    }
  }
  return out;
}

async function tickOnce(syncFn: PollerSyncFn) {
  const orders = await fetchPendingOrders();
  if (orders.length === 0) {
    logger.debug("order-poller: no non-final orders to sync");
    return;
  }
  const byProvider = new Map<PollerProviderId, OrderRow[]>();
  for (const o of orders) {
    const pid: PollerProviderId =
      o.provider === 2 || o.provider === 3 || o.provider === 4 || o.provider === 5
        ? (o.provider as PollerProviderId)
        : 1;
    const list = byProvider.get(pid) ?? [];
    list.push(o);
    byProvider.set(pid, list);
  }

  // Step 1 — collect upstream statuses with one batched call per provider.
  // Step 2 — narrow down to the orders that *actually* need a heavy sync
  //          (status changed, OR mapped status is final-refund-eligible so
  //          a previously failed refund can retry).
  const toSync: { order: OrderRow; providerId: PollerProviderId }[] = [];
  let skippedUnchanged = 0;
  for (const [pid, list] of byProvider.entries()) {
    const ids = list.map((o) => o.external_order_id);
    const statuses = await batchProviderStatuses(pid, ids);
    for (const o of list) {
      const raw = statuses.get(o.external_order_id);
      if (!raw) {
        // Provider didn't recognise this order in the batch (or the batch
        // call itself failed) — fall back to per-order sync so the error
        // path is logged properly.
        toSync.push({ order: o, providerId: pid });
        continue;
      }
      const mapped = mapProviderStatus(raw);
      if (mapped !== o.status || FINAL_REFUND_STATUSES.has(mapped)) {
        toSync.push({ order: o, providerId: pid });
      } else {
        skippedUnchanged++;
      }
    }
  }

  let updated = 0;
  let refunded = 0;
  let errored = 0;
  for (const slice of chunk(toSync, SYNC_CONCURRENCY)) {
    await Promise.all(slice.map(async ({ order, providerId }) => {
      try {
        const res = await syncFn(order.external_order_id, providerId);
        if (!res.ok) { errored++; return; }
        if (res.status && res.status !== order.status) updated++;
        if (res.refunded) refunded++;
      } catch (err) {
        errored++;
        logger.debug({ err, externalId: order.external_order_id }, "order-poller: sync threw");
      }
    }));
  }
  logger.info(
    {
      checked: orders.length,
      providers_polled: byProvider.size,
      synced: toSync.length,
      skipped_unchanged: skippedUnchanged,
      updated,
      refunded,
      errored,
    },
    "order-poller: tick done",
  );
}

/**
 * Start the background poller. Safe to call once at boot. No-op when the
 * required secrets are missing (the poller logs a warning and stays idle).
 */
export function startOrderStatusPoller(syncFn: PollerSyncFn): void {
  // Strict idempotence: the `started` flag is flipped synchronously, before
  // the boot timeout fires, so concurrent callers cannot create a second
  // interval while we are still waiting for the first tick.
  if (started) return;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logger.warn("order-poller: SUPABASE_URL/SERVICE_ROLE_KEY missing — poller disabled");
    return;
  }
  if (!SMM_API_KEY || !SMM_API_URL) {
    logger.warn("order-poller: SMM_PANEL_API_KEY/URL missing — poller disabled");
    return;
  }
  // Touch ALL_PROVIDER_IDS so the import can't be tree-shaken, and so a
  // future contributor can extend per-provider behaviour easily.
  void ALL_PROVIDER_IDS;
  started = true;
  // In-flight guard: if a tick is still running when the next interval
  // fires (slow provider, large batch), skip the new tick instead of
  // piling up overlapping requests against the SMM provider.
  const safeTick = async () => {
    if (tickInFlight) {
      logger.debug("order-poller: previous tick still running — skipping");
      return;
    }
    tickInFlight = true;
    try {
      await tickOnce(syncFn);
    } catch (err) {
      logger.error({ err }, "order-poller: tick failed");
    } finally {
      tickInFlight = false;
    }
  };
  // Stagger the first tick a bit so it doesn't compete with boot work.
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void safeTick();
    timer = setInterval(() => { void safeTick(); }, POLL_INTERVAL_MS);
  }, 5_000);
  logger.info({ interval_ms: POLL_INTERVAL_MS, window_days: WINDOW_DAYS }, "order-poller: started");
}

export function stopOrderStatusPoller(): void {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}
