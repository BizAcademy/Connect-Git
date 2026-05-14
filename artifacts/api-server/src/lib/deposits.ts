import { logger } from "./logger";
import { toFcfa } from "./currency";

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] || process.env["VITE_SUPABASE_ANON_KEY"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

// --- Bonus business rules -------------------------------------------------

/** Minimum deposit (FCFA) to qualify for a bonus. */
export const BONUS_THRESHOLD_FCFA = 5000;
/** Bonus amount (FCFA) granted when the deposit qualifies. */
export const BONUS_AMOUNT_FCFA = 200;

export function isEligibleForBonus(amount: number): boolean {
  return Number.isFinite(amount) && amount >= BONUS_THRESHOLD_FCFA;
}

// --- Helpers --------------------------------------------------------------

export interface PaymentRow {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  reference: string | null;
  method: string;
  created_at: string;
  order_id?: string | null;
  transaction_id?: string | null;
  bonus_amount?: number | null;
  bonus_status?: string | null;
  bonus_credited_at?: string | null;
  credited_at?: string | null;
}

/**
 * Headers for write operations. Uses the service-role key when available
 * (the only safe option for the public webhook), or falls back to the
 * provided user token (admin path through RLS).
 */
function writeHeaders(userToken?: string) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY!;
  return {
    apikey: key,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY ? key : (userToken || key)}`,
    "Content-Type": "application/json",
  };
}

function readHeaders(userToken?: string) {
  // For reads, prefer service role (bypasses RLS) when available, else use user token.
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY!;
  return {
    apikey: key,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY ? key : (userToken || key)}`,
  };
}

export function hasServiceRoleKey(): boolean {
  return Boolean(SUPABASE_SERVICE_ROLE_KEY);
}

export async function fetchPayment(paymentId: string, userToken?: string): Promise<PaymentRow | null> {
  if (!SUPABASE_URL) return null;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}&select=*`,
    { headers: readHeaders(userToken) },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as PaymentRow[];
  return rows[0] || null;
}

async function getBalance(userId: string, userToken?: string): Promise<number | null> {
  if (!SUPABASE_URL) return null;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=balance`,
    { headers: readHeaders(userToken) },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as { balance: number }[];
  if (!rows[0]) return null;
  return Number(rows[0].balance);
}

/**
 * Atomically increment a user's balance by `amount` using optimistic CAS.
 * Retries on concurrent updates. Returns the new balance, or null on failure.
 */
async function creditBalance(userId: string, amount: number, userToken?: string): Promise<number | null> {
  if (!SUPABASE_URL || amount <= 0) return null;
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await getBalance(userId, userToken);
    if (current === null) {
      logger.error({ userId }, "creditBalance: could not read balance");
      return null;
    }
    const next = current + amount;
    const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&balance=eq.${current}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { ...writeHeaders(userToken), Prefer: "return=representation" },
      body: JSON.stringify({ balance: next }),
    });
    if (!r.ok) {
      logger.error({ userId, attempt, status: r.status }, "creditBalance: PATCH failed");
      return null;
    }
    const rows = (await r.json()) as { balance: number }[];
    if (rows && rows.length > 0) return Number(rows[0].balance); // CAS succeeded
    await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  logger.error({ userId }, "creditBalance: exhausted CAS retries");
  return null;
}

export type CreditOutcome =
  | { ok: true; alreadyCredited: boolean; amountCredited: number; bonusCredited: number; newBalance: number | null; payment: PaymentRow }
  | { ok: false; error: string; status?: number };

/**
 * Centralized, idempotent deposit-credit operation.
 *
 * Marks the payment as `completed` and credits the user's balance with
 * `amount + bonus` (bonus = 200 FCFA if amount ≥ 5000).
 *
 * Idempotency is enforced at the database level by a CAS on
 * `credited_at IS NULL`: only the first concurrent caller wins the claim
 * and performs the actual balance increment. Subsequent calls return
 * `alreadyCredited: true` without modifying anything.
 *
 * The function works for both:
 *  - The AfribaPay webhook (no user token; requires SUPABASE_SERVICE_ROLE_KEY).
 *  - Admin manual status changes (uses the admin's userToken via RLS).
 */
/** Fetch the country stored on a user's profile (needed for currency conversion). */
async function fetchUserCountry(userId: string): Promise<string | null> {
  if (!SUPABASE_URL) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=country`,
      { headers: readHeaders() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as { country: string | null }[];
    return rows[0]?.country ?? null;
  } catch {
    return null;
  }
}

export async function creditDeposit(
  paymentId: string,
  opts?: { userToken?: string; forceBonusCredit?: boolean },
): Promise<CreditOutcome> {
  if (!SUPABASE_URL) return { ok: false, error: "Supabase non configuré", status: 503 };

  const userToken = opts?.userToken;
  const payment = await fetchPayment(paymentId, userToken);
  if (!payment) return { ok: false, error: "Paiement introuvable", status: 404 };

  // The amount stored in the payment row is in local currency (as sent to AfribaPay).
  // We must convert to FCFA before crediting the balance.
  const localAmount = Number(payment.amount);
  const userCountry = await fetchUserCountry(payment.user_id);
  const amount = toFcfa(localAmount, userCountry);
  if (amount !== localAmount) {
    logger.info(
      { paymentId, userId: payment.user_id, localAmount, fcfaAmount: amount, country: userCountry },
      "currency conversion applied for deposit",
    );
  }

  const eligible = isEligibleForBonus(amount);
  const bonus = eligible ? BONUS_AMOUNT_FCFA : 0;

  // --- Special path: payment is already completed but bonus was never given ---
  // (e.g. webhook fired before the migration was applied, or a network hiccup
  // caused the bonus credit to fail.) Allow admin to retry just the bonus.
  if (
    opts?.forceBonusCredit
    && payment.status === "completed"
    && eligible
    && payment.bonus_status !== "credited"
  ) {
    // Atomically claim the bonus credit via CAS on bonus_status.
    const claimUrl = `${SUPABASE_URL}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}&bonus_status=neq.credited`;
    const claim = await fetch(claimUrl, {
      method: "PATCH",
      headers: { ...writeHeaders(userToken), Prefer: "return=representation" },
      body: JSON.stringify({
        bonus_status: "credited",
        bonus_amount: BONUS_AMOUNT_FCFA,
        bonus_credited_at: new Date().toISOString(),
      }),
    });
    if (!claim.ok) {
      const body = await claim.text();
      logger.error({ paymentId, status: claim.status, body: body.slice(0, 200) }, "bonus claim PATCH failed");
      return { ok: false, error: "Impossible de réclamer le bonus", status: 502 };
    }
    const claimed = (await claim.json()) as PaymentRow[];
    if (claimed.length === 0) {
      // Already credited concurrently
      return { ok: true, alreadyCredited: true, amountCredited: 0, bonusCredited: 0, newBalance: null, payment };
    }
    const newBalance = await creditBalance(payment.user_id, BONUS_AMOUNT_FCFA, userToken);
    if (newBalance === null) {
      // Compensation: undo the bonus claim so a future retry can succeed.
      logger.error({ paymentId }, "bonus credit failed AFTER claim — rolling back claim");
      await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}`, {
        method: "PATCH",
        headers: writeHeaders(userToken),
        body: JSON.stringify({
          bonus_status: "pending",
          bonus_credited_at: null,
        }),
      }).catch((err) => logger.error({ err, paymentId }, "bonus claim rollback FAILED — manual reconciliation required"));
      return { ok: false, error: "Crédit du bonus échoué (réessayez)", status: 500 };
    }
    return { ok: true, alreadyCredited: false, amountCredited: 0, bonusCredited: BONUS_AMOUNT_FCFA, newBalance, payment: claimed[0] };
  }

  // --- Normal path: claim the deposit credit (status + balance + bonus together) ---
  // CAS on credited_at IS NULL ensures only the first caller wins.
  const claimUrl = `${SUPABASE_URL}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}&credited_at=is.null`;
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: "completed",
    credited_at: nowIso,
    bonus_amount: bonus,
    bonus_status: eligible ? "credited" : "not_eligible",
    bonus_credited_at: eligible ? nowIso : null,
  };
  const claim = await fetch(claimUrl, {
    method: "PATCH",
    headers: { ...writeHeaders(userToken), Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!claim.ok) {
    const body = await claim.text();
    logger.error({ paymentId, status: claim.status, body: body.slice(0, 200) }, "deposit claim PATCH failed");
    return { ok: false, error: "Impossible de marquer le dépôt comme crédité", status: 502 };
  }
  const claimed = (await claim.json()) as PaymentRow[];
  if (claimed.length === 0) {
    // Already credited (concurrent or replayed call). Idempotent no-op.
    return { ok: true, alreadyCredited: true, amountCredited: 0, bonusCredited: 0, newBalance: null, payment };
  }

  const total = amount + bonus;
  const newBalance = await creditBalance(payment.user_id, total, userToken);
  if (newBalance === null) {
    // Compensation: roll back the deposit claim so a retry (manual or
    // automatic) can re-attempt the credit. We restore the previous status
    // and clear the bonus markers so creditDeposit can run again.
    logger.error({ paymentId, userId: payment.user_id, total }, "creditDeposit: balance update FAILED after claim — rolling back claim");
    const rollback = await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}`, {
      method: "PATCH",
      headers: writeHeaders(userToken),
      body: JSON.stringify({
        status: payment.status,
        credited_at: null,
        bonus_amount: payment.bonus_amount ?? 0,
        bonus_status: payment.bonus_status ?? (eligible ? "pending" : "not_eligible"),
        bonus_credited_at: null,
      }),
    }).catch((err) => {
      logger.error({ err, paymentId }, "deposit claim rollback FAILED — manual reconciliation required");
      return null as Response | null;
    });
    if (!rollback || !rollback.ok) {
      logger.error({ paymentId }, "deposit claim rollback returned non-OK — manual reconciliation required");
    }
    return { ok: false, error: "Crédit du solde échoué (réessayez)", status: 500 };
  }

  logger.info({ paymentId, userId: payment.user_id, amount, bonus, newBalance }, "deposit credited");
  return { ok: true, alreadyCredited: false, amountCredited: amount, bonusCredited: bonus, newBalance, payment: claimed[0] };
}

/**
 * Mark a payment as failed/rejected without crediting anything.
 * Idempotent: if the payment was already marked as such, no-op.
 */
export async function markPaymentStatus(
  paymentId: string,
  status: "failed" | "rejected" | "pending",
  userToken?: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  if (!SUPABASE_URL) return { ok: false, error: "Supabase non configuré", status: 503 };

  // Refuse to silently revert a credited deposit. The admin should refund
  // explicitly through a separate flow (out of scope for this task).
  const payment = await fetchPayment(paymentId, userToken);
  if (!payment) return { ok: false, error: "Paiement introuvable", status: 404 };
  if (payment.credited_at) {
    return {
      ok: false,
      error: "Ce dépôt a déjà été crédité — un changement de statut nécessite un remboursement manuel.",
      status: 409,
    };
  }

  // Belt-and-suspenders: include the CAS condition so a concurrent
  // creditDeposit() that flips credited_at after our pre-check above cannot
  // get silently overwritten by this status change.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/payments?id=eq.${encodeURIComponent(paymentId)}&credited_at=is.null`,
    {
      method: "PATCH",
      headers: { ...writeHeaders(userToken), Prefer: "return=representation" },
      body: JSON.stringify({ status }),
    },
  );
  if (!r.ok) {
    const body = await r.text();
    logger.error(
      { paymentId, targetStatus: status, httpStatus: r.status, body: body.slice(0, 800) },
      "markPaymentStatus PATCH failed",
    );
    // Surface a more actionable error so the caller (and admin UI) can react.
    // 23514 = Postgres CHECK constraint violation — the most common cause is a
    // missing status value in the payments_status_check constraint. See
    // migrations/011_payments_status_check.sql for the fix.
    if (body.includes("23514")) {
      return {
        ok: false,
        error: "La base de données rejette ce statut (contrainte CHECK). Appliquer migrations/011_payments_status_check.sql.",
        status: 500,
      };
    }
    return { ok: false, error: "Mise à jour du statut échouée", status: 502 };
  }
  const updated = (await r.json()) as PaymentRow[];
  if (updated.length === 0) {
    // Concurrent crediting won the race — refuse to overwrite a credited deposit.
    return {
      ok: false,
      error: "Ce dépôt a été crédité entre-temps — un changement de statut nécessite un remboursement manuel.",
      status: 409,
    };
  }
  return { ok: true };
}
