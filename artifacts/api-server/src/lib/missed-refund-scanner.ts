// Background scanner: every 5 minutes, look for orders in a final negative
// status (canceled, cancelled, failed, refunded) that have NOT been credited
// back yet (refunded_at IS NULL) and trigger the atomic smm_refund_order RPC
// for each one.
//
// This covers two failure modes:
//   1. Orders cancelled by the SMM provider before the auto-refund poller was
//      in place or while the API server was down.
//   2. Admin status changes that silently bypassed the refund path.
//
// The RPC is idempotent — running it twice on the same order is a no-op.

import { logger } from "./logger";

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

const SCAN_INTERVAL_MS = 5 * 60_000; // every 5 minutes
const WINDOW_DAYS = 90;              // look back 90 days
const PAGE_SIZE = 200;               // orders per scan

let timer: NodeJS.Timeout | null = null;
let scanInFlight = false;
let started = false;

function serviceRoleHeaders(): Record<string, string> {
  const key = SUPABASE_SERVICE_ROLE_KEY!;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

interface UnrefundedOrder {
  id: string;
  user_id: string;
  price: number;
  status: string;
  external_order_id: string | null;
}

async function fetchUnrefundedOrders(): Promise<UnrefundedOrder[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const finalNegative = encodeURIComponent('("canceled","cancelled","failed","refunded")');
  const url =
    `${SUPABASE_URL}/rest/v1/orders` +
    `?select=id,user_id,price,status,external_order_id` +
    `&status=in.${finalNegative}` +
    `&refunded_at=is.null` +
    `&price=gt.0` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc` +
    `&limit=${PAGE_SIZE}`;
  try {
    const r = await fetch(url, { headers: serviceRoleHeaders() });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.warn({ status: r.status, body: body.slice(0, 200) }, "missed-refund-scanner: fetch failed");
      return [];
    }
    return (await r.json()) as UnrefundedOrder[];
  } catch (err) {
    logger.warn({ err }, "missed-refund-scanner: fetch threw");
    return [];
  }
}

async function applyRefund(order: UnrefundedOrder): Promise<boolean> {
  const amount = Math.round(Number(order.price));
  if (amount <= 0) return false;
  try {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/smm_refund_order`, {
      method: "POST",
      headers: serviceRoleHeaders(),
      body: JSON.stringify({ p_order_id: order.id, p_amount: amount }),
    });
    if (!rpcRes.ok) {
      const txt = await rpcRes.text().catch(() => "");
      logger.error(
        { status: rpcRes.status, body: txt.slice(0, 300), orderId: order.id, userId: order.user_id, amount },
        "missed-refund-scanner: RPC failed",
      );
      return false;
    }
    const rows = (await rpcRes.json().catch(() => null)) as
      | Array<{ refunded: boolean; refunded_amount: number; new_balance: number }>
      | null;
    const row = rows && rows[0];
    if (row?.refunded) {
      logger.info(
        { orderId: order.id, userId: order.user_id, amount, newBalance: row.new_balance, status: order.status },
        "missed-refund-scanner: retroactive refund credited",
      );
      return true;
    }
    // Already refunded (idempotent no-op from the RPC) — not an error.
    return false;
  } catch (err) {
    logger.warn({ err, orderId: order.id }, "missed-refund-scanner: RPC threw");
    return false;
  }
}

async function scanOnce(): Promise<void> {
  const orders = await fetchUnrefundedOrders();
  if (orders.length === 0) return;

  logger.info({ count: orders.length }, "missed-refund-scanner: found orders to refund");

  let refunded = 0;
  let failed = 0;
  for (const order of orders) {
    const ok = await applyRefund(order);
    if (ok) refunded++; else failed++;
  }

  logger.info(
    { total: orders.length, refunded, failed },
    "missed-refund-scanner: scan complete",
  );
}

export function startMissedRefundScanner(): void {
  if (started) return;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logger.warn("missed-refund-scanner: Supabase secrets missing — scanner disabled");
    return;
  }
  started = true;

  const safeScan = async () => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      await scanOnce();
    } catch (err) {
      logger.error({ err }, "missed-refund-scanner: scan threw");
    } finally {
      scanInFlight = false;
    }
  };

  // First scan runs 10 s after boot so it doesn't compete with startup work.
  setTimeout(() => { void safeScan(); }, 10_000);
  timer = setInterval(() => { void safeScan(); }, SCAN_INTERVAL_MS);
  logger.info({ interval_ms: SCAN_INTERVAL_MS, window_days: WINDOW_DAYS }, "missed-refund-scanner: started");
}

export function stopMissedRefundScanner(): void {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}
