// Admin client for deposits/bonus endpoints.
import { getAuthHeaders, authedFetch } from "./authFetch";

const authHeaders = getAuthHeaders;
const fetch = authedFetch;

export interface AdminDeposit {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  method: string;
  reference: string | null;
  created_at: string;
  bonus_amount: number | null;
  bonus_status: "credited" | "pending" | "not_eligible" | string | null;
  bonus_credited_at: string | null;
  credited_at: string | null;
  user_username?: string | null;
  user_email?: string | null;
  country?: string | null;
  currency?: string | null;
}

export interface AdminDepositsResponse {
  deposits: AdminDeposit[];
  counters: {
    total: number;
    total_amount_fcfa: number;
    bonus_pending: number;
    bonus_credited: number;
    bonus_credited_fcfa: number;
    bonus_eligible: number;
  };
  bonus_rule: { threshold_fcfa: number; bonus_fcfa: number };
}

export interface AdminDepositsFilter {
  from?: string;
  to?: string;
  period?: "today" | "7d" | "30d" | "all";
  status?: "all" | "completed" | "pending" | "rejected" | "failed";
  bonus_status?: "all" | "credited" | "pending" | "not_eligible";
  search?: string;
  min_amount?: number;
  max_amount?: number;
  min_user_deposits?: number;
  limit?: number;
}

export async function fetchAdminDeposits(filter: AdminDepositsFilter = {}): Promise<AdminDepositsResponse> {
  const headers = await authHeaders();
  const qs = new URLSearchParams();
  Object.entries(filter).forEach(([k, v]) => {
    if (v !== undefined && v !== "" && v !== null) qs.set(k, String(v));
  });
  const r = await fetch(`/api/admin/deposits?${qs.toString()}`, { headers });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function adminSetDepositStatus(
  id: string,
  status: "completed" | "failed" | "rejected" | "pending",
): Promise<{ ok: boolean; already_credited?: boolean; amount_credited?: number; bonus_credited?: number; new_balance?: number | null }> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const r = await fetch(`/api/admin/deposits/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function adminCreditBonus(id: string): Promise<{ ok: boolean; bonus_credited?: number; already_credited?: boolean }> {
  const headers = await authHeaders();
  const r = await fetch(`/api/admin/deposits/${encodeURIComponent(id)}/credit-bonus`, {
    method: "POST",
    headers,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}
