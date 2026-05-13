import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { requireUser, requireAdmin, type AuthedRequest } from "../lib/auth";
import {
  readThread,
  appendMessage,
  listThreads,
  saveImageDataUrl,
  uploadPath,
  isOwnedBy,
  markSeen,
  countUnreadForUser,
  downloadFromStorage,
  SupportError,
} from "../lib/support";
import { promises as fs } from "node:fs";
import path from "node:path";

const router: IRouter = Router();

// In-memory rate limiter for POST /support/messages
// Allows at most RATE_LIMIT_MAX messages per user within RATE_LIMIT_WINDOW_MS
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 30; // messages per window per user

interface RateEntry { count: number; windowStart: number }
const rateLimitMap = new Map<string, RateEntry>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

// User: get my conversation
router.get("/support/messages", requireUser, async (req: AuthedRequest, res) => {
  try {
    const msgs = await readThread(req.userId!);
    res.json({ messages: msgs, ttl_days: 7 });
  } catch (err) {
    logger.error({ err }, "support read error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// User: count unread admin messages (for sidebar badge)
router.get("/support/unread", requireUser, async (req: AuthedRequest, res) => {
  try {
    const count = await countUnreadForUser(req.userId!);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// User: mark conversation as read
router.post("/support/mark-read", requireUser, async (req: AuthedRequest, res) => {
  try {
    await markSeen(req.userId!, "user");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// User: send a message (with optional inline image)
router.post("/support/messages", requireUser, async (req: AuthedRequest, res) => {
  try {
    if (!checkRateLimit(req.userId!)) {
      return res.status(429).json({ error: "Trop de messages. Réessayez dans une heure." });
    }
    const text: string = String(req.body?.text || "").slice(0, 4000).trim();
    const imageDataUrl: string | undefined = req.body?.image;
    if (!text && !imageDataUrl) {
      return res.status(400).json({ error: "Message vide" });
    }
    let image_filename: string | undefined;
    if (imageDataUrl) {
      image_filename = await saveImageDataUrl(req.userId!, imageDataUrl);
    }
    const msg = await appendMessage(req.userId!, {
      sender: "user",
      sender_user_id: req.userId!,
      text,
      ...(image_filename ? { image_filename } : {}),
    });
    res.json({ message: msg });
  } catch (err) {
    logger.error({ err }, "support send error");
    const status = err instanceof SupportError ? err.statusCode : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

// User or Admin: serve image (admin can fetch any; user only their own)
router.get("/support/uploads/:filename", requireUser, async (req: AuthedRequest, res) => {
  const fname = req.params["filename"]!;
  const fp = uploadPath(fname);
  if (!fp) return res.status(400).end();

  // If not owned by the user, check admin
  if (!isOwnedBy(fname, req.userId!)) {
    // Admin check inline (mirrors requireAdmin)
    try {
      const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
      const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] || process.env["VITE_SUPABASE_ANON_KEY"];
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY environment variables must be set");
      }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/has_role`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${req.userToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ _user_id: req.userId, _role: "admin" }),
      });
      const ok = r.ok && (await r.json()) === true;
      if (!ok) return res.status(403).end();
    } catch {
      return res.status(403).end();
    }
  }

  // Primary source: Supabase Storage (persists across deploys)
  try {
    const obj = await downloadFromStorage(fname);
    if (obj) {
      res.setHeader("Content-Type", obj.contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.end(obj.buffer);
    }
  } catch (err) {
    logger.warn({ err, fname }, "support: storage download failed, trying local fallback");
  }

  // Fallback: legacy local-disk file (for images uploaded before migration 016)
  try {
    await fs.access(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(fp);
  } catch {
    res.status(404).end();
  }
});

// Admin: list all threads
router.get("/admin/support/threads", requireUser, requireAdmin, async (_req, res) => {
  try {
    res.json({ threads: await listThreads() });
  } catch (err) {
    logger.error({ err }, "support threads error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Admin: mark a thread as read
router.post("/admin/support/mark-read", requireUser, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "");
    if (!userId) return res.status(400).json({ error: "user_id requis" });
    await markSeen(userId, "admin");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Admin: get a specific user's thread
router.get("/admin/support/messages", requireUser, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.query["user_id"] || "");
    if (!userId) return res.status(400).json({ error: "user_id requis" });
    const msgs = await readThread(userId);
    res.json({ messages: msgs, ttl_days: 7 });
  } catch (err) {
    logger.error({ err }, "support admin read error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Admin: reply to a user
router.post("/admin/support/reply", requireUser, requireAdmin, async (req: AuthedRequest, res) => {
  try {
    const userId = String(req.body?.user_id || "");
    const text: string = String(req.body?.text || "").slice(0, 4000).trim();
    const imageDataUrl: string | undefined = req.body?.image;
    if (!userId) return res.status(400).json({ error: "user_id requis" });
    if (!text && !imageDataUrl) return res.status(400).json({ error: "Réponse vide" });

    let image_filename: string | undefined;
    if (imageDataUrl) {
      image_filename = await saveImageDataUrl(userId, imageDataUrl);
    }
    const msg = await appendMessage(userId, {
      sender: "admin",
      sender_user_id: req.userId!,
      text,
      ...(image_filename ? { image_filename } : {}),
    });
    res.json({ message: msg });
  } catch (err) {
    logger.error({ err }, "support reply error");
    const status = err instanceof SupportError ? err.statusCode : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

export default router;
