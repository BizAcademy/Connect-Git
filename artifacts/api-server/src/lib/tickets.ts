// Ticket storage backed by Supabase (table `tickets`).
// Falls back to local JSONL files when Supabase secrets are absent so
// development still works without a configured project.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "./logger";

export class TicketError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "TicketError";
  }
}

export type TicketActionType = "cancel" | "refund" | "speed_up" | "other";
export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

export interface Ticket {
  id: string;
  short_code: string;
  ts: string;
  user_id: string;
  order_external_id: string | null;
  order_local_id: string | null;
  provider_id: number | null;
  service_name: string | null;
  action_type: TicketActionType;
  message: string;
  status: TicketStatus;
  admin_response?: string;
  resolved_at?: string;
  resolved_by?: string;
  cancel_executed?: boolean;
  cancel_executed_at?: string;
  refunded?: boolean;
  refunded_amount_fcfa?: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

function supabaseEnabled(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function serviceRoleHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

const MAX_MESSAGE_LEN = 2000;
const MAX_TICKETS_PER_USER = 100;

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: String(row["id"] || ""),
    short_code: String(row["short_code"] || ""),
    ts: String(row["ts"] || row["created_at"] || ""),
    user_id: String(row["user_id"] || ""),
    order_external_id: row["order_external_id"] != null ? String(row["order_external_id"]) : null,
    order_local_id: row["order_local_id"] != null ? String(row["order_local_id"]) : null,
    provider_id: row["provider_id"] != null ? Number(row["provider_id"]) : null,
    service_name: row["service_name"] != null ? String(row["service_name"]) : null,
    action_type: (row["action_type"] as TicketActionType) || "other",
    message: String(row["message"] || ""),
    status: (row["status"] as TicketStatus) || "open",
    admin_response: row["admin_response"] != null ? String(row["admin_response"]) : undefined,
    resolved_at: row["resolved_at"] != null ? String(row["resolved_at"]) : undefined,
    resolved_by: row["resolved_by"] != null ? String(row["resolved_by"]) : undefined,
    cancel_executed: Boolean(row["cancel_executed"]),
    cancel_executed_at: row["cancel_executed_at"] != null ? String(row["cancel_executed_at"]) : undefined,
    refunded: Boolean(row["refunded"]),
    refunded_amount_fcfa: row["refunded_amount_fcfa"] != null ? Number(row["refunded_amount_fcfa"]) : undefined,
  };
}

async function supabaseInsertTicket(ticket: Ticket): Promise<Ticket | null> {
  try {
    const body = {
      id: ticket.id,
      short_code: ticket.short_code,
      ts: ticket.ts,
      user_id: ticket.user_id,
      order_external_id: ticket.order_external_id,
      order_local_id: ticket.order_local_id,
      provider_id: ticket.provider_id,
      service_name: ticket.service_name,
      action_type: ticket.action_type,
      message: ticket.message,
      status: ticket.status,
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets`, {
      method: "POST",
      headers: serviceRoleHeaders(),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      logger.error({ status: r.status, body: txt.slice(0, 300) }, "tickets: supabase insert failed");
      return null;
    }
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    return rows[0] ? rowToTicket(rows[0]) : ticket;
  } catch (err) {
    logger.error({ err }, "tickets: supabase insert threw");
    return null;
  }
}

async function supabaseListAllTickets(): Promise<Ticket[] | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tickets?order=status.asc,ts.desc&limit=500`,
      { headers: serviceRoleHeaders() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    // Open/in_progress first, then resolved/closed
    return rows.map(rowToTicket).sort((a, b) => {
      const ao = a.status === "resolved" || a.status === "closed" ? 1 : 0;
      const bo = b.status === "resolved" || b.status === "closed" ? 1 : 0;
      if (ao !== bo) return ao - bo;
      return b.ts.localeCompare(a.ts);
    });
  } catch (err) {
    logger.error({ err }, "tickets: supabase listAll threw");
    return null;
  }
}

async function supabaseListUserTickets(userId: string): Promise<Ticket[] | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tickets?user_id=eq.${encodeURIComponent(userId)}&order=ts.desc&limit=100`,
      { headers: serviceRoleHeaders() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    return rows.map(rowToTicket);
  } catch (err) {
    logger.error({ err }, "tickets: supabase listUser threw");
    return null;
  }
}

async function supabaseGetTicket(ticketId: string): Promise<{ ticket: Ticket; userId: string } | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tickets?id=eq.${encodeURIComponent(ticketId)}&limit=1`,
      { headers: serviceRoleHeaders() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    if (!rows || rows.length === 0) return null;
    const ticket = rowToTicket(rows[0]!);
    return { ticket, userId: ticket.user_id };
  } catch (err) {
    logger.error({ err }, "tickets: supabase getTicket threw");
    return null;
  }
}

async function supabaseUpdateTicket(
  ticketId: string,
  patch: Record<string, unknown>,
): Promise<Ticket | null> {
  try {
    const body = { ...patch, updated_at: new Date().toISOString() };
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tickets?id=eq.${encodeURIComponent(ticketId)}`,
      {
        method: "PATCH",
        headers: serviceRoleHeaders(),
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      logger.error({ status: r.status, body: txt.slice(0, 300) }, "tickets: supabase patch failed");
      return null;
    }
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    return rows[0] ? rowToTicket(rows[0]) : null;
  } catch (err) {
    logger.error({ err }, "tickets: supabase patch threw");
    return null;
  }
}

async function supabaseCountOpen(): Promise<number | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tickets?status=in.("open","in_progress")&select=id`,
      {
        headers: {
          ...serviceRoleHeaders(),
          Prefer: "count=exact",
          "Range-Unit": "items",
          Range: "0-0",
        },
      },
    );
    const raw = r.headers.get("content-range") || "";
    const m = raw.match(/\/(\d+)$/);
    if (m) return Number(m[1]);
    // Fallback: parse body
    const rows = (await r.json().catch(() => [])) as unknown[];
    return rows.length;
  } catch (err) {
    logger.error({ err }, "tickets: supabase countOpen threw");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local filesystem fallback (development without Supabase)
// ---------------------------------------------------------------------------
const DIR = path.resolve(process.cwd(), "data", "tickets");

function userFile(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(DIR, `${safe}.jsonl`);
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
}

async function readUserTicketsLocal(userId: string): Promise<Ticket[]> {
  try {
    const txt = await fs.readFile(userFile(userId), "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as Ticket; } catch { return null; } })
      .filter((t): t is Ticket => t !== null);
  } catch { return []; }
}

async function writeUserTicketsLocal(userId: string, tickets: Ticket[]): Promise<void> {
  await ensureDirs();
  const txt = tickets.length ? tickets.map((t) => JSON.stringify(t)).join("\n") + "\n" : "";
  const dest = userFile(userId);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, txt, "utf8");
  await fs.rename(tmp, dest);
}

const userLocks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(() => {}, () => {});
  userLocks.set(userId, settled);
  try { return await next; } finally {
    if (userLocks.get(userId) === settled) userLocks.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function newShortCode(): string {
  return "T-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

export async function createTicket(input: {
  user_id: string;
  order_external_id?: string | null;
  order_local_id?: string | null;
  provider_id?: number | null;
  service_name?: string | null;
  action_type: TicketActionType;
  message: string;
}): Promise<Ticket> {
  const message = String(input.message || "").slice(0, MAX_MESSAGE_LEN).trim();
  if (!message) throw new TicketError("Message requis", 400);
  if (!input.action_type) throw new TicketError("Type d'action requis", 400);

  const ticket: Ticket = {
    id: crypto.randomUUID(),
    short_code: newShortCode(),
    ts: new Date().toISOString(),
    user_id: input.user_id,
    order_external_id: input.order_external_id ?? null,
    order_local_id: input.order_local_id ?? null,
    provider_id: input.provider_id ?? null,
    service_name: input.service_name ?? null,
    action_type: input.action_type,
    message,
    status: "open",
  };

  if (supabaseEnabled()) {
    const saved = await supabaseInsertTicket(ticket);
    if (saved) return saved;
    logger.warn({ ticketId: ticket.id }, "tickets: supabase insert failed, falling back to local file");
  }

  // Fallback: local filesystem
  await ensureDirs();
  return withUserLock(input.user_id, async () => {
    const existing = await readUserTicketsLocal(input.user_id);
    if (existing.length >= MAX_TICKETS_PER_USER) {
      throw new TicketError("Limite de tickets atteinte pour ce compte (max 100).", 429);
    }
    existing.push(ticket);
    await writeUserTicketsLocal(input.user_id, existing);
    return ticket;
  });
}

export async function listUserTickets(userId: string): Promise<Ticket[]> {
  if (supabaseEnabled()) {
    const rows = await supabaseListUserTickets(userId);
    if (rows !== null) return rows;
  }
  const all = await readUserTicketsLocal(userId);
  return all.sort((a, b) => b.ts.localeCompare(a.ts));
}

export async function listAllTickets(): Promise<Ticket[]> {
  if (supabaseEnabled()) {
    const rows = await supabaseListAllTickets();
    if (rows !== null) return rows;
  }
  await ensureDirs();
  let entries: string[] = [];
  try { entries = await fs.readdir(DIR); } catch { return []; }
  const all: Ticket[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const userId = f.replace(/\.jsonl$/, "");
    const list = await readUserTicketsLocal(userId);
    all.push(...list);
  }
  return all.sort((a, b) => {
    const ao = a.status === "resolved" || a.status === "closed" ? 1 : 0;
    const bo = b.status === "resolved" || b.status === "closed" ? 1 : 0;
    if (ao !== bo) return ao - bo;
    return b.ts.localeCompare(a.ts);
  });
}

export async function getTicket(ticketId: string): Promise<{ ticket: Ticket; userId: string } | null> {
  if (supabaseEnabled()) {
    const found = await supabaseGetTicket(ticketId);
    if (found !== null) return found;
  }
  await ensureDirs();
  let entries: string[] = [];
  try { entries = await fs.readdir(DIR); } catch { return null; }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const userId = f.replace(/\.jsonl$/, "");
    const list = await readUserTicketsLocal(userId);
    const t = list.find((x) => x.id === ticketId);
    if (t) return { ticket: t, userId };
  }
  return null;
}

export async function updateTicket(
  ticketId: string,
  patch: Partial<Pick<
    Ticket,
    | "status" | "admin_response" | "resolved_at" | "resolved_by"
    | "cancel_executed" | "cancel_executed_at" | "refunded" | "refunded_amount_fcfa"
  >>,
): Promise<Ticket | null> {
  if (supabaseEnabled()) {
    const updated = await supabaseUpdateTicket(ticketId, patch as Record<string, unknown>);
    if (updated !== null) return updated;
    logger.warn({ ticketId }, "tickets: supabase patch failed, falling back to local file");
  }

  // Fallback: local filesystem
  const found = await getTicket(ticketId);
  if (!found) return null;
  return withUserLock(found.userId, async () => {
    const list = await readUserTicketsLocal(found.userId);
    let updated: Ticket | null = null;
    const next = list.map((t) => {
      if (t.id !== ticketId) return t;
      updated = { ...t, ...patch };
      return updated;
    });
    if (!updated) return null;
    await writeUserTicketsLocal(found.userId, next);
    return updated;
  });
}

export async function countOpenTickets(): Promise<number> {
  if (supabaseEnabled()) {
    const n = await supabaseCountOpen();
    if (n !== null) return n;
  }
  const all = await listAllTickets();
  return all.filter((t) => t.status === "open" || t.status === "in_progress").length;
}
