// Shared SMM status helpers used by both the HTTP routes and the background
// poller. Centralised so the two paths cannot drift on status normalisation
// or refund eligibility rules.

export const FINAL_REFUND_STATUSES = new Set([
  "canceled",
  "cancelled",
  "refunded",
  "failed",
]);

export function mapProviderStatus(s: string | undefined | null): string {
  const v = String(s || "").trim().toLowerCase();
  if (v === "completed" || v === "complete") return "completed";
  if (v === "partial") return "partial";
  if (v === "canceled" || v === "cancelled") return "canceled";
  if (v === "refunded") return "refunded";
  if (v === "failed" || v === "fail" || v === "error") return "failed";
  if (v === "in progress" || v === "processing") return "processing";
  if (v === "pending") return "pending";
  return v || "processing";
}

// Per the Peakerr API doc, "Default" and "Package" are the only service types
// that work with a plain (service, link, quantity) payload. Other types
// (Custom Comments, Mentions*, Comment Likes, Poll, Subscriptions, ...)
// require extra fields (comments, usernames, hashtags, answer_number, ...)
// that our generic order endpoint does not collect, so attempting to order
// them would lead to provider rejection and a manual refund.
//
// We use an allowlist on purpose: any new or renamed type that Peakerr (or
// another panel) introduces will default to "unsupported" and stay hidden
// from the catalogue + rejected at /smm/order until we explicitly support it.
// That is the safe default — it costs us a missing service, never a refund.
//
// Providers that omit the `type` field entirely are tolerated and assumed
// supported; this matches the historical behaviour of provider 1/2/3 which
// don't always populate it.
export const SUPPORTED_SERVICE_TYPES = new Set(["default", "package"]);

export function isSupportedServiceType(t: unknown): boolean {
  if (t == null || t === "") return true; // tolerate providers that omit type
  const v = String(t).trim().toLowerCase();
  return SUPPORTED_SERVICE_TYPES.has(v);
}
