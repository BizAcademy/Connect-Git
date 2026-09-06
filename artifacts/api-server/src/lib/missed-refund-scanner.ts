import type { RowDataPacket } from "mysql2/promise";
import { logger } from "./logger";
import { getMysqlPool } from "./mysql";
import { refundOrderAtomic } from "../routes/smm";

const SCAN_INTERVAL_MS = 5 * 60_000;
const WINDOW_DAYS = 90;
const PAGE_SIZE = 200;
let timer: NodeJS.Timeout | null = null;
let scanInFlight = false;
let started = false;

async function scanOnce(): Promise<void> {
  const [orders] = await getMysqlPool().execute<RowDataPacket[]>(
    `SELECT id FROM orders WHERE status IN ('canceled','cancelled','failed','refunded')
       AND refunded_at IS NULL AND charge_minor > 0
       AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
     ORDER BY created_at DESC LIMIT ?`,
    [WINDOW_DAYS, PAGE_SIZE],
  );
  let refunded = 0;
  for (const order of orders) {
    const result = await refundOrderAtomic(String(order.id));
    if (result.refunded) refunded++;
  }
  if (orders.length) logger.info({ total: orders.length, refunded }, "missed-refund-scanner: scan complete");
}

export function startMissedRefundScanner(): void {
  if (started) return;
  started = true;
  const safeScan = async () => {
    if (scanInFlight) return;
    scanInFlight = true;
    try { await scanOnce(); } catch (err) { logger.error({ err }, "missed-refund-scanner: scan threw"); }
    finally { scanInFlight = false; }
  };
  setTimeout(() => { void safeScan(); }, 10_000);
  timer = setInterval(() => { void safeScan(); }, SCAN_INTERVAL_MS);
  logger.info({ interval_ms: SCAN_INTERVAL_MS, window_days: WINDOW_DAYS }, "missed-refund-scanner: started");
}

export function stopMissedRefundScanner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}