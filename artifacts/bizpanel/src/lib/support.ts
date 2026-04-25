import { getAuthHeaders, authedFetch } from "./authFetch";

const fetch = authedFetch;

async function authHeaders(): Promise<HeadersInit> {
  return { ...(await getAuthHeaders()), "Content-Type": "application/json" };
}

export interface SupportMessage {
  id: string;
  ts: string;
  sender: "user" | "admin";
  sender_user_id: string;
  text: string;
  image_filename?: string;
}

export interface ThreadSummary {
  user_id: string;
  last_message: SupportMessage;
  message_count: number;
  unread_for_admin: number;
}

export async function fetchMyThread(): Promise<{ messages: SupportMessage[]; ttl_days: number }> {
  const headers = await authHeaders();
  const r = await fetch("/api/support/messages", { headers });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export async function sendMyMessage(text: string, image?: string): Promise<SupportMessage> {
  const headers = await authHeaders();
  const r = await fetch("/api/support/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ text, image }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).message;
}

export async function fetchUnreadCount(): Promise<number> {
  const headers = await authHeaders();
  const r = await fetch("/api/support/unread", { headers });
  if (!r.ok) return 0;
  return (await r.json()).count || 0;
}

export async function markUserRead(): Promise<void> {
  const headers = await authHeaders();
  await fetch("/api/support/mark-read", { method: "POST", headers });
}

export async function markAdminRead(userId: string): Promise<void> {
  const headers = await authHeaders();
  await fetch("/api/admin/support/mark-read", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function fetchAdminThreads(): Promise<ThreadSummary[]> {
  const headers = await authHeaders();
  const r = await fetch("/api/admin/support/threads", { headers });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).threads;
}

export async function fetchAdminThread(userId: string): Promise<{ messages: SupportMessage[]; ttl_days: number }> {
  const headers = await authHeaders();
  const r = await fetch(`/api/admin/support/messages?user_id=${encodeURIComponent(userId)}`, { headers });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export async function sendAdminReply(userId: string, text: string, image?: string): Promise<SupportMessage> {
  const headers = await authHeaders();
  const r = await fetch("/api/admin/support/reply", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: userId, text, image }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return (await r.json()).message;
}

// Helper: resize+compress an image File to a base64 JPEG/PNG data URL
export async function fileToCompressedDataUrl(file: File, maxDim = 1600, quality = 0.82): Promise<string> {
  if (file.size > 8 * 1024 * 1024) throw new Error("Image trop volumineuse (max 8 MB)");
  const bmp = await createImageBitmap(file);
  const ratio = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * ratio);
  const h = Math.round(bmp.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas non disponible");
  ctx.drawImage(bmp, 0, 0, w, h);
  const isPng = file.type === "image/png";
  return canvas.toDataURL(isPng ? "image/png" : "image/jpeg", isPng ? undefined : quality);
}

// Authenticated fetch of a support image as a blob URL — required because the
// endpoint requires an Authorization header.
export async function fetchSupportImageUrl(filename: string): Promise<string> {
  const headers = await getAuthHeaders();
  const r = await fetch(`/api/support/uploads/${encodeURIComponent(filename)}`, {
    headers,
  });
  if (!r.ok) throw new Error("Image introuvable");
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}
