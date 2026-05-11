// Sync local order rows with the SMM provider via the SERVER (no client-side
// PostgREST PATCH anymore — RLS used to silently swallow those writes for
// admin viewers, and there was no way to issue an idempotent refund).
//
// The server endpoint POST /api/smm/orders/:externalId/sync :
//   1. verifies ownership (or admin),
//   2. queries the SMM provider for the up-to-date status,
//   3. writes the new status with the service-role key,
//   4. atomically credits the wallet back if the provider reports
//      canceled / refunded / failed (CAS on `refunded_at IS NULL`
//      guarantees idempotency — no double refund possible).
//
// This module returns the orders with their up-to-date status AND the list of
// orders that were refunded during this sync, so callers can show a toast
// and refresh the user's balance.

import { getAuthHeaders, authedFetch } from "./authFetch";

const fetch = authedFetch;

export const FINAL_STATUSES = new Set([
  "completed", "failed", "canceled", "cancelled", "refunded",
]);

export function mapProviderStatus(s: string): string {
  const v = (s || "").trim().toLowerCase();
  if (v === "completed" || v === "complete") return "completed";
  if (v === "partial") return "partial";
  if (v === "canceled" || v === "cancelled") return "canceled";
  if (v === "refunded") return "refunded";
  if (v === "failed" || v === "fail" || v === "error") return "failed";
  if (v === "in progress" || v === "processing") return "processing";
  if (v === "pending") return "pending";
  return v || "processing";
}

const BATCH = 6;

const authHeader = getAuthHeaders;

export interface SyncRefundEvent {
  orderId: any;
  externalId: string;
  amount: number;
}

export interface SyncResult<T> {
  orders: T[];
  refunds: SyncRefundEvent[];
}

/**
 * Sync each non-final order with the provider via the server proxy.
 * Returns only the updated orders (backwards-compatible shape).
 * For callers that need the refund events too, use
 * `syncOrdersStatusWithRefunds` instead.
 */
export interface SyncOptions {
  /** when true, hit the admin sync endpoint that bypasses ownership checks */
  admin?: boolean;
}

export async function syncOrdersStatus<T extends { id: any; status?: string; external_order_id?: string | null; provider?: number | null }>(
  orders: T[],
  opts: SyncOptions = {},
): Promise<T[]> {
  const r = await syncOrdersStatusWithRefunds(orders, opts);
  return r.orders;
}

export async function syncOrdersStatusWithRefunds<
  T extends { id: any; status?: string; external_order_id?: string | null; provider?: number | null }
>(orders: T[], opts: SyncOptions = {}): Promise<SyncResult<T>> {
  const pending = orders.filter(
    (o) => o.external_order_id && !FINAL_STATUSES.has((o.status || "").toLowerCase()),
  );
  if (pending.length === 0) return { orders, refunds: [] };

  const headers = await authHeader();
  const updates = new Map<any, string>();
  const refunds: SyncRefundEvent[] = [];
  const basePath = opts.admin ? "/api/admin/orders" : "/api/smm/orders";

  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (o) => {
        try {
          const ext = String(o.external_order_id);
          const p = o.provider === 3 || o.provider === 4 || o.provider === 5 ? o.provider : 1;
          const res = await fetch(
            `${basePath}/${encodeURIComponent(ext)}/sync?provider=${p}`,
            { method: "POST", headers },
          );
          if (!res.ok) return;
          const data = await res.json().catch(() => null) as
            | { status?: string; refunded?: boolean; refunded_amount?: number }
            | null;
          if (!data || !data.status) return;
          const newStatus = mapProviderStatus(data.status);
          if (newStatus && newStatus !== o.status) {
            updates.set(o.id, newStatus);
          }
          if (data.refunded && typeof data.refunded_amount === "number") {
            refunds.push({ orderId: o.id, externalId: ext, amount: data.refunded_amount });
          }
        } catch {}
      }),
    );
  }

  const out = updates.size === 0
    ? orders
    : orders.map((o) => (updates.has(o.id) ? { ...o, status: updates.get(o.id) as string } : o));
  return { orders: out, refunds };
}
