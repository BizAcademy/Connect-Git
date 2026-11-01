import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

export interface SabitoJob {
  external_user_id: unknown;
  expires_at: string;
  signal?: AbortSignal;
  fields?: Record<string, unknown>;
}
export type Row = Record<string, unknown>;
export type Scalar = string | number | boolean | null;
export type SabitoResult = {
  status: "ok" | "pending" | "confirmed" | "failed" |
    "not_found" | "forbidden" | "error";
  data?: Record<string, Scalar>;
};
export type SabitoRead = (sql: string, params: string[], signal?: AbortSignal) => Promise<Row[]>;
export interface ReadContext {
  id: string;
  job: SabitoJob;
  read: (sql: string, params: string[]) => Promise<Row[]>;
}
export const field = (job: SabitoJob, key: string): string | null => {
  const value = job.fields?.[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 191) {
    throw new Error("INVALID_FIELD");
  }
  return value;
};
export function money(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+$/.test(value))) {
    throw new Error("MISSING_OR_INVALID_AMOUNT");
  }
  const minor = Number(value);
  if (!Number.isSafeInteger(minor)) throw new Error("INVALID_AMOUNT");
  return minor / 100;
}
export function text(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 2000) : null;
}
export function date(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  // Preserve the stored SQL date; do not invent its timezone.
  return text(value);
}
export function answer(status: SabitoResult["status"], statut: string, data: Record<string, Scalar> = {}): SabitoResult {
  const flat = { ...data, statut };
  if (Object.keys(flat).length > 32) throw new Error("TOO_MANY_FIELDS");
  for (const value of Object.values(flat)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("INVALID_NUMBER");
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("NON_SCALAR");
    if (typeof value === "string" && value.length > 2000) throw new Error("LONG_VALUE");
  }
  return { status, data: flat };
}
export function one(rows: Row[]): Row | SabitoResult {
  if (!rows.length) return { status: "not_found" };
  if (rows.length !== 1) return answer("error", "Plusieurs correspondances : une référence supplémentaire est nécessaire.");
  return rows[0]!;
}
export const isResult = (row: Row | SabitoResult): row is SabitoResult =>
  Object.keys(row).every(key => key === "status" || key === "data");

export const databaseRead: SabitoRead = async (sql, params, signal) => {
  signal?.throwIfAborted();
  if (!/^SELECT\s/i.test(sql)) throw new Error("READ_ONLY");
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>({ sql, timeout: 5000 }, params);
  signal?.throwIfAborted();
  return rows;
};
export function createGuard(query: SabitoRead) {
  return (action: (ctx: ReadContext) => Promise<SabitoResult>) => async (job: SabitoJob): Promise<SabitoResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const id = job.external_user_id;
      const remaining = Date.parse(job.expires_at) - Date.now();
      if (typeof id !== "string" || !id || id !== id.trim() || id.length > 191 ||
          id.startsWith("guest:") || id === "sabito-admin-preview" ||
          !Number.isFinite(remaining) || remaining <= 0) return { status: "forbidden" };
      if (job.fields != null && (typeof job.fields !== "object" || Array.isArray(job.fields))) return { status: "error" };
      const deadline = AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
      const signal = job.signal ? AbortSignal.any([job.signal, deadline]) : deadline;
      const check = () => { signal.throwIfAborted(); if (Date.parse(job.expires_at) <= Date.now()) throw new Error("EXPIRED"); };
      const read = async (sql: string, params: string[]) => {
        check();
        if (!/^SELECT\s/i.test(sql)) throw new Error("READ_ONLY");
        const rows = await query(sql, params, signal);
        check();
        return rows;
      };
      const work = async () => {
        const users = await read(`SELECT u.id, u.disabled_at, u.email_verified_at,
          EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role='admin') AS is_admin
          FROM users u WHERE u.id=? LIMIT 1`, [id]);
        if (!users[0]) return { status: "not_found" } as SabitoResult;
        if (users[0].disabled_at != null ||
            (users[0].email_verified_at == null && Number(users[0].is_admin) !== 1)) return { status: "forbidden" } as SabitoResult;
        const result = await action({ id, job: { ...job, signal }, read });
        check();
        return result;
      };
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DEADLINE")), Math.min(remaining, 2_147_483_647));
      })]);
    } catch { return { status: "error" }; }
    finally { if (timer) clearTimeout(timer); }
  };
}
