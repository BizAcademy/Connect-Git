import { Router, type Response } from "express";
import type mysql from "mysql2/promise";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getMysqlPool } from "../lib/mysql";
import { requireUser, type AuthedRequest } from "../lib/auth";
import { normalizeCode } from "../lib/referrals";
import { notificationsEnabled } from "../lib/notification-outbox";
import { consumeResetCode, consumeResetToken, queuePasswordReset, reserveResetRequest } from "../lib/password-reset";
import { ensureSignupVerification, queueSignupVerification, resendSignupVerification, verifySignupEmail } from "../lib/signup-verification";

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
  try {
    if (!notificationsEnabled()) {
      res.status(503).json({ error: "Inscription temporairement indisponible" });
      return;
    }
  } catch {
    res.status(503).json({ error: "Inscription temporairement indisponible" });
    return;
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
    await queueSignupVerification(connection, id);
    await connection.commit();
    return res.status(201).json({ verificationRequired: true, email });
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

router.post("/auth/verify-email", authLimiter, async (req: AuthedRequest, res): Promise<void> => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!emailPattern.test(email) || email.length > 254 || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Adresse email ou code invalide" });
    return;
  }
  let connection: mysql.PoolConnection | undefined;
  try {
    connection = await getMysqlPool().getConnection();
    await connection.beginTransaction();
    const [users] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM users WHERE email=? AND disabled_at IS NULL FOR UPDATE", [email],
    );
    const verified = users[0] ? await verifySignupEmail(connection, String(users[0].id), code) : false;
    if (!verified) {
      await connection.commit();
      res.status(400).json({ error: "Code non reconnu ou expiré. Vérifiez les 6 chiffres du dernier e-mail reçu." });
      return;
    }
    await connection.commit();
    res.json({ message: "Adresse email vérifiée. Vous pouvez maintenant vous connecter." });
  } catch {
    if (connection) await connection.rollback();
    req.log.error("email verification failed");
    res.status(503).json({ error: "Vérification temporairement indisponible" });
  } finally {
    connection?.release();
  }
});

router.post("/auth/resend-verification", authLimiter, async (req: AuthedRequest, res): Promise<void> => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!emailPattern.test(email) || email.length > 254) {
    res.status(400).json({ error: "Adresse email invalide" });
    return;
  }
  // Keep the response identical for unknown, verified and rate-limited accounts.
  const response = { message: "Si un compte non vérifié existe et que le délai d'une minute depuis le dernier code est écoulé, un nouveau code sera envoyé." };
  let connection: mysql.PoolConnection | undefined;
  try {
    if (!notificationsEnabled()) throw new Error("Notifications unavailable");
    connection = await getMysqlPool().getConnection();
    await connection.beginTransaction();
    const [users] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id, email_verified_at FROM users WHERE email=? AND disabled_at IS NULL FOR UPDATE", [email],
    );
    if (users[0] && !users[0].email_verified_at) {
      await resendSignupVerification(connection, String(users[0].id));
    }
    await connection.commit();
    res.json(response);
  } catch {
    if (connection) await connection.rollback();
    req.log.error("email verification resend failed");
    res.status(503).json({ error: "Vérification temporairement indisponible" });
  } finally {
    connection?.release();
  }
});

const forgotResponse = { message: "Si un compte existe pour cet email, vous recevrez un code de réinitialisation." };
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
        "SELECT id FROM users WHERE email = ? AND disabled_at IS NULL LIMIT 1 FOR UPDATE", [email],
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
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const token = req.body?.token;
  const password = req.body?.password;
  const passwordBytes = typeof password === "string" ? Buffer.byteLength(password, "utf8") : 0;
  const validPassword = typeof password === "string" && password.length >= 8 && passwordBytes <= 72;
  const legacyRequest = typeof token === "string";
  if (!validPassword || (legacyRequest
    ? !/^[A-Za-z0-9_-]{43}$/.test(token)
    : !emailPattern.test(email) || email.length > 254 || !/^\d{6}$/.test(code))) {
    res.status(400).json({ error: "Code ou mot de passe invalide." });
    return;
  }
  let connection: mysql.PoolConnection | undefined;
  try {
    connection = await getMysqlPool().getConnection();
    await connection.beginTransaction();
    let valid: boolean;
    if (legacyRequest) {
      valid = await consumeResetToken(connection, token, password);
    } else {
      const [users] = await connection.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM users WHERE email=? AND disabled_at IS NULL FOR UPDATE", [email],
      );
      valid = users[0] ? await consumeResetCode(connection, String(users[0].id), code, password) : false;
    }
    if (!valid) {
      // Wrong-code counters must commit, but all failures remain indistinguishable.
      await connection.commit();
      res.status(400).json({ error: "Code ou lien invalide ou expiré." });
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
  let connection: mysql.PoolConnection | undefined;
  try {
    connection = await getMysqlPool().getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT p.*, u.id, u.email, u.password_hash, u.email_verified_at,
        EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin') AS is_admin
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.email = ? AND u.disabled_at IS NULL LIMIT 1 FOR UPDATE`, [email],
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      await connection.rollback();
      return invalid();
    }
    if (!user.email_verified_at) {
      if (!notificationsEnabled()) {
        await connection.rollback();
        return res.status(503).json({ error: "Envoi du code de vérification indisponible. Réessayez plus tard." });
      }
      await ensureSignupVerification(connection, String(user.id));
      await connection.commit();
      return res.status(403).json({
        code: "EMAIL_VERIFICATION_REQUIRED",
        error: "Veuillez vérifier votre adresse email avant de vous connecter.",
      });
    }
    if (bcrypt.getRounds(user.password_hash) < BCRYPT_COST) {
      const replacement = await bcrypt.hash(password, BCRYPT_COST);
      await connection.execute(
        "UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?",
        [replacement, user.id, user.password_hash],
      );
    }
    const sessionToken = await createSessionToken(user.id, req, connection);
    await connection.commit();
    setSessionCookie(res, sessionToken);
    return res.json({ user: publicUser(user) });
  } catch (err) {
    if (connection) await connection.rollback();
    req.log.error({ err }, "login failed");
    return res.status(503).json({ error: "Connexion temporairement indisponible" });
  } finally {
    connection?.release();
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