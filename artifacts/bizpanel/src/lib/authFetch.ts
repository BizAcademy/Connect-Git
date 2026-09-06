import { toast } from "@/lib/toast";

let signedOutOnce = false;

export async function getAuthHeaders(): Promise<Record<string, string>> {
  return {};
}

function handleUnrecoverableAuth() {
  if (signedOutOnce) return;
  signedOutOnce = true;
  toast.error("Session expirée, reconnectez-vous.");
  void fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  setTimeout(() => window.location.assign("/auth"), 250);
}

/**
 * Cookie-authenticated fetch wrapper. The opaque token is never readable by
 * JavaScript; the browser supplies its HttpOnly cookie.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (res.status === 401) handleUnrecoverableAuth();
  return res;
}
