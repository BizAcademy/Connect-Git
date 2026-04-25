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

async function getUploadsSize(): Promise<number> {
  try {
    const files = await fs.readdir(UPLOADS);
    let total = 0;
    for (const f of files) {
      try {
        const stat = await fs.stat(path.join(UPLOADS, f));
        total += stat.size;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

async function countUserImages(userId: string): Promise<number> {
  try {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
    const files = await fs.readdir(UPLOADS);
    return files.filter((f) => f.startsWith(`${safe}-`)).length;
  } catch {
    return 0;
  }
}

export async function saveImageDataUrl(userId: string, dataUrl: string): Promise<string> {
  const m = /^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("Format d'image invalide");
  let ext = m[1]!.toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  if (!ALLOWED_EXT.has(ext)) throw new Error("Type d'image non supporté");
  const buf = Buffer.from(m[2]!, "base64");
  if (buf.byteLength > MAX_BYTES) throw new SupportError("Image trop volumineuse (max 5 MB)", 413);

  await ensureDirs();

  // Per-user image quota
  const userCount = await countUserImages(userId);
  if (userCount >= MAX_IMAGES_PER_USER) {
    throw new SupportError("Quota d'images atteint (max 20 images par utilisateur)", 429);
  }

  // Global disk quota
  const totalSize = await getUploadsSize();
  if (totalSize + buf.byteLength > MAX_GLOBAL_UPLOADS_BYTES) {
    throw new SupportError("Espace de stockage global insuffisant, réessayez plus tard", 503);
  }

  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const filename = `${safe}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  await fs.writeFile(path.join(UPLOADS, filename), buf);
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

  // Delete orphan images
  let imagesRemoved = 0;
  let uploads: string[] = [];
  try { uploads = await fs.readdir(UPLOADS); } catch { uploads = []; }
  for (const f of uploads) {
    if (!referenced.has(f)) {
      try { await fs.unlink(path.join(UPLOADS, f)); imagesRemoved++; } catch {}
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
