import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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

const DIR = path.resolve(process.cwd(), "data", "tickets");
const MAX_TICKETS_PER_USER = 100;
const MAX_MESSAGE_LEN = 2000;

function userFile(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(DIR, `${safe}.jsonl`);
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
}

async function readUserTickets(userId: string): Promise<Ticket[]> {
  try {
    const txt = await fs.readFile(userFile(userId), "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as Ticket; } catch { return null; } })
      .filter((t): t is Ticket => t !== null);
  } catch {
    return [];
  }
}

async function writeUserTickets(userId: string, tickets: Ticket[]): Promise<void> {
  await ensureDirs();
  const txt = tickets.length
    ? tickets.map((t) => JSON.stringify(t)).join("\n") + "\n"
    : "";
  // Atomic rewrite: write to a temp file then rename. Prevents partial writes
  // from corrupting the JSONL ledger if the process is killed mid-write.
  const dest = userFile(userId);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, txt, "utf8");
  await fs.rename(tmp, dest);
}

// In-process per-user serialization. Every read-modify-write op (create,
// update) MUST go through this mutex so two concurrent requests for the same
// user cannot lose data. Sufficient because the api-server runs as a single
// Node process; if you scale horizontally, switch to a DB-backed store with
// transactional updates.
const userLocks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  // Run fn after prev settles (success or failure) — never let one failed
  // op poison the chain for the next caller.
  const next = prev.then(fn, fn);
  // Store a swallowed version so future callers chain on a guaranteed-resolved
  // promise. We also keep a reference for opportunistic cleanup below.
  const settled = next.then(() => {}, () => {});
  userLocks.set(userId, settled);
  try {
    return await next;
  } finally {
    // Only drop the entry if no later caller queued behind us.
    if (userLocks.get(userId) === settled) {
      userLocks.delete(userId);
    }
  }
}

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
  await ensureDirs();
  const message = String(input.message || "").slice(0, MAX_MESSAGE_LEN).trim();
  if (!message) throw new TicketError("Message requis", 400);
  if (!input.action_type) throw new TicketError("Type d'action requis", 400);

  return withUserLock(input.user_id, async () => {
    const existing = await readUserTickets(input.user_id);
    if (existing.length >= MAX_TICKETS_PER_USER) {
      throw new TicketError(
        "Limite de tickets atteinte pour ce compte (max 100). Contactez le support.",
        429,
      );
    }
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
    existing.push(ticket);
    await writeUserTickets(input.user_id, existing);
    return ticket;
  });
}

export async function listUserTickets(userId: string): Promise<Ticket[]> {
  const all = await readUserTickets(userId);
  return all.sort((a, b) => b.ts.localeCompare(a.ts));
}

export async function listAllTickets(): Promise<Ticket[]> {
  await ensureDirs();
  let entries: string[] = [];
  try { entries = await fs.readdir(DIR); } catch { return []; }
  const all: Ticket[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const userId = f.replace(/\.jsonl$/, "");
    const list = await readUserTickets(userId);
    all.push(...list);
  }
  return all.sort((a, b) => {
    const ao = a.status === "resolved" || a.status === "closed" ? 1 : 0;
    const bo = b.status === "resolved" || b.status === "closed" ? 1 : 0;
    if (ao !== bo) return ao - bo;
    return b.ts.localeCompare(a.ts);
  });
}

export async function getTicket(
  ticketId: string,
): Promise<{ ticket: Ticket; userId: string } | null> {
  await ensureDirs();
  let entries: string[] = [];
  try { entries = await fs.readdir(DIR); } catch { return null; }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const userId = f.replace(/\.jsonl$/, "");
    const list = await readUserTickets(userId);
    const t = list.find((x) => x.id === ticketId);
    if (t) return { ticket: t, userId };
  }
  return null;
}

export async function updateTicket(
  ticketId: string,
  patch: Partial<Pick<
    Ticket,
    | "status"
    | "admin_response"
    | "resolved_at"
    | "resolved_by"
    | "cancel_executed"
    | "cancel_executed_at"
    | "refunded"
    | "refunded_amount_fcfa"
  >>,
): Promise<Ticket | null> {
  const found = await getTicket(ticketId);
  if (!found) return null;
  // Re-read inside the lock to guarantee we apply the patch on top of the
  // most recent on-disk state, not a stale snapshot.
  return withUserLock(found.userId, async () => {
    const list = await readUserTickets(found.userId);
    let updated: Ticket | null = null;
    const next = list.map((t) => {
      if (t.id !== ticketId) return t;
      updated = { ...t, ...patch };
      return updated;
    });
    if (!updated) return null;
    await writeUserTickets(found.userId, next);
    return updated;
  });
}

export async function countOpenTickets(): Promise<number> {
  const all = await listAllTickets();
  return all.filter((t) => t.status === "open" || t.status === "in_progress").length;
}
