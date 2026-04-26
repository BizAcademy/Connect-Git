// Background scanner: every 3 minutes, find payments stuck in "pending"
// status for more than 2 minutes and reconcile them against AfribaPay.
//
// This covers webhook delivery failures (signature mismatch, dev URL
// unreachable) and frontend polling timeouts.
//
// Flow for each pending payment:
//   1. Query AfribaPay /v1/status?order_id=...
//   2. SUCCESS  → creditDeposit (idempotent)
//   3. FAILED   → markPaymentStatus("failed")
//   4. Older than AUTO_FAIL_MINUTES with no terminal status → mark failed

import { logger } from "./logger";
import { creditDeposit, markPaymentStatus, fetchPayment } from "./deposits";
import { getStatus, isSuccessStatus, isFailureStatus, isAfribapayConfigured } from "./afribapay";

const SUPABASE_URL        = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SERVICE_ROLE_KEY    = process.env["SUPABASE_SERVICE_ROLE_KEY"];

const SCAN_INTERVAL_MS    = 3 * 60_000;  // every 3 minutes
const MIN_AGE_MS          = 2 * 60_000;  // skip payments younger than 2 min (still polling)
const AUTO_FAIL_MS        = 35 * 60_000; // mark failed after 35 min with no response
const PAGE_SIZE           = 50;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let started  = false;

function svcHeaders(): Record<string, string> {
  const key = SERVICE_ROLE_KEY!;
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

interface PendingPayment { id: string; user_id: string; order_id: string; created_at: string; amount: number }

async function fetchPendingPayments(): Promise<PendingPayment[]> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return [];
  const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();
  // Only fetch AfribaPay payments: order_id IS NOT NULL (old SoleasPay rows have no order_id)
  const url = `${SUPABASE_URL}/rest/v1/payments`
    + `?select=id,user_id,order_id,created_at,amount`
    + `&status=eq.pending`
    + `&credited_at=is.null`
    + `&order_id=not.is.null`
    + `&created_at=lt.${encodeURIComponent(cutoff)}`
    + `&order=created_at.asc`
    + `&limit=${PAGE_SIZE}`;
  try {
    const r = await fetch(url, { headers: svcHeaders() });
    if (!r.ok) return [];
    return (await r.json()) as PendingPayment[];
  } catch { return []; }
}

async function reconcileOne(p: PendingPayment): Promise<"credited" | "failed" | "skip" | "error"> {
  const ageMs = Date.now() - new Date(p.created_at).getTime();

  // Re-fetch to make sure it's still pending (another process may have credited it)
  const current = await fetchPayment(p.id);
  if (!current || current.status !== "pending" || current.credited_at) return "skip";

  // order_id is guaranteed non-null by the query filter — but guard defensively
  if (!p.order_id) return "skip";

  try {
    const remote = await getStatus(p.order_id);

    if (isSuccessStatus(remote.status)) {
      const result = await creditDeposit(p.id);
      if (result.ok) {
        logger.info(
          { paymentId: p.id, orderId: p.order_id, amount: p.amount, alreadyCredited: result.alreadyCredited },
          "pending-payment-scanner: payment credited",
        );
        return "credited";
      }
      logger.error({ paymentId: p.id, err: result.error }, "pending-payment-scanner: creditDeposit failed");
      return "error";
    }

    if (isFailureStatus(remote.status)) {
      await markPaymentStatus(p.id, "failed");
      logger.info({ paymentId: p.id, orderId: p.order_id, status: remote.status }, "pending-payment-scanner: payment marked failed");
      return "failed";
    }

    // Still pending from AfribaPay — auto-fail if too old
    if (ageMs > AUTO_FAIL_MS) {
      await markPaymentStatus(p.id, "failed");
      logger.warn({ paymentId: p.id, orderId: p.order_id, ageMin: Math.round(ageMs / 60000) }, "pending-payment-scanner: auto-failed stale payment");
      return "failed";
    }

    return "skip";
  } catch (err: any) {
    // 429 with data.status=SUCCESS is handled inside getStatus already.
    // Anything else: leave pending for next scan.
    logger.warn({ paymentId: p.id, orderId: p.order_id, err: err?.message }, "pending-payment-scanner: getStatus error — will retry");
    return "error";
  }
}

async function scanOnce(): Promise<void> {
  if (!isAfribapayConfigured()) return;
  const pending = await fetchPendingPayments();
  if (pending.length === 0) return;

  logger.info({ count: pending.length }, "pending-payment-scanner: checking pending payments");

  let credited = 0, failed = 0, skipped = 0, errors = 0;
  for (let i = 0; i < pending.length; i++) {
    // Space out calls to avoid AfribaPay rate limits (max 6/min → 1 call/12s)
    if (i > 0) await new Promise((r) => setTimeout(r, 12_000));
    const result = await reconcileOne(pending[i]!);
    if (result === "credited") credited++;
    else if (result === "failed") failed++;
    else if (result === "skip")   skipped++;
    else                          errors++;
  }

  logger.info({ credited, failed, skipped, errors }, "pending-payment-scanner: scan complete");
}

export function startPendingPaymentScanner(): void {
  if (started) return;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    logger.warn("pending-payment-scanner: Supabase secrets missing — scanner disabled");
    return;
  }
  started = true;

  const safeScan = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await scanOnce(); }
    catch (err) { logger.error({ err }, "pending-payment-scanner: scan threw"); }
    finally { inFlight = false; }
  };

  // First scan: 30 s after boot
  setTimeout(() => { void safeScan(); }, 30_000);
  timer = setInterval(() => { void safeScan(); }, SCAN_INTERVAL_MS);
  logger.info({ interval_ms: SCAN_INTERVAL_MS }, "pending-payment-scanner: started");
}

export function stopPendingPaymentScanner(): void {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}
