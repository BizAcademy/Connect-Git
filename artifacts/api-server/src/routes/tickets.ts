import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { requireUser, requireAdmin, type AuthedRequest } from "../lib/auth";
import {
  createTicket,
  listUserTickets,
  listAllTickets,
  getTicket,
  updateTicket,
  countOpenTickets,
  TicketError,
  type TicketActionType,
} from "../lib/tickets";

const router: IRouter = Router();

const SUPABASE_URL =
  process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

interface CanonicalOrder {
  id: string;
  user_id: string;
  external_order_id: string | null;
  provider: number | null;
  service_name: string | null;
}

// Server-side ownership check. Resolves the canonical order row for the given
// local id and confirms it belongs to `userId`. We never trust client-supplied
// external_order_id / provider — both are pulled from this DB row to prevent
// users from binding a ticket (and the admin's "cancel + refund" action) to
// another user's order.
async function resolveOrderForUser(
  orderLocalId: string,
  userId: string,
): Promise<CanonicalOrder | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const url =
    `${SUPABASE_URL}/rest/v1/orders` +
    `?id=eq.${encodeURIComponent(orderLocalId)}` +
    `&user_id=eq.${encodeURIComponent(userId)}` +
    `&select=id,user_id,external_order_id,provider,service_name&limit=1`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) return null;
  const rows = (await r.json()) as CanonicalOrder[];
  return rows && rows.length > 0 ? rows[0] || null : null;
}

const VALID_ACTIONS: ReadonlySet<TicketActionType> = new Set([
  "cancel",
  "refund",
  "speed_up",
  "other",
]);

// Anti-spam: at most 5 tickets per user per hour.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateMap = new Map<string, { count: number; windowStart: number }>();

function checkRate(userId: string): boolean {
  const now = Date.now();
  const e = rateMap.get(userId);
  if (!e || now - e.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateMap.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= RATE_LIMIT_MAX) return false;
  e.count += 1;
  return true;
}

router.post("/tickets", requireUser, async (req: AuthedRequest, res) => {
  try {
    if (!checkRate(req.userId!)) {
      return res
        .status(429)
        .json({ error: "Trop de tickets envoyés. Réessayez dans une heure." });
    }
    const body = req.body || {};
    const action_type = String(body.action_type || "") as TicketActionType;
    if (!VALID_ACTIONS.has(action_type)) {
      return res.status(400).json({ error: "Type d'action invalide" });
    }
    const message = String(body.message || "");
    const order_local_id = body.order_local_id ? String(body.order_local_id) : null;

    // Tickets without an order id are still allowed (generic intervention),
    // but if an order is referenced we MUST resolve it server-side and use the
    // DB-canonical metadata. Otherwise a malicious user could submit
    // fabricated external_order_id / provider_id and trick an admin into
    // cancelling someone else's order.
    let order_external_id: string | null = null;
    let provider_id: number | null = null;
    let service_name: string | null = null;
    if (order_local_id) {
      const order = await resolveOrderForUser(order_local_id, req.userId!);
      if (!order) {
        return res.status(404).json({ error: "Commande introuvable" });
      }
      order_external_id = order.external_order_id;
      provider_id = order.provider;
      service_name = order.service_name ? String(order.service_name).slice(0, 200) : null;
    }

    const t = await createTicket({
      user_id: req.userId!,
      order_external_id,
      order_local_id,
      provider_id,
      service_name,
      action_type,
      message,
    });
    res.json({ ticket: t });
  } catch (err) {
    const status = err instanceof TicketError ? err.statusCode : 500;
    if (status === 500) logger.error({ err }, "ticket create error");
    res.status(status).json({ error: (err as Error).message });
  }
});

router.get("/tickets/mine", requireUser, async (req: AuthedRequest, res) => {
  try {
    res.json({ tickets: await listUserTickets(req.userId!) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/admin/tickets", requireUser, requireAdmin, async (_req, res) => {
  try {
    res.json({ tickets: await listAllTickets() });
  } catch (err) {
    logger.error({ err }, "admin tickets list error");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/admin/tickets/unread", requireUser, requireAdmin, async (_req, res) => {
  try {
    res.json({ count: await countOpenTickets() });
  } catch {
    res.json({ count: 0 });
  }
});

router.post(
  "/admin/tickets/:id/respond",
  requireUser,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params["id"] || "");
      const response = String(req.body?.response || "").slice(0, 4000).trim();
      const resolve = req.body?.resolve === true;
      if (!response && !resolve) {
        return res.status(400).json({ error: "response ou resolve requis" });
      }
      const found = await getTicket(id);
      if (!found) return res.status(404).json({ error: "Ticket introuvable" });

      const patch: Parameters<typeof updateTicket>[1] = {};
      if (response) patch.admin_response = response;
      if (resolve) {
        patch.status = "resolved";
        patch.resolved_at = new Date().toISOString();
        patch.resolved_by = req.userId;
      } else if (!found.ticket.admin_response && response) {
        patch.status = "in_progress";
      }
      const updated = await updateTicket(id, patch);
      res.json({ ticket: updated });
    } catch (err) {
      logger.error({ err }, "ticket respond error");
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

router.post(
  "/admin/tickets/:id/close",
  requireUser,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params["id"] || "");
      const updated = await updateTicket(id, {
        status: "closed",
        resolved_at: new Date().toISOString(),
        resolved_by: req.userId,
      });
      if (!updated) return res.status(404).json({ error: "Ticket introuvable" });
      res.json({ ticket: updated });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// Used by the admin "Cancel order" flow to record on the ticket that the
// provider cancellation + refund were executed.
export async function markTicketCancelExecuted(
  ticketId: string,
  by: string,
  refundedAmountFcfa: number | undefined,
): Promise<void> {
  await updateTicket(ticketId, {
    cancel_executed: true,
    cancel_executed_at: new Date().toISOString(),
    refunded: true,
    ...(refundedAmountFcfa != null ? { refunded_amount_fcfa: refundedAmountFcfa } : {}),
    status: "resolved",
    resolved_at: new Date().toISOString(),
    resolved_by: by,
  });
}

export default router;
