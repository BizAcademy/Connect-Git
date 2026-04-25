// Centralized auth + fetch helpers.
//
// Why: `supabase.auth.getSession()` returns the *cached* session and does NOT
// auto-refresh the access token at call time. Even with `autoRefreshToken: true`,
// the background refresh can lag (tab in background, laptop sleep, network
// hiccup), so by the time the API server forwards the JWT to Supabase
// (`/auth/v1/user`) it can already be expired -> 401 "Session invalide".
//
// `getAuthHeaders()` proactively refreshes the token if it expires in < 60 s.
// `authedFetch()` wraps `fetch()` and, on a 401, forces one refresh + retry.
// If the second attempt is still 401, the session is unrecoverable -> sign out
// and bounce the user to /login with a clear toast.

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const REFRESH_SAFETY_WINDOW_MS = 60_000;

let refreshPromise: Promise<string | null> | null = null;
let signedOutOnce = false;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = supabase.auth.refreshSession()
      .then(({ data, error }) => {
        if (error) return null;
        return data.session?.access_token ?? null;
      })
      .catch(() => null)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

/**
 * Returns an `Authorization: Bearer <token>` header, refreshing the JWT
 * proactively if it is about to expire. Returns `{}` if the user is not
 * logged in or if the refresh failed (caller will get a 401 from the API).
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  let token = data.session?.access_token;
  const expiresAt = data.session?.expires_at; // unix seconds
  const needsRefresh =
    !!token &&
    typeof expiresAt === "number" &&
    expiresAt * 1000 < Date.now() + REFRESH_SAFETY_WINDOW_MS;
  if (needsRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) token = refreshed;
  }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleUnrecoverableAuth() {
  if (signedOutOnce) return;
  signedOutOnce = true;
  toast.error("Session expirée, reconnectez-vous.");
  supabase.auth.signOut().finally(() => {
    // Allow the toast to render before navigating.
    setTimeout(() => {
      if (typeof window !== "undefined") {
        window.location.assign("/login");
      }
    }, 250);
  });
}

/**
 * `fetch()` wrapper that injects the auth header (with proactive refresh)
 * and retries once on 401 after forcing a refresh. On a second 401 it signs
 * the user out and redirects to /login.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const baseHeaders = new Headers(init.headers || {});
  const auth = await getAuthHeaders();
  for (const [k, v] of Object.entries(auth)) baseHeaders.set(k, v);

  let res = await fetch(input, { ...init, headers: baseHeaders });
  if (res.status !== 401) return res;

  // First 401 -> force a fresh token and retry once.
  const refreshed = await refreshAccessToken();
  if (!refreshed) {
    handleUnrecoverableAuth();
    return res;
  }
  const retryHeaders = new Headers(init.headers || {});
  retryHeaders.set("Authorization", `Bearer ${refreshed}`);
  res = await fetch(input, { ...init, headers: retryHeaders });

  if (res.status === 401) {
    handleUnrecoverableAuth();
  }
  return res;
}
