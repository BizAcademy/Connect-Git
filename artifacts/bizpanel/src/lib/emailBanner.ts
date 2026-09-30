import { authedFetch } from "@/lib/authFetch";

export type EmailBannerSettings = {
  active: boolean;
  message: string;
};

export const EMAIL_BANNER_QUERY_KEY = ["email-availability-banner"] as const;
export const ADMIN_EMAIL_BANNER_QUERY_KEY = ["admin-email-availability-banner"] as const;

function parseBannerResponse(value: unknown): EmailBannerSettings {
  if (!value || typeof value !== "object") throw new Error("Réponse de bannière invalide");
  const envelope = value as { emailBanner?: unknown };
  const banner = envelope.emailBanner;
  if (!banner || typeof banner !== "object") throw new Error("Réponse de bannière invalide");
  const settings = banner as Record<string, unknown>;
  if (typeof settings.active !== "boolean" || typeof settings.message !== "string") {
    throw new Error("Réponse de bannière invalide");
  }
  return { active: settings.active, message: settings.message };
}

async function readBanner(path: string, authenticated = false): Promise<EmailBannerSettings> {
  const response = authenticated
    ? await authedFetch(path, { cache: "no-store" })
    : await fetch(path, { credentials: "include", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `Erreur serveur ${response.status}`);
  }
  return parseBannerResponse(body);
}

export function fetchEmailBanner(): Promise<EmailBannerSettings> {
  return readBanner("/api/email-banner");
}

export function fetchAdminEmailBanner(): Promise<EmailBannerSettings> {
  return readBanner("/api/admin/email-banner", true);
}

export async function saveAdminEmailBanner(settings: EmailBannerSettings): Promise<EmailBannerSettings> {
  const response = await authedFetch("/api/admin/email-banner", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `Erreur serveur ${response.status}`);
  }
  return parseBannerResponse(body);
}