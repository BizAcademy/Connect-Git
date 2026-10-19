import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

export interface SabitoJob {
  external_user_id: unknown;
  expires_at: string;
  signal?: AbortSignal;
  fields?: Record<string, unknown>;
}
export type SabitoResult = {
  status: "active" | "inactive" | "pending" | "confirmed" | "failed" |
    "ok" | "forbidden" | "not_found" | "error";
  code?: string;
};
type Row = Record<string, unknown>;
export type SabitoRead = (sql: string, params: string[], signal?: AbortSignal) => Promise<Row[]>;

const read: SabitoRead = async (sql, params, signal) => {
  signal?.throwIfAborted();
  if (!/^SELECT\s/i.test(sql)) throw new Error("SABITO_READ_ONLY");
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>({ sql, timeout: 5000 }, params);
  signal?.throwIfAborted();
  return rows;
};

export function createSabitoHandlers(query: SabitoRead = read) {
  function identity(job: SabitoJob): string | null {
    const id = job.external_user_id;
    const expiry = Date.parse(job.expires_at);
    if (
      typeof id !== "string" || !id || id !== id.trim() || id.length > 191 ||
      id.startsWith("guest:") || id === "sabito-admin-preview" ||
      !Number.isFinite(expiry) || expiry <= Date.now() || job.signal?.aborted
    ) return null;
    return id;
  }
  async function member(job: SabitoJob) {
    const id = identity(job);
    if (!id) return null;
    const rows = await query(
      `SELECT u.id, u.disabled_at, u.email_verified_at,
       EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role='admin') AS is_admin
       FROM users u WHERE u.id=? LIMIT 1`, [id], job.signal,
    );
    return rows[0] ? { id, row: rows[0] } : null;
  }
  const active = (row: Row) => row.disabled_at == null &&
    (row.email_verified_at != null || Number(row.is_admin) === 1);
  const field = (job: SabitoJob, key: string) => {
    const value = job.fields?.[key];
    return typeof value === "string" && value.trim().length > 0 &&
      value.trim().length <= 191 ? value.trim() : null;
  };
  async function safely(action: () => Promise<SabitoResult>): Promise<SabitoResult> {
    try { return await action(); } catch { return { status: "error" }; }
  }
  return {
    account_activation: (job: SabitoJob) => safely(async () => {
      const user = await member(job);
      if (!user) return { status: "not_found" };
      if (user.row.disabled_at != null) return { status: "inactive" };
      return { status: active(user.row) ? "active" : "pending" };
    }),
    deposit_status: (job: SabitoJob) => safely(async () => {
      const user = await member(job);
      if (!user) return { status: "not_found" };
      if (!active(user.row)) return { status: "forbidden" };
      const deposit = field(job, "deposit_number");
      const transaction = field(job, "transaction_id");
      if (!deposit && !transaction) return { status: "error" };
      // Every possible identifier is constrained by ownership in SQL.
      // When both identifiers are supplied they must match the SAME payment.
      const predicates = ["user_id=?"];
      const params = [user.id];
      if (deposit) {
        predicates.push("(id=? OR order_id=? OR reference=? OR provider_reference=?)");
        params.push(deposit, deposit, deposit, deposit);
      }
      if (transaction) {
        predicates.push("transaction_id=?");
        params.push(transaction);
      }
      const rows = await query(
        `SELECT status, credited_at FROM payments WHERE ${predicates.join(" AND ")} LIMIT 2`,
        params, job.signal,
      );
      if (rows.length === 0) return { status: "not_found" };
      if (rows.length !== 1) return { status: "error" };
      const payment = rows[0]!;
      if (payment.status === "completed" && payment.credited_at != null) return { status: "confirmed" };
      if (payment.credited_at != null) return { status: "error" };
      if (payment.status === "pending") return { status: "pending" };
      if (["failed", "rejected", "cancelled", "expired"].includes(String(payment.status))) {
        return { status: "failed" };
      }
      return { status: "error" }; // Unknown/inconsistent state is NOT a confirmation.
    }),
    referral_code: (job: SabitoJob) => safely(async () => {
      const user = await member(job);
      if (!user) return { status: "not_found" };
      if (!active(user.row)) return { status: "forbidden" };
      // Do not call ensureReferralCode: that helper can UPDATE the profile.
      const rows = await query(
        "SELECT referral_code FROM profiles WHERE user_id=? LIMIT 1", [user.id], job.signal,
      );
      const code = rows[0]?.referral_code;
      if (code == null || code === "") return { status: "not_found" };
      if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(code)) return { status: "error" };
      return { status: "ok", code };
    }),
    // No withdrawal_status: this platform has no withdrawal service/table.
    // Never advertise a fabricated verification capability.
  };
}
