import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

export class TicketError extends Error {
  constructor(message: string, public readonly statusCode: number) { super(message); }
}
export type TicketActionType = "cancel" | "refund" | "speed_up" | "other";
export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
export interface Ticket {
  id: string; short_code: string; ts: string; user_id: string;
  order_external_id: string | null; order_local_id: string | null;
  provider_id: number | null; service_name: string | null; action_type: TicketActionType;
  message: string; status: TicketStatus; admin_response?: string; resolved_at?: string;
  resolved_by?: string; cancel_executed?: boolean; cancel_executed_at?: string;
  refunded?: boolean; refunded_amount_fcfa?: number;
}
const map = (r: RowDataPacket): Ticket => ({
  id: String(r.id), short_code: String(r.short_code), user_id: String(r.user_id),
  action_type: r.action_type as TicketActionType, message: String(r.message), status: r.status as TicketStatus,
  ts: new Date(r.ts).toISOString(), order_external_id: r.order_external_id ?? null,
  order_local_id: r.order_local_id ?? null, provider_id: r.provider_id ?? null,
  service_name: r.service_name ?? null, admin_response: r.admin_response ?? undefined,
  resolved_at: r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined,
  resolved_by: r.resolved_by ?? undefined, cancel_executed: Boolean(r.cancel_executed),
  cancel_executed_at: r.cancel_executed_at ? new Date(r.cancel_executed_at).toISOString() : undefined,
  refunded: Boolean(r.refunded),
  refunded_amount_fcfa: r.refunded_amount_minor == null ? undefined : Number(r.refunded_amount_minor) / 100,
});
const SELECT = `SELECT id, short_code, ts, user_id, order_external_id, order_local_id, provider_id,
 service_name, action_type, message, status, admin_response, resolved_at, resolved_by,
 cancel_executed, cancel_executed_at, refunded, refunded_amount_minor FROM tickets`;

export async function createTicket(input: { user_id: string; order_external_id?: string | null; order_local_id?: string | null; provider_id?: number | null; service_name?: string | null; action_type: TicketActionType; message: string; }): Promise<Ticket> {
  const message = String(input.message || "").slice(0, 2000).trim();
  if (!message) throw new TicketError("Message requis", 400);
  if (!["cancel", "refund", "speed_up", "other"].includes(input.action_type)) throw new TicketError("Type d'action requis", 400);
  const id = crypto.randomUUID();
  const short = `T-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  await getMysqlPool().execute(
    `INSERT INTO tickets (id, short_code, user_id, order_external_id, order_local_id, provider_id, service_name, action_type, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, short, input.user_id, input.order_external_id ?? null, input.order_local_id ?? null, input.provider_id ?? null, input.service_name ?? null, input.action_type, message],
  );
  const found = await getTicket(id); if (!found) throw new TicketError("Ticket non disponible", 503); return found.ticket;
}
export async function listUserTickets(userId: string): Promise<Ticket[]> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(`${SELECT} WHERE user_id = ? ORDER BY ts DESC LIMIT 100`, [userId]); return rows.map(map);
}
export async function listAllTickets(): Promise<Ticket[]> {
  const [rows] = await getMysqlPool().query<RowDataPacket[]>(`${SELECT} ORDER BY (status IN ('resolved','closed')), ts DESC`); return rows.map(map);
}
export async function getTicket(id: string): Promise<{ ticket: Ticket; userId: string } | null> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(`${SELECT} WHERE id = ? LIMIT 1`, [id]);
  return rows[0] ? { ticket: map(rows[0]), userId: String(rows[0].user_id) } : null;
}
export async function updateTicket(id: string, patch: Partial<Pick<Ticket, "status" | "admin_response" | "resolved_at" | "resolved_by" | "cancel_executed" | "cancel_executed_at" | "refunded" | "refunded_amount_fcfa">>): Promise<Ticket | null> {
  const allowed: Record<string, unknown> = { ...patch };
  if (allowed.refunded_amount_fcfa !== undefined) { allowed.refunded_amount_minor = Math.round(Number(allowed.refunded_amount_fcfa) * 100); delete allowed.refunded_amount_fcfa; }
  const keys = Object.keys(allowed); if (!keys.length) return (await getTicket(id))?.ticket ?? null;
  await getMysqlPool().execute(
    `UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...keys.map((k) => allowed[k]), id] as any,
  );
  return (await getTicket(id))?.ticket ?? null;
}
export async function countOpenTickets(): Promise<number> {
  const [rows] = await getMysqlPool().query<(RowDataPacket & { n: number })[]>("SELECT COUNT(*) AS n FROM tickets WHERE status IN ('open', 'in_progress')");
  return Number(rows[0]?.n || 0);
}