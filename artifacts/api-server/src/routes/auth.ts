import { Router, type Response } from "express";
import type mysql from "mysql2/promise";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getMysqlPool } from "../lib/mysql";
import { requireUser, type AuthedRequest } from "../lib/auth";
import { normalizeCode } from "../lib/referrals";
import { enqueueUserNotification, notificationAction, notificationsEnabled } from "../lib/notification-outbox";
import { consumeResetToken, queuePasswordReset, reserveResetRequest } from "../lib/password-reset";

const router = Router();
const COOKIE = "bb_session";
const SESSION_DAYS = 30;
const BCRYPT_COST = 12;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez plus tard." },
});

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

async function createSessionToken(
  userId: string,
  req: AuthedRequest,
  executor: mysql.Pool | mysql.PoolConnection = getMysqlPool(),
) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await executor.execute(
    "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), userId, tokenHash(token), expiresAt, (req.ip || "").slice(0, 64), (req.get("user-agent") || "").slice(0, 512)],
  );
  return token;
}

function publicUser(row: Record<string, unknown>) {
  return {
    id: row["id"],
    email: row["email"],
    profile: {
      user_id: row["id"], email: row["email"], username: row["username"],
      country: row["country"], currency: row["currency"], balance: Number(row["balance_minor"] || 0) / 100,
      balance_usd: Number(row["balance_usd_minor"] || 0) / 100,
      affiliate_earnings: Number(row["affiliate_earnings_minor"] || 0) / 100,
      avatar_url: row["avatar_url"], referral_code: row["referral_code"],
    },
    isAdmin: Boolean(row["is_admin"]),
  };
}

router.post("/auth/register", authLimiter, async (req: AuthedRequest, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const country = typeof req.body?.country === "string" ? req.body.country.trim().toUpperCase() : "";
  const referralCodeRaw = req.body?.referralCode ?? req.body?.referral_code;
  const referralCode = referralCodeRaw == null || referralCodeRaw === "" ? null : normalizeCode(referralCodeRaw);
  if (!emailPattern.test(email) || password.length < 8 || Buffer.byteLength(password, "utf8") > 72 || !username || username.length > 64 || country.length > 8 || (referralCodeRaw != null && !referralCode)) {
    return res.status(400).json({ error: "Informations d'inscription invalides" });
  }
  const id = crypto.randomUUID();
  const pool = getMysqlPool();
  let connection: mysql.PoolConnection | undefined;
  try {
    connection = await pool.getConnection();
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await connection.beginTransaction();
    await connection.execute("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", [id, email, passwordHash]);
    await connection.execute(
      "INSERT INTO profiles (user_id, email, username, country) VALUES (?, ?, ?, ?)",
      [id, email, username, country || null],
    );
    await connection.execute("INSERT INTO user_roles (user_id, role) VALUES (?, 'user')", [id]);
    if (referralCode) {
      const [owners] = await connection.execute<mysql.RowDataPacket[]>(
        "SELECT user_id FROM profiles WHERE referral_code=? FOR UPDATE", [referralCode],
      );
      const referrerId = owners[0] ? String(owners[0].user_id) : "";
      if (!referrerId || referrerId === id) {
        await connection.rollback();
        return res.status(400).json({ error: "Code de parrainage invalide" });
      }
      await connection.execute(
        "INSERT INTO referrals (id,referrer_user_id,referred_user_id,code_used,status) VALUES (?,?,?,?, 'pending')",
        [crypto.randomUUID(), referrerId, id, referralCode],
      );
    }
    const sessionToken = await createSessionToken(id, req, connection);
    if (notificationsEnabled()) {
      await enqueueUserNotification(connection, id, `signup-${id}`, {
        subject: "Bienvenue sur BUZZ BOOSTER",
        title: "Bienvenue sur BUZZ BOOSTER !",
        message: "Votre compte a bien été créé. Merci de nous rejoindre et bienvenue dans la communauté BUZZ BOOSTER !",
        category: "welcome",
      });
    }
    await connection.commit();
    setSessionCookie(res, sessionToken);
    return res.status(201).json({ user: publicUser({ id, email, username, country, balance_minor: 0, is_admin: false }) });
  } catch (err: unknown) {
    if (connection) await connection.rollback();
    if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Cette adresse email ou ce nom d'utilisateur est déjà utilisé" });
    }
    req.log.error({ err }, "registration failed");
    return res.status(503).json({ error: "Inscription temporairement indisponible" });
  } finally {
    connection?.release();
  }
});

const forgotResponse = { message: "Si un compte existe pour cet email, vous recevrez un lien de réinitialisation." };
const forgotUnavailable = { error: "Service de récupération temporairement indisponible" };

router.post("/auth/forgot-password", async (req: AuthedRequest, res): Promise<void> => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!emailPattern.test(email) || email.length > 254) {
    res.status(400).json({ error: "Adresse email invalide" });
    return;
  }
  // Check before looking up the user: misconfiguration must never reveal account existence.
  try {
    if (!notificationsEnabled()) throw new Error("Notifications unavailable");
    notificationAction("/reset-password");
  } catch {
    res.status(503).json(forgotUnavailable);
    return;
  }
  let connection: mysql.PoolConnection | undefined;
  try {
    connection = await getMysqlPool().getConnection();
    await connection.beginTransaction();
    const allowed = await reserveResetRequest(connection, email, req.ip || "unknown");
    if (allowed) {
      const [users] = await connection.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM users WHERE email = ? AND disabled_at IS NULL LIMIT 1", [email],
      );
      if (users[0]) await queuePasswordReset(connection, String(users[0].id));
    }
    await connection.commit();
    res.json(forgotResponse);
  } catch {
    if (connection) await connection.rollback();
    // No error objects here: mail payloads may contain reset secrets or recipients.
    req.log.error("password recovery request failed");
    res.status(503).json(forgotUnavailable);
  } finally {
    connection?.release();
  }
});

router.post("/auth/reset-password", authLimiter, async (req: AuthedRequest, res): Promise<void> => {
  const token = req.body?.token;
  const password = req.body?.password;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    res.status(400).json({ error: "Lien ou mot de passe invalide (8 caractères minimum)" });
    return;
  }
  let connection: mysql.PoolConnection | undefined;
  try {
    connection = await getMysqlPool().getConnection();
    await connection.beginTransaction();
    const valid = await consumeResetToken(connection, token, password);
    if (!valid) {
      await connection.rollback();
      res.status(400).json({ error: "Ce lien est invalide ou a expiré. Demandez-en un nouveau." });
      return;
    }
    await connection.commit();
    res.json({ message: "Mot de passe mis à jour. Connectez-vous avec votre nouveau mot de passe." });
  } catch {
    if (connection) await connection.rollback();
    req.log.error("password reset failed");
    res.status(503).json({ error: "Réinitialisation temporairement indisponible" });
  } finally {
    connection?.release();
  }
});

router.post("/auth/login", authLimiter, async (req: AuthedRequest, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const invalid = () => res.status(401).json({ error: "Email ou mot de passe incorrect" });
  if (!email || !password) return invalid();
  try {
    const [rows] = await getMysqlPool().execute<mysql.RowDataPacket[]>(
      `SELECT p.*, u.id, u.email, u.password_hash,
        EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin') AS is_admin
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.email = ? AND u.disabled_at IS NULL LIMIT 1`, [email],
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return invalid();
    if (bcrypt.getRounds(user.password_hash) < BCRYPT_COST) {
      const replacement = await bcrypt.hash(password, BCRYPT_COST);
      await getMysqlPool().execute("UPDATE users SET password_hash = ? WHERE id = ?", [replacement, user.id]);
    }
    const sessionToken = await createSessionToken(user.id, req);
    setSessionCookie(res, sessionToken);
    return res.json({ user: publicUser(user) });
  } catch (err) {
    req.log.error({ err }, "login failed");
    return res.status(503).json({ error: "Connexion temporairement indisponible" });
  }
});

router.post("/auth/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (typeof token === "string") {
    try { await getMysqlPool().execute("UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = ?", [tokenHash(token)]); }
    catch (err) { req.log.error({ err }, "logout revocation failed"); }
  }
  res.clearCookie(COOKIE, { httpOnly: true, secure: process.env["NODE_ENV"] === "production", sameSite: "lax", path: "/" });
  res.status(204).end();
});

router.get("/auth/me", requireUser, async (req: AuthedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: "Authentification requise" });
  try {
    const [rows] = await getMysqlPool().execute<mysql.RowDataPacket[]>(
      `SELECT p.*, u.id, u.email,
        EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin') AS is_admin
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ? LIMIT 1`, [req.userId],
    );
    if (!rows[0]) return res.status(401).json({ error: "Session invalide" });
    return res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    req.log.error({ err }, "me lookup failed");
    return res.status(503).json({ error: "Service d'authentification indisponible" });
  }
});

export default router;