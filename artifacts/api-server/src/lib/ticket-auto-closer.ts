import type { RowDataPacket } from "mysql2/promise";
import { logger } from "./logger";
import { getMysqlPool } from "./mysql";
import { listAllTickets, updateTicket } from "./tickets";
export const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled", "partial", "refunded"]);
const labels: Record<string, string> = { completed: "terminée", cancelled: "annulée", partial: "partiellement livrée", refunded: "remboursée" };
let inFlight = false;
async function runOnce() {
  if (inFlight) return; inFlight = true;
  try {
    const tickets = (await listAllTickets()).filter(t => (t.status === "open" || t.status === "in_progress") && t.order_local_id);
    if (!tickets.length) return;
    const ids = [...new Set(tickets.map(t => t.order_local_id!))];
    const state = new Map<string, string>();
    for (const idsChunk of Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, i * 500 + 500))) {
      const [rows] = await getMysqlPool().execute<RowDataPacket[]>(`SELECT id,status FROM orders WHERE id IN (${idsChunk.map(() => "?").join(",")})`, idsChunk);
      rows.forEach(r => state.set(String(r.id), String(r.status)));
    }
    for (const ticket of tickets) {
      const status = state.get(ticket.order_local_id!); if (!status || !TERMINAL_ORDER_STATUSES.has(status)) continue;
      await updateTicket(ticket.id, { status: "closed", admin_response: `Ticket fermé automatiquement : la commande liée est ${labels[status] ?? status}. Aucune intervention supplémentaire n'est nécessaire. Si vous avez d'autres questions, ouvrez un nouveau ticket.`, resolved_at: new Date().toISOString(), resolved_by: "system" });
    }
  } catch (err) { logger.error({ err }, "ticket-auto-closer: run failed"); } finally { inFlight = false; }
}
export function startTicketAutoCloser(): void { setTimeout(() => { void runOnce(); setInterval(() => void runOnce(), 5_000); }, 4_000); logger.info("ticket-auto-closer: started (interval 5 s)"); }