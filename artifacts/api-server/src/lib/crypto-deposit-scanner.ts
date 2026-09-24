import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";
import { reconcileCryptoPayment } from "./izipay";
import { logger } from "./logger";

type ScanKind = "pending" | "terminal";
type Candidate = { id: string };

const BATCH_SIZE = 20;
const SCAN_INTERVAL_MS = 2 * 60_000;
let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let running = false;
let cycle = 0;
let pendingCursor: string | null = null;
let terminalCursor: string | null = null;

async function listCandidates(kind: ScanKind, afterId: string): Promise<Candidate[]> {
  const statuses = kind === "pending"
    ? "status='pending'"
    : "status IN ('irregular','failed','expired','canceled','cancelled','completed')";
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
    `SELECT id FROM payments
     WHERE provider='izipay' AND provider_reference IS NOT NULL AND credited_at IS NULL
       AND ${statuses} AND id > ?
     ORDER BY id LIMIT ?`,
    [afterId, BATCH_SIZE],
  );
  return rows.map(row => ({ id: String(row.id) }));
}

async function warnAboutPendingBacklog(): Promise<void> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS total, MIN(created_at) AS oldest FROM payments WHERE provider='izipay' AND provider_reference IS NOT NULL AND credited_at IS NULL AND status='pending'",
  );
  const total = Number(rows[0]?.total ?? 0);
  const oldest = rows[0]?.oldest == null ? null : new Date(rows[0].oldest).getTime();
  if (total > BATCH_SIZE || (oldest != null && oldest < Date.now() - 24 * 60 * 60_000)) {
    logger.warn({ total, oldest: rows[0]?.oldest }, "crypto-deposit-scanner: uncredited pending payment backlog");
  }
}

// The cursor rotates through all uncredited intents, including those still
// pending after an outage. Never acknowledge a delivery on the assumption
// that a detached in-memory job will finish: this scan is the durable fallback.
export async function scanCryptoDepositsOnce(
  kind: ScanKind,
  afterId: string | null,
  list: (kind: ScanKind, afterId: string) => Promise<Candidate[]> = listCandidates,
  reconcile: (id: string) => Promise<string> = reconcileCryptoPayment,
): Promise<{ nextId: string | null; checked: number; errors: number }> {
  let candidates = await list(kind, afterId ?? "");
  if (candidates.length === 0 && afterId) candidates = await list(kind, "");

  let errors = 0;
  for (const candidate of candidates) {
    try {
      const status = await reconcile(candidate.id);
      if (status === "completed") logger.info({ paymentId: candidate.id }, "crypto-deposit-scanner: credited payment");
    } catch (err) {
      errors++;
      logger.error({ err, paymentId: candidate.id }, "crypto-deposit-scanner: will retry payment");
    }
  }
  return { nextId: candidates.at(-1)?.id ?? null, checked: candidates.length, errors };
}

export function startCryptoDepositScanner(): void {
  if (timer) return;
  const scan = async () => {
    if (running || !process.env["IZIPAY_API_KEY"]) return;
    running = true;
    try {
      const pending = await scanCryptoDepositsOnce("pending", pendingCursor);
      pendingCursor = pending.nextId;
      // Previously terminal or irregular intents can be manually settled later.
      // Check them less often to avoid repeated provider API traffic.
      if (++cycle % 15 === 0) {
        const terminal = await scanCryptoDepositsOnce("terminal", terminalCursor);
        terminalCursor = terminal.nextId;
        await warnAboutPendingBacklog();
      }
    } catch (err) {
      logger.error({ err }, "crypto-deposit-scanner: scan failed; will retry");
    } finally {
      running = false;
    }
  };
  initialTimer = setTimeout(() => { void scan(); }, 15_000);
  timer = setInterval(() => { void scan(); }, SCAN_INTERVAL_MS);
  logger.info({ interval_ms: SCAN_INTERVAL_MS }, "crypto-deposit-scanner: started");
}

export function stopCryptoDepositScanner(): void {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
}