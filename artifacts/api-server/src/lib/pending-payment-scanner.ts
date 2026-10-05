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
import {
  creditDeposit,
  markPaymentStatus,
  fetchPayment,
  recordAfribapayProviderFees,
} from "./deposits";
import { recoverStuckReferrals } from "./referrals";
import {
  getStatus,
  isSuccessStatus,
  isFailureStatus,
  isAfribapayConfigured,
  AfribapayApiError,
  type StatusLookupBy,
} from "./afribapay";
import { getMysqlPool } from "./mysql";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { feeReconciliationRetryAfterSeconds } from "./afribapay-fees";

const SCAN_INTERVAL_MS    = 3 * 60_000;  // every 3 minutes
const MIN_AGE_MS          = 2 * 60_000;  // skip payments younger than 2 min (still polling)
const AUTO_FAIL_MS        = 35 * 60_000; // mark failed after 35 min still pending on AfribaPay
// Payments older than this are auto-failed WITHOUT any AfribaPay API call.
// This prevents stale/sandbox-era payments from flooding the token endpoint.
const DEFINITIVE_FAIL_MS  = 2 * 60 * 60_000; // 2 hours — definitively stale
const PAGE_SIZE           = 50;
const MAX_COMPLETED_FEE_LOOKUPS_PER_SCAN = 6;
const PROVIDER_STATUS_INTERVAL_MS = 12_000;
const FEE_LOOKUP_CLAIM_SECONDS = 15 * 60;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let started  = false;
let lastProviderStatusRequestAt = 0;

interface PendingPayment { id: string; user_id: string; order_id: string; created_at: string; amount: number }
interface CompletedFeeCandidate extends RowDataPacket {
  payment_id: string;
  attempts: number;
  order_id: string | null;
  transaction_id: string | null;
}

async function waitForProviderStatusSlot(): Promise<void> {
  const waitMs = lastProviderStatusRequestAt + PROVIDER_STATUS_INTERVAL_MS - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastProviderStatusRequestAt = Date.now();
}

async function fetchPendingPayments(): Promise<PendingPayment[]> {
  try {
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
      `SELECT id,user_id,order_id,created_at,amount_minor FROM payments
       WHERE status='pending' AND credited_at IS NULL AND order_id IS NOT NULL
       AND (provider IS NULL OR provider <> 'izipay')
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
    await waitForProviderStatusSlot();
    const remote = await getStatus(p.order_id);
    try {
      await recordAfribapayProviderFees(p.id, remote.raw);
    } catch (err: any) {
      logger.error({ paymentId: p.id, err: err?.message }, "pending-payment-scanner: failed to persist AfribaPAY fees");
    }

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
  if (pending.length > 0) {
    logger.info({ count: pending.length }, "pending-payment-scanner: checking pending payments");

    let credited = 0, failed = 0, skipped = 0, errors = 0;
    for (const payment of pending) {
      const result = await reconcileOne(payment);
      if (result === "credited") credited++;
      else if (result === "failed") failed++;
      else if (result === "skip")   skipped++;
      else                          errors++;
    }

    logger.info({ credited, failed, skipped, errors }, "pending-payment-scanner: scan complete");
  }

  await reconcileCompletedFeeBatch();
}

async function queueCompletedPaymentsMissingFees(): Promise<void> {
  const pool = getMysqlPool();
  await pool.execute(
    `DELETE r
     FROM afribapay_fee_reconciliation AS r
     LEFT JOIN payments AS p ON p.id = r.payment_id
     WHERE p.id IS NULL
        OR p.status <> 'completed'
        OR p.provider_fee_total_minor IS NOT NULL
        OR NOT (
          COALESCE(p.provider, '') = 'afribapay'
          OR COALESCE(p.method, '') = 'afribapay'
        )`,
  );
  await pool.execute(
    `INSERT IGNORE INTO afribapay_fee_reconciliation (payment_id, next_attempt_at)
     SELECT p.id, NOW()
     FROM payments AS p
     WHERE p.status = 'completed'
       AND (p.provider = 'afribapay' OR p.method = 'afribapay')
       AND p.provider_fee_total_minor IS NULL
       AND (
         NULLIF(TRIM(p.order_id), '') IS NOT NULL
         OR NULLIF(TRIM(p.transaction_id), '') IS NOT NULL
       )`,
  );
}

async function fetchDueCompletedFeeCandidates(): Promise<CompletedFeeCandidate[]> {
  const [rows] = await getMysqlPool().execute<CompletedFeeCandidate[]>(
    `SELECT r.payment_id, r.attempts, p.order_id, p.transaction_id
     FROM afribapay_fee_reconciliation AS r
     INNER JOIN payments AS p ON p.id = r.payment_id
     WHERE r.next_attempt_at <= NOW()
       AND p.status = 'completed'
       AND (p.provider = 'afribapay' OR p.method = 'afribapay')
       AND p.provider_fee_total_minor IS NULL
     ORDER BY r.next_attempt_at ASC, COALESCE(p.completed_at, p.created_at) ASC
     LIMIT ?`,
    [MAX_COMPLETED_FEE_LOOKUPS_PER_SCAN],
  );
  return rows;
}

async function claimCompletedFeeCandidate(paymentId: string): Promise<boolean> {
  const [result] = await getMysqlPool().execute<ResultSetHeader>(
    `UPDATE afribapay_fee_reconciliation
     SET attempts = attempts + 1,
         last_attempt_at = NOW(),
         next_attempt_at = TIMESTAMPADD(SECOND, ?, NOW()),
         last_result = 'checking'
     WHERE payment_id = ? AND next_attempt_at <= NOW()`,
    [FEE_LOOKUP_CLAIM_SECONDS, paymentId],
  );
  return result.affectedRows === 1;
}

async function finishCompletedFeeCandidate(
  paymentId: string,
  outcome: "missing" | "error",
  result: string,
  attemptCount: number,
): Promise<void> {
  const delaySeconds = feeReconciliationRetryAfterSeconds(attemptCount, outcome);
  await getMysqlPool().execute(
    `UPDATE afribapay_fee_reconciliation
     SET next_attempt_at = TIMESTAMPADD(SECOND, ?, NOW()),
         last_result = ?
     WHERE payment_id = ?`,
    [delaySeconds, result, paymentId],
  );
}

async function reconcileCompletedFeeBatch(): Promise<void> {
  await queueCompletedPaymentsMissingFees();
  const candidates = await fetchDueCompletedFeeCandidates();
  let attempted = 0;
  let enriched = 0;
  let missing = 0;
  let errors = 0;

  for (const candidate of candidates) {
    if (!await claimCompletedFeeCandidate(candidate.payment_id)) continue;
    attempted++;
    const orderId = candidate.order_id?.trim() ?? "";
    const transactionId = candidate.transaction_id?.trim() ?? "";
    const lookupBy: StatusLookupBy = orderId ? "order_id" : "transaction_id";
    const identifier = orderId || transactionId;
    const attemptCount = Number(candidate.attempts) + 1;

    try {
      await waitForProviderStatusSlot();
      const remote = await getStatus(identifier, lookupBy);
      if (!isSuccessStatus(remote.status)) {
        await finishCompletedFeeCandidate(
          candidate.payment_id,
          "missing",
          "provider_status_not_success",
          attemptCount,
        );
        missing++;
        continue;
      }

      const completeFeeData = await recordAfribapayProviderFees(candidate.payment_id, remote.raw);
      if (completeFeeData) {
        await getMysqlPool().execute(
          "DELETE FROM afribapay_fee_reconciliation WHERE payment_id = ?",
          [candidate.payment_id],
        );
        enriched++;
      } else {
        await finishCompletedFeeCandidate(
          candidate.payment_id,
          "missing",
          "provider_fees_not_returned",
          attemptCount,
        );
        missing++;
      }
    } catch (err) {
      const providerStatus = err instanceof AfribapayApiError ? err.status : null;
      await finishCompletedFeeCandidate(
        candidate.payment_id,
        "error",
        providerStatus === 429 ? "provider_rate_limited" : "provider_lookup_failed",
        attemptCount,
      );
      logger.warn(
        { provider_status: providerStatus },
        "completed AfribaPAY fee lookup failed; scheduled a retry",
      );
      errors++;
    }
  }

  if (attempted > 0) {
    logger.info(
      { attempted, enriched, missing, errors },
      "completed AfribaPAY fee reconciliation batch finished",
    );
  }
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
