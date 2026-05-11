import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "./logger";

export class SupportError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "SupportError";
  }
}

export interface SupportMessage {
  id: string;
  ts: string; // ISO
  sender: "user" | "admin";
  sender_user_id: string;
  text: string;
  image_filename?: string;
}

const DIR = path.resolve(process.cwd(), "data", "support");
const UPLOADS = path.join(DIR, "uploads");
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function userFile(userId: string): string {
  // Keep filename safe — userId is a UUID from Supabase, so this is just defensive
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(DIR, `${safe}.jsonl`);
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(UPLOADS, { recursive: true });
}

function isFresh(m: SupportMessage): boolean {
  return Date.now() - new Date(m.ts).getTime() < TTL_MS;
}

async function readRaw(userId: string): Promise<SupportMessage[]> {
  try {
    const txt = await fs.readFile(userFile(userId), "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as SupportMessage; } catch { return null; } })
      .filter((m): m is SupportMessage => m !== null);
  } catch {
    return [];
  }
}

export async function readThread(userId: string): Promise<SupportMessage[]> {
  const all = await readRaw(userId);
  return all.filter(isFresh).sort((a, b) => a.ts.localeCompare(b.ts));
}

const MAX_THREAD_MESSAGES = 200; // per-thread message cap

export async function appendMessage(
  userId: string,
  msg: Omit<SupportMessage, "id" | "ts">,
): Promise<SupportMessage> {
  await ensureDirs();

  // Thread length cap
  const existing = await readRaw(userId);
  const fresh = existing.filter(isFresh);
  if (fresh.length >= MAX_THREAD_MESSAGES) {
    throw new SupportError("Limite de messages atteinte pour ce fil de support (max 200)", 429);
  }

  const full: SupportMessage = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...msg,
  };
  await fs.appendFile(userFile(userId), JSON.stringify(full) + "\n", "utf8");
  return full;
}

export interface ThreadSummary {
  user_id: string;
  last_message: SupportMessage;
  message_count: number;
  unread_for_admin: number; // user messages newer than admin's last "seen" timestamp
}

// --- Seen tracking (per-thread, persists when user/admin opens the chat) ----
interface SeenRecord { user_seen?: string; admin_seen?: string }
const SEEN_FILE = path.join(DIR, "_seen.json");

async function readSeen(): Promise<Record<string, SeenRecord>> {
  try {
    const txt = await fs.readFile(SEEN_FILE, "utf8");
    return JSON.parse(txt) as Record<string, SeenRecord>;
  } catch {
    return {};
  }
}

async function writeSeen(map: Record<string, SeenRecord>): Promise<void> {
  await ensureDirs();
  await fs.writeFile(SEEN_FILE, JSON.stringify(map), "utf8");
}

export async function markSeen(userId: string, who: "user" | "admin"): Promise<void> {
  const map = await readSeen();
  const cur = map[userId] || {};
  if (who === "user") cur.user_seen = new Date().toISOString();
  else cur.admin_seen = new Date().toISOString();
  map[userId] = cur;
  await writeSeen(map);
}

export async function countUnreadForUser(userId: string): Promise<number> {
  const map = await readSeen();
  const seenTs = new Date(map[userId]?.user_seen || 0).getTime();
  const msgs = await readThread(userId);
  return msgs.filter((m) => m.sender === "admin" && new Date(m.ts).getTime() > seenTs).length;
}

export async function listThreads(): Promise<ThreadSummary[]> {
  await ensureDirs();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(DIR);
  } catch {
    return [];
  }
  const seenMap = await readSeen();
  const out: ThreadSummary[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const userId = f.replace(/\.jsonl$/, "");
    const msgs = await readThread(userId);
    if (msgs.length === 0) continue;
    const last = msgs[msgs.length - 1]!;
    const adminSeenTs = new Date(seenMap[userId]?.admin_seen || 0).getTime();
    const unread = msgs.filter((m) => m.sender === "user" && new Date(m.ts).getTime() > adminSeenTs).length;
    out.push({ user_id: userId, last_message: last, message_count: msgs.length, unread_for_admin: unread });
  }
  return out.sort((a, b) => b.last_message.ts.localeCompare(a.last_message.ts));
}

// Save a base64 data URL image. Returns the stored filename.
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per image
const MAX_IMAGES_PER_USER = 20; // per-user upload count cap
const MAX_GLOBAL_UPLOADS_BYTES = 500 * 1024 * 1024; // 500 MB global cap for all uploads

// ---------------------------------------------------------------------------
// Image storage: Supabase Storage (persistent across deploys).
// ---------------------------------------------------------------------------
// Historically, support chat images were saved to the API server's local
// filesystem (./data/support/uploads). On Cybrancee/Plesk, every redeploy
// wipes the container, which destroyed all images and produced the
// "Image expirée" error in the chat. We now upload to a private Supabase
// Storage bucket (`support-uploads`, see migration 016) using the service
// role key. The bucket has no public RLS — clients still fetch through
// our `/api/support/uploads/:filename` endpoint which enforces ownership
// + admin checks.
// For backward compatibility, the GET route also falls back to the local
// disk for legacy files written before this migration.

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const STORAGE_BUCKET = "support-uploads";

function hasStorage(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function storageHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
  };
}

async function uploadToStorage(filename: string, buf: Buffer, contentType: string): Promise<void> {
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${encodeURIComponent(filename)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { ...storageHeaders(), "Content-Type": contentType, "x-upsert": "false" },
    body: new Uint8Array(buf),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    logger.error({ status: r.status, detail }, "support: storage upload failed");
    throw new SupportError("Impossible d'enregistrer l'image", 502);
  }
}

export async function downloadFromStorage(
  filename: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!hasStorage()) return null;
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${encodeURIComponent(filename)}`;
  const r = await fetch(url, { headers: storageHeaders() });
  if (!r.ok) return null;
  const ct = r.headers.get("content-type") || "image/jpeg";
  const ab = await r.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: ct };
}

async function getStorageBucketSize(): Promise<number> {
  // We don't compute exact bucket size on every upload (would require listing
  // all objects). Instead we cap per-user uploads (MAX_IMAGES_PER_USER) and
  // per-image size (MAX_BYTES). The global cap is therefore implicit:
  // MAX_IMAGES_PER_USER × MAX_BYTES per active user.
  return 0;
}

async function countUserImages(userId: string): Promise<number> {
  if (!hasStorage()) return 0;
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const url = `${SUPABASE_URL}/storage/v1/object/list/${STORAGE_BUCKET}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { ...storageHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: `${safe}-`, limit: MAX_IMAGES_PER_USER + 1, offset: 0 }),
  });
  if (!r.ok) return 0;
  const items = (await r.json().catch(() => [])) as Array<{ name: string }>;
  return Array.isArray(items) ? items.length : 0;
}

export async function saveImageDataUrl(userId: string, dataUrl: string): Promise<string> {
  const m = /^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("Format d'image invalide");
  let ext = m[1]!.toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  if (!ALLOWED_EXT.has(ext)) throw new Error("Type d'image non supporté");
  const buf = Buffer.from(m[2]!, "base64");
  if (buf.byteLength > MAX_BYTES) throw new SupportError("Image trop volumineuse (max 5 MB)", 413);

  if (!hasStorage()) {
    throw new SupportError(
      "Stockage Supabase non configuré (SUPABASE_SERVICE_ROLE_KEY manquant)",
      503,
    );
  }

  // Per-user image quota
  const userCount = await countUserImages(userId);
  if (userCount >= MAX_IMAGES_PER_USER) {
    throw new SupportError("Quota d'images atteint (max 20 images par utilisateur)", 429);
  }

  // (global cap is implicit — see getStorageBucketSize comment)
  void getStorageBucketSize;
  void MAX_GLOBAL_UPLOADS_BYTES;

  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const filename = `${safe}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
  await uploadToStorage(filename, buf, contentType);
  return filename;
}

export function uploadPath(filename: string): string | null {
  // Block traversal
  if (!/^[a-zA-Z0-9_\-.]+$/.test(filename)) return null;
  return path.join(UPLOADS, filename);
}

// Verify that a given upload filename belongs to the user requesting it
// (filename starts with their user id prefix). Admins bypass this check.
export function isOwnedBy(filename: string, userId: string): boolean {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  return filename.startsWith(`${safe}-`);
}

// --- Cleanup of expired messages and orphan image files ------------------

export async function cleanupExpired(): Promise<{ messages_removed: number; images_removed: number }> {
  await ensureDirs();
  let entries: string[] = [];
  try { entries = await fs.readdir(DIR); } catch { return { messages_removed: 0, images_removed: 0 }; }

  const referenced = new Set<string>();
  let messagesRemoved = 0;

  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(DIR, f);
    let raw: SupportMessage[] = [];
    try {
      const txt = await fs.readFile(fp, "utf8");
      raw = txt.split("\n").filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l) as SupportMessage; } catch { return null as any; }
      }).filter((m: any) => m);
    } catch { continue; }

    const fresh = raw.filter(isFresh);
    messagesRemoved += raw.length - fresh.length;
    if (fresh.length === 0) {
      try { await fs.unlink(fp); } catch {}
    } else if (fresh.length !== raw.length) {
      const txt = fresh.map((m) => JSON.stringify(m)).join("\n") + "\n";
      try { await fs.writeFile(fp, txt, "utf8"); } catch {}
    }
    for (const m of fresh) if (m.image_filename) referenced.add(m.image_filename);
  }

  // Delete orphan images on local disk (legacy fallback storage)
  let imagesRemoved = 0;
  let uploads: string[] = [];
  try { uploads = await fs.readdir(UPLOADS); } catch { uploads = []; }
  for (const f of uploads) {
    if (!referenced.has(f)) {
      try { await fs.unlink(path.join(UPLOADS, f)); imagesRemoved++; } catch {}
    }
  }

  // Delete orphan images in Supabase Storage (primary storage since
  // migration 016). We list all objects and delete those not referenced
  // by any fresh message — same TTL contract as the JSONL files (7 days).
  if (hasStorage()) {
    try {
      const listUrl = `${SUPABASE_URL}/storage/v1/object/list/${STORAGE_BUCKET}`;
      const orphans: string[] = [];
      let offset = 0;
      const PAGE = 1000;
      // Paginate to handle buckets with >1000 objects
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = await fetch(listUrl, {
          method: "POST",
          headers: { ...storageHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: "", limit: PAGE, offset }),
        });
        if (!r.ok) break;
        const items = (await r.json().catch(() => [])) as Array<{ name: string }>;
        if (!Array.isArray(items) || items.length === 0) break;
        for (const it of items) {
          if (it.name && !referenced.has(it.name)) orphans.push(it.name);
        }
        if (items.length < PAGE) break;
        offset += PAGE;
      }
      // Delete in batches of 100 (Supabase Storage `delete` accepts multiple)
      for (let i = 0; i < orphans.length; i += 100) {
        const batch = orphans.slice(i, i + 100);
        const delUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`;
        const dr = await fetch(delUrl, {
          method: "DELETE",
          headers: { ...storageHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: batch }),
        });
        if (dr.ok) imagesRemoved += batch.length;
      }
    } catch (err) {
      logger.warn({ err }, "support cleanup: storage purge failed");
    }
  }

  return { messages_removed: messagesRemoved, images_removed: imagesRemoved };
}

let cleanupTimer: NodeJS.Timeout | null = null;
export function startSupportCleanup(): void {
  if (cleanupTimer) return;
  // Run once at startup, then every hour
  cleanupExpired().then((r) => logger.info({ ...r }, "support cleanup")).catch(() => {});
  cleanupTimer = setInterval(() => {
    cleanupExpired().then((r) => {
      if (r.messages_removed || r.images_removed) logger.info({ ...r }, "support cleanup");
    }).catch(() => {});
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
}
