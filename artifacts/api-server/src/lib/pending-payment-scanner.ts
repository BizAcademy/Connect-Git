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
import { recoverStuckReferrals } from "./referrals";
import { getStatus, isSuccessStatus, isFailureStatus, isAfribapayConfigured } from "./afribapay";
import { getMysqlPool } from "./mysql";
import type { RowDataPacket } from "mysql2/promise";

const SCAN_INTERVAL_MS    = 3 * 60_000;  // every 3 minutes
const MIN_AGE_MS          = 2 * 60_000;  // skip payments younger than 2 min (still polling)
const AUTO_FAIL_MS        = 35 * 60_000; // mark failed after 35 min still pending on AfribaPay
// Payments older than this are auto-failed WITHOUT any AfribaPay API call.
// This prevents stale/sandbox-era payments from flooding the token endpoint.
const DEFINITIVE_FAIL_MS  = 2 * 60 * 60_000; // 2 hours — definitively stale
const PAGE_SIZE           = 50;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let started  = false;

interface PendingPayment { id: string; user_id: string; order_id: string; created_at: string; amount: number }

async function fetchPendingPayments(): Promise<PendingPayment[]> {
  try {
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
      `SELECT id,user_id,order_id,created_at,amount_minor FROM payments
       WHERE status='pending' AND credited_at IS NULL AND order_id IS NOT NULL
       AND created_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE) ORDER BY created_at ASC LIMIT ?`, [PAGE_SIZE],
    );
    return rows.map(r => ({ id: String(r.id), user_id: String(r.user_id), order_id: String(r.order_id),
      created_at: new Date(r.created_at).toISOString(), amount: Number(r.amount_minor) / 100 }));
  } catch { return []; }
}

async function reconcileOne(p: PendingPayment): Promise<"credited" | "failed" | "skip" | "error"> {
  const ageMs = Date.now() - new Date(p.created_at).getTime();

  // Definitively auto-fail payments older than DEFINITIVE_FAIL_MS WITHOUT calling
  // AfribaPay at all. These are either sandbox-era or permanently lost payments.
  // Skipping the API call prevents stale payments from flooding the token endpoint.
  if (ageMs > DEFINITIVE_FAIL_MS) {
    await markPaymentStatus(p.id, "failed");
    logger.warn(
      { paymentId: p.id, orderId: p.order_id, ageMin: Math.round(ageMs / 60000) },
      "pending-payment-scanner: definitively auto-failed stale payment (no AfribaPay call)",
    );
    return "failed";
  }

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
  started = true;

  const safeScan = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await scanOnce(); }
    catch (err) { logger.error({ err }, "pending-payment-scanner: scan threw"); }
    finally { inFlight = false; }
    // Reprise des bonus de parrainage interrompus (referrals bloqués en
    // processing). Indépendant d'AfribaPay — tourne aussi sans ses clés.
    try { await recoverStuckReferrals(10); }
    catch (err) { logger.error({ err }, "referral recovery threw"); }
  };

  // First scan: 5 min after boot (avoids token rate-limit pressure right after restart)
  setTimeout(() => { void safeScan(); }, 5 * 60_000);
  timer = setInterval(() => { void safeScan(); }, SCAN_INTERVAL_MS);
  logger.info({ interval_ms: SCAN_INTERVAL_MS }, "pending-payment-scanner: started");
}

export function stopPendingPaymentScanner(): void {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}
