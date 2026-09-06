import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { logger } from "../lib/logger";
import { requireUser, type AuthedRequest } from "../lib/auth";
import { getMysqlPool } from "../lib/mysql";
import { COUNTRY_CURRENCY } from "../lib/currency";

const router: IRouter = Router();
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(["jpg", "jpeg", "png", "webp"]);
const AVATAR_DIR = path.resolve(process.cwd(), "data", "avatars");

async function ensureProfile(userId: string): Promise<void> {
  await getMysqlPool().execute(
    `INSERT INTO profiles (user_id, email, username)
     SELECT id, email, LEFT(SUBSTRING_INDEX(email, '@', 1), 64) FROM users WHERE id = ?
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [userId],
  );
}

router.get("/profile", requireUser, async (req: AuthedRequest, res) => {
  try {
    const userId = String(req.userId);
    await ensureProfile(userId);
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
      `SELECT user_id, email, username, country, currency, balance_minor,
              affiliate_earnings_minor, avatar_url, referral_code
       FROM profiles WHERE user_id = ? LIMIT 1`, [userId],
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ error: "Profil introuvable" });
    return res.json({ ...p, balance: Number(p.balance_minor) / 100, affiliate_earnings: Number(p.affiliate_earnings_minor) / 100 });
  } catch (err) {
    logger.error({ err }, "profile read error");
    return res.status(503).json({ error: "Profil temporairement indisponible" });
  }
});

router.post("/profile/ensure", requireUser, async (req: AuthedRequest, res) => {
  try {
    await ensureProfile(String(req.userId));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "profile ensure error");
    return res.status(503).json({ error: "Profil non disponible" });
  }
});

router.post("/profile/country", requireUser, async (req: AuthedRequest, res) => {
  const country = String(req.body?.country || "").toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ error: "Code pays invalide (ISO2 attendu)" });
  const info = COUNTRY_CURRENCY[country];
  if (!info) return res.status(400).json({ error: "Pays non supporté" });
  try {
    const userId = String(req.userId);
    await ensureProfile(userId);
    await getMysqlPool().execute("UPDATE profiles SET country = ?, currency = ? WHERE user_id = ?", [country, info.currency, userId]);
    return res.json({ ok: true, country, currency: info.currency });
  } catch (err) {
    logger.error({ err }, "country update error");
    return res.status(503).json({ error: "Impossible de mettre à jour le pays" });
  }
});

router.post("/profile/avatar", requireUser, async (req: AuthedRequest, res) => {
  const dataUrl = typeof req.body?.image === "string" ? req.body.image : "";
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return res.status(400).json({ error: "Format d'image invalide" });
  let ext = match[1]!.toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  if (!ALLOWED.has(ext)) return res.status(400).json({ error: "Type non supporté" });
  const buffer = Buffer.from(match[2]!, "base64");
  if (!buffer.length || buffer.byteLength > MAX_BYTES) return res.status(413).json({ error: "Image trop volumineuse (max 2 MB)" });
  try {
    await fs.mkdir(AVATAR_DIR, { recursive: true });
    const userId = String(req.userId);
    const filename = `${userId}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
    await fs.writeFile(path.join(AVATAR_DIR, filename), buffer, { flag: "wx" });
    const avatarUrl = `/api/profile/avatar/${encodeURIComponent(filename)}`;
    await ensureProfile(userId);
    await getMysqlPool().execute("UPDATE profiles SET avatar_url = ? WHERE user_id = ?", [avatarUrl, userId]);
    return res.json({ avatar_url: avatarUrl });
  } catch (err) {
    logger.error({ err }, "avatar upload error");
    return res.status(500).json({ error: "Échec de l'upload" });
  }
});

router.get("/profile/avatar/:filename", async (req, res) => {
  const name = String(req.params.filename || "");
  if (!/^[0-9a-f-]{36}-[0-9a-f]{16}\.(jpg|png|webp)$/i.test(name)) return res.status(404).end();
  try {
    const ext = path.extname(name).slice(1);
    res.type(ext === "jpg" ? "image/jpeg" : `image/${ext}`);
    res.set("Cache-Control", "public, max-age=604800");
    return res.sendFile(path.join(AVATAR_DIR, name));
  } catch { return res.status(404).end(); }
});

router.delete("/profile/avatar", requireUser, async (req: AuthedRequest, res) => {
  try {
    const userId = String(req.userId);
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT avatar_url FROM profiles WHERE user_id = ?", [userId]);
    await getMysqlPool().execute("UPDATE profiles SET avatar_url = NULL WHERE user_id = ?", [userId]);
    const filename = String(rows[0]?.avatar_url || "").split("/").pop() || "";
    if (/^[0-9a-f-]{36}-[0-9a-f]{16}\.(jpg|png|webp)$/i.test(filename)) await fs.unlink(path.join(AVATAR_DIR, filename)).catch(() => undefined);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "avatar delete error");
    return res.status(500).json({ error: "Impossible de supprimer la photo" });
  }
});

export default router;