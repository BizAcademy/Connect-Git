import { Router, type Response } from "express";
import type mysql from "mysql2/promise";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getMysqlPool } from "../lib/mysql";
import { requireUser, type AuthedRequest } from "../lib/auth";

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
  if (!emailPattern.test(email) || password.length < 8 || !username || username.length > 64 || country.length > 8) {
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
    const sessionToken = await createSessionToken(id, req, connection);
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

router.post("/auth/login", authLimiter, async (req: AuthedRequest, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const invalid = () => res.status(401).json({ error: "Email ou mot de passe incorrect" });
  if (!email || !password) return invalid();
  try {
    const [rows] = await getMysqlPool().execute<mysql.RowDataPacket[]>(
      `SELECT u.id, u.email, u.password_hash, p.username, p.country, p.currency, p.balance_minor,
        p.affiliate_earnings_minor, p.avatar_url, p.referral_code,
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
      `SELECT u.id, u.email, p.username, p.country, p.currency, p.balance_minor,
        p.affiliate_earnings_minor, p.avatar_url, p.referral_code,
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