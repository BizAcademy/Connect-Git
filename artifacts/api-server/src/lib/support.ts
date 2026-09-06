import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { RowDataPacket } from "mysql2/promise";
import { logger } from "./logger";
import { getMysqlPool } from "./mysql";

export class SupportError extends Error { constructor(message: string, public readonly statusCode: number) { super(message); } }
export interface SupportMessage { id: string; ts: string; sender: "user" | "admin"; sender_user_id: string; text: string; image_filename?: string; }
export interface ThreadSummary { user_id: string; last_message: SupportMessage; message_count: number; unread_for_admin: number; }
const UPLOADS = path.resolve(process.cwd(), "data", "support", "uploads");
const TTL_DAYS = 7;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const msg = (r: RowDataPacket): SupportMessage => ({ id: String(r.id), ts: new Date(r.ts).toISOString(), sender: r.sender as "user" | "admin", sender_user_id: String(r.sender_user_id), text: String(r.text), image_filename: r.image_filename ?? undefined });

export async function readThread(userId: string): Promise<SupportMessage[]> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
    "SELECT id, ts, sender, sender_user_id, text, image_filename FROM support_messages WHERE user_id = ? AND ts >= DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY ts ASC", [userId],
  ); return rows.map(msg);
}
export async function appendMessage(userId: string, input: Omit<SupportMessage, "id" | "ts">): Promise<SupportMessage> {
  const text = String(input.text || "").slice(0, 4000).trim();
  if (!text && !input.image_filename) throw new SupportError("Message vide", 400);
  const [counts] = await getMysqlPool().execute<(RowDataPacket & { n: number })[]>(
    "SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND ts >= DATE_SUB(NOW(), INTERVAL 7 DAY)", [userId],
  );
  if (Number(counts[0]?.n || 0) >= 200) throw new SupportError("Limite de messages atteinte pour ce fil de support (max 200)", 429);
  const id = crypto.randomUUID();
  await getMysqlPool().execute("INSERT INTO support_messages (id, user_id, sender, sender_user_id, text, image_filename) VALUES (?, ?, ?, ?, ?, ?)", [id, userId, input.sender, input.sender_user_id, text, input.image_filename ?? null]);
  return { id, ts: new Date().toISOString(), sender: input.sender, sender_user_id: input.sender_user_id, text, image_filename: input.image_filename };
}
export async function markSeen(userId: string, who: "user" | "admin"): Promise<void> {
  const col = who === "user" ? "user_seen_at" : "admin_seen_at";
  await getMysqlPool().execute(`INSERT INTO support_thread_reads (user_id, ${col}) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE ${col} = NOW()`, [userId]);
}
export async function countUnreadForUser(userId: string): Promise<number> {
  const [rows] = await getMysqlPool().execute<(RowDataPacket & { n: number })[]>(
    `SELECT COUNT(*) AS n FROM support_messages m LEFT JOIN support_thread_reads r ON r.user_id=m.user_id
     WHERE m.user_id=? AND m.sender='admin' AND m.ts > COALESCE(r.user_seen_at, '1970-01-01') AND m.ts >= DATE_SUB(NOW(), INTERVAL 7 DAY)`, [userId],
  ); return Number(rows[0]?.n || 0);
}
export async function listThreads(): Promise<ThreadSummary[]> {
  const [rows] = await getMysqlPool().query<RowDataPacket[]>(
    `SELECT m.user_id, m.id, m.ts, m.sender, m.sender_user_id, m.text, m.image_filename,
       (SELECT COUNT(*) FROM support_messages c WHERE c.user_id=m.user_id AND c.ts >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS message_count,
       (SELECT COUNT(*) FROM support_messages u LEFT JOIN support_thread_reads r ON r.user_id=u.user_id WHERE u.user_id=m.user_id AND u.sender='user' AND u.ts > COALESCE(r.admin_seen_at, '1970-01-01') AND u.ts >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS unread_for_admin
     FROM support_messages m INNER JOIN (SELECT user_id, MAX(ts) last_ts FROM support_messages WHERE ts >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY user_id) x ON x.user_id=m.user_id AND x.last_ts=m.ts ORDER BY m.ts DESC`,
  ); return rows.map((r) => ({ user_id: String(r.user_id), last_message: msg(r), message_count: Number(r.message_count), unread_for_admin: Number(r.unread_for_admin) }));
}
export function uploadPath(filename: string): string | null {
  return /^[a-zA-Z0-9_-]{1,100}\.(jpg|jpeg|png|webp|gif)$/i.test(filename) ? path.join(UPLOADS, filename) : null;
}
export async function isOwnedBy(filename: string, userId: string): Promise<boolean> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT id FROM support_messages WHERE user_id=? AND image_filename=? LIMIT 1", [userId, filename]); return !!rows[0];
}
export async function saveImageDataUrl(userId: string, data: string): Promise<string> {
  const m = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(data);
  if (!m) throw new SupportError("Format d'image invalide", 400);
  const buffer = Buffer.from(m[2]!, "base64"); if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new SupportError("Image trop volumineuse (max 5 MB)", 413);
  const ext = m[1]!.toLowerCase() === "jpeg" ? "jpg" : m[1]!.toLowerCase();
  const name = `${userId.replace(/[^a-zA-Z0-9_-]/g, "")}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
  await fs.mkdir(UPLOADS, { recursive: true }); await fs.writeFile(path.join(UPLOADS, name), buffer, { flag: "wx" }); return name;
}
export async function downloadFromStorage(_filename: string): Promise<null> { return null; }

/** Removes expired support records and attachments from the local application store. */
export async function cleanupExpiredSupport(): Promise<void> {
  await getMysqlPool().execute(
    "DELETE FROM support_messages WHERE ts < DATE_SUB(NOW(), INTERVAL ? DAY)",
    [TTL_DAYS],
  );
  let files: string[];
  try {
    files = await fs.readdir(UPLOADS);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  const [rows] = await getMysqlPool().query<RowDataPacket[]>(
    "SELECT image_filename FROM support_messages WHERE image_filename IS NOT NULL",
  );
  const retained = new Set(rows.map((row) => String(row.image_filename)));
  await Promise.all(files.map(async (filename) => {
    if (!retained.has(filename)) await fs.unlink(path.join(UPLOADS, filename)).catch(() => undefined);
  }));
}

/** Starts the MySQL-backed retention task used by the API process. */
export function startSupportCleanup(): void {
  const run = () => {
    void cleanupExpiredSupport().catch((err) => {
      logger.error({ err }, "support retention cleanup failed");
    });
  };
  run();
  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref();
}