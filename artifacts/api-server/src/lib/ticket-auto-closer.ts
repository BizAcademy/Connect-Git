/**
 * ticket-auto-closer.ts
 *
 * Background job that runs every 5 seconds.
 * Scans all open / in_progress tickets that have an order_local_id, fetches
 * the current order status from Supabase and automatically closes any ticket
 * whose linked order has reached a terminal state
 * (completed | cancelled | partial | refunded).
 *
 * When a ticket is closed this way the user sees the status change immediately
 * via the existing Supabase Realtime subscription in the Support page.
 */

import { logger } from "./logger";
import { listAllTickets, updateTicket } from "./tickets";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL =
  process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

function serviceHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Constants (exported so routes/tickets.ts can reuse without duplication)
// ---------------------------------------------------------------------------
export const TERMINAL_ORDER_STATUSES = new Set([
  "completed",
  "cancelled",
  "partial",
  "refunded",
]);

const STATUS_LABEL: Record<string, string> = {
  completed: "terminée",
  cancelled:  "annulée",
  partial:    "partiellement livrée",
  refunded:   "remboursée",
};

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------
let inFlight = false;

async function runOnce(): Promise<void> {
  if (inFlight) return;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  inFlight = true;
  try {
    const all = await listAllTickets();
    const open = all.filter(
      (t) =>
        (t.status === "open" || t.status === "in_progress") &&
        t.order_local_id,
    );
    if (!open.length) return;

    // Collect unique order UUIDs and fetch their statuses in batches of 500.
    const uniqueIds = [...new Set(open.map((t) => t.order_local_id!))];
    const statusByOrderId = new Map<string, string>();

    for (let i = 0; i < uniqueIds.length; i += 500) {
      const chunk = uniqueIds.slice(i, i + 500);
      const inList = chunk.map((id) => `"${id}"`).join(",");
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/orders?id=in.(${inList})&select=id,status`,
          { headers: serviceHeaders() },
        );
        if (r.ok) {
          const rows = (await r.json()) as Array<{ id: string; status: string }>;
          for (const row of rows) statusByOrderId.set(row.id, row.status);
        }
      } catch (err) {
        logger.error({ err }, "ticket-auto-closer: order status batch fetch failed");
      }
    }

    // Close every ticket whose linked order is now terminal.
    const toClose = open.filter((t) => {
      const s = statusByOrderId.get(t.order_local_id!);
      return s && TERMINAL_ORDER_STATUSES.has(s);
    });

    for (const ticket of toClose) {
      const orderStatus = statusByOrderId.get(ticket.order_local_id!)!;
      const label = STATUS_LABEL[orderStatus] ?? orderStatus;
      try {
        await updateTicket(ticket.id, {
          status: "closed",
          admin_response:
            `Ticket fermé automatiquement : la commande liée est ${label}. ` +
            `Aucune intervention supplémentaire n'est nécessaire. ` +
            `Si vous avez d'autres questions, ouvrez un nouveau ticket.`,
          resolved_at: new Date().toISOString(),
          resolved_by: "system",
        });
        logger.info(
          { ticketId: ticket.id, orderId: ticket.order_local_id, orderStatus },
          "ticket-auto-closer: ticket closed automatically",
        );
      } catch (err) {
        logger.error({ err, ticketId: ticket.id }, "ticket-auto-closer: close failed");
      }
    }
  } finally {
    inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Exported starter
// ---------------------------------------------------------------------------
export function startTicketAutoCloser(): void {
  // Short boot delay so Supabase connections are already warmed.
  setTimeout(() => {
    void runOnce();
    setInterval(() => { void runOnce(); }, 5_000);
  }, 4_000);

  logger.info("ticket-auto-closer: started (interval 5 s)");
}
