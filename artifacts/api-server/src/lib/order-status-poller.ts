import type { RowDataPacket } from "mysql2/promise";
import { logger } from "./logger";
import { getMysqlPool } from "./mysql";
import { callProvider, ALL_PROVIDER_IDS, type ProviderId } from "./smm-providers";
import { mapProviderStatus, FINAL_REFUND_STATUSES } from "./smm-status";

const POLL_INTERVAL_MS = 60_000, WINDOW_DAYS = 30, BATCH_LIMIT = 100, PROVIDER_STATUS_BATCH = 100, SYNC_CONCURRENCY = 4;
const FINAL_STATUSES = ["completed", "canceled", "cancelled", "refunded", "failed"];
let timer: NodeJS.Timeout | null = null, bootTimer: NodeJS.Timeout | null = null, started = false, tickInFlight = false;
export type PollerProviderId = ProviderId;
interface OrderRow { id: string; external_order_id: string; status: string; user_id: string; provider: number | null; }
const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function fetchPendingOrders(): Promise<OrderRow[]> {
  const marks = FINAL_STATUSES.map(() => "?").join(",");
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
    `SELECT id, COALESCE(provider_order_id, external_order_id) external_order_id, status, user_id, provider
       FROM orders WHERE COALESCE(provider_order_id, external_order_id) IS NOT NULL
       AND status NOT IN (${marks}) AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
       ORDER BY created_at DESC LIMIT ?`, [...FINAL_STATUSES, WINDOW_DAYS, BATCH_LIMIT],
  );
  return rows as OrderRow[];
}
export type PollerSyncFn = (externalId: string, providerId: PollerProviderId) => Promise<{ ok: boolean; status?: string; refunded?: boolean }>;
async function batchStatuses(pid: PollerProviderId, ids: string[]) {
  const out = new Map<string, string>();
  for (const part of chunk(ids, PROVIDER_STATUS_BATCH)) try {
    const response: any = await callProvider(pid, "status", { orders: part.join(",") });
    if (Array.isArray(response)) for (const row of response) if (row?.order != null && !row.error && typeof row.status === "string") out.set(String(row.order), row.status);
    else if (response && typeof response === "object") for (const [id, row] of Object.entries(response)) if (row && !(row as any).error && typeof (row as any).status === "string") out.set(id, (row as any).status);
  } catch (err) { logger.warn({ err, pid }, "order-poller: batch status failed"); }
  return out;
}
async function tickOnce(syncFn: PollerSyncFn) {
  const orders = await fetchPendingOrders(); if (!orders.length) return;
  const groups = new Map<PollerProviderId, OrderRow[]>();
  for (const order of orders) { const pid = ([1, 3, 4, 5].includes(Number(order.provider)) ? order.provider : 1) as PollerProviderId; groups.set(pid, [...(groups.get(pid) ?? []), order]); }
  const todo: Array<{ order: OrderRow; pid: PollerProviderId }> = [];
  for (const [pid, list] of groups) {
    const statuses = await batchStatuses(pid, list.map(o => o.external_order_id));
    for (const order of list) { const raw = statuses.get(order.external_order_id); if (!raw || mapProviderStatus(raw) !== order.status || FINAL_REFUND_STATUSES.has(mapProviderStatus(raw))) todo.push({ order, pid }); }
  }
  for (const part of chunk(todo, SYNC_CONCURRENCY)) await Promise.all(part.map(async ({ order, pid }) => { try { await syncFn(order.external_order_id, pid); } catch (err) { logger.debug({ err, order: order.id }, "order-poller: sync threw"); } }));
  logger.info({ checked: orders.length, synced: todo.length }, "order-poller: tick done");
}
export function startOrderStatusPoller(syncFn: PollerSyncFn): void {
  if (started) return;
  void ALL_PROVIDER_IDS;
  started = true;
  const safe = async () => { if (tickInFlight) return; tickInFlight = true; try { await tickOnce(syncFn); } catch (err) { logger.error({ err }, "order-poller: tick failed"); } finally { tickInFlight = false; } };
  bootTimer = setTimeout(() => { bootTimer = null; void safe(); timer = setInterval(() => void safe(), POLL_INTERVAL_MS); }, 5_000);
}
export function stopOrderStatusPoller(): void { if (bootTimer) clearTimeout(bootTimer); if (timer) clearInterval(timer); bootTimer = timer = null; started = false; }