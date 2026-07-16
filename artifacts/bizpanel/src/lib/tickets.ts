import { getAuthHeaders, authedFetch } from "./authFetch";

const fetch = authedFetch;

async function authHeaders(): Promise<HeadersInit> {
  return { ...(await getAuthHeaders()), "Content-Type": "application/json" };
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

export async function createTicket(input: {
  // Only `order_local_id` is needed when the ticket targets a specific order.
  // The server resolves canonical external_order_id / provider / service_name
  // from the orders table to prevent the client from binding a ticket to an
  // order it does not own.
  order_local_id?: string | null;
  action_type: TicketActionType;
  message: string;
}): Promise<Ticket> {
  const headers = await authHeaders();
  const r = await fetch("/api/tickets", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).ticket;
}

export async function fetchMyTickets(): Promise<Ticket[]> {
  const headers = await authHeaders();
  const r = await fetch("/api/tickets/mine", { headers });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).tickets;
}

// ── Ticket reply unread tracking (localStorage-based, no extra DB column) ──
const SEEN_REPLIES_KEY = "buzz_seen_ticket_replies";

export function getSeenTicketReplies(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_REPLIES_KEY) || "[]")); }
  catch { return new Set(); }
}

export function markTicketRepliesSeen(ids: string[]): void {
  try { localStorage.setItem(SEEN_REPLIES_KEY, JSON.stringify(ids)); } catch { /* noop */ }
}

export async function fetchTicketReplyUnread(): Promise<number> {
  try {
    const tickets = await fetchMyTickets();
    const seen = getSeenTicketReplies();
    return tickets.filter((t) => t.admin_response && !seen.has(t.id)).length;
  } catch { return 0; }
}

export async function fetchAdminTickets(): Promise<Ticket[]> {
  const headers = await authHeaders();
  const r = await fetch("/api/admin/tickets", { headers });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).tickets;
}

export async function fetchAdminTicketsUnread(): Promise<number> {
  const headers = await authHeaders();
  const r = await fetch("/api/admin/tickets/unread", { headers });
  if (!r.ok) return 0;
  return (await r.json()).count || 0;
}

export async function adminRespondTicket(
  ticketId: string,
  response: string,
  resolve: boolean,
): Promise<Ticket> {
  const headers = await authHeaders();
  const r = await fetch(`/api/admin/tickets/${ticketId}/respond`, {
    method: "POST",
    headers,
    body: JSON.stringify({ response, resolve }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).ticket;
}

export async function adminCloseTicket(ticketId: string): Promise<Ticket> {
  const headers = await authHeaders();
  const r = await fetch(`/api/admin/tickets/${ticketId}/close`, {
    method: "POST",
    headers,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).ticket;
}

export interface AdminCancelResult {
  status: string;
  previous_status?: string;
  refunded: boolean;
  refunded_amount?: number;
  user_id?: string;
  provider?: number;
  provider_cancel: { ok: boolean; error?: string };
}

export async function adminCancelOrder(
  externalId: string,
  providerId: number,
): Promise<AdminCancelResult> {
  const headers = await authHeaders();
  const r = await fetch(
    `/api/admin/orders/${encodeURIComponent(externalId)}/cancel?provider=${providerId}`,
    { method: "POST", headers },
  );
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
