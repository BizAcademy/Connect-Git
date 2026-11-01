/** Only HTTPS provider checkout links; never execute an arbitrary URI scheme. */
export function checkoutUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export const checkoutKey = (userId: string) => `bb_pending_checkout:${userId}`;

export interface PendingCheckout {
  orderId: string;
  transactionId?: string;
  redirectUrl: string | null;
  amount: number;
  country: { code: string; name: string; currency?: string; prefix?: string; operators: never[] };
  operator: { code: string; name: string; otp_required: boolean; currency?: string };
}

/** Restoring UI context never confirms payment: the authenticated API does that. */
export function restoreCheckout(value: string | null): PendingCheckout | null {
  try {
    const data = JSON.parse(value || "null");
    if (!data || typeof data.orderId !== "string" || !data.orderId || data.orderId.length > 200
      || !Number.isFinite(data.amount) || data.amount < 500
      || typeof data.country?.code !== "string" || typeof data.country?.name !== "string"
      || typeof data.operator?.code !== "string" || typeof data.operator?.name !== "string") return null;
    return { ...data, redirectUrl: checkoutUrl(data.redirectUrl) };
  } catch { return null; }
}
