import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type mysql from "mysql2/promise";
import { enqueueUserNotification } from "./notification-outbox";
import { validateMailtrapConfig } from "./mailtrap-notification-client";

const RESET_LIFETIME_MS = 10 * 60_000;
const ACCOUNT_COOLDOWN_MS = 5 * 60_000;
const IP_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 5;

export const hashResetToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

function codeHash(userId: string, code: string): string {
  const config = validateMailtrapConfig();
  if (!config) throw new Error("Notification configuration is required for password recovery");
  return crypto.createHmac("sha256", config.apiToken)
    .update("bizpanel-password-reset-otp-v1\0").update(userId).update("\0").update(code).digest("hex");
}

/** Reserve both limits atomically, including for emails without accounts. */
export async function reserveResetRequest(conn: mysql.PoolConnection, email: string, ip: string): Promise<boolean> {
  const limits = [
    { key: hashResetToken(`account:${email}`), duration: ACCOUNT_COOLDOWN_MS },
    { key: hashResetToken(`ip:${ip}`), duration: IP_COOLDOWN_MS },
  ].sort((a, b) => a.key.localeCompare(b.key));
  for (const limit of limits) {
    await conn.execute(
      "INSERT IGNORE INTO password_reset_throttles (throttle_key, next_allowed_at) VALUES (?, '1970-01-01 00:00:00')",
      [limit.key],
    );
  }
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    "SELECT throttle_key, next_allowed_at > NOW(3) AS blocked FROM password_reset_throttles WHERE throttle_key IN (?, ?) ORDER BY throttle_key FOR UPDATE",
    limits.map(limit => limit.key),
  );
  if (rows.length !== 2 || rows.some(row => Boolean(row.blocked))) return false;
  for (const limit of limits) {
    await conn.execute(
      "UPDATE password_reset_throttles SET next_allowed_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND) WHERE throttle_key = ?",
      [limit.duration * 1000, limit.key],
    );
  }
  return true;
}

export async function queuePasswordReset(conn: mysql.PoolConnection, userId: string): Promise<void> {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + RESET_LIFETIME_MS);
  await conn.execute(
    "UPDATE password_reset_tokens SET used_at=NOW(3) WHERE user_id=? AND reset_type='otp' AND used_at IS NULL",
    [userId],
  );
  await conn.execute(
    `UPDATE notification_outbox SET status='expired', payload_encrypted=NULL,
       lock_token=NULL, locked_until=NULL, finished_at=NOW(3)
     WHERE status='pending' AND event_key LIKE ?`,
    [`password-reset-${userId}-%`],
  );
  await conn.execute(
    "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, attempts, reset_type) VALUES (?, ?, ?, ?, 0, 'otp')",
    [id, userId, codeHash(userId, code), expiresAt],
  );
  await enqueueUserNotification(conn, userId, `password-reset-${userId}-${id}`, {
    subject: "Réinitialisation de votre mot de passe BUZZ BOOSTER",
    title: "Réinitialisez votre mot de passe",
    message: "Vous avez demandé la réinitialisation de votre mot de passe. Saisissez ce code dans l'application. Il expire dans 10 minutes. Si vous avez demandé plusieurs codes, seul celui de la demande la plus récente fonctionne. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.",
    category: "security",
    otp_code: code,
    expires_at: expiresAt.toISOString(),
  });
}

/** Wrong-code counters and successful consumption are serialized by the row lock. */
export async function consumeResetCode(
  conn: mysql.PoolConnection, userId: string, code: string, password: string,
): Promise<boolean> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT id, token_hash, attempts, expires_at, used_at
     FROM password_reset_tokens
     WHERE user_id=? AND reset_type='otp' AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId],
  );
  const record = rows[0];
  if (!record || record.used_at || Number(record.attempts) >= MAX_ATTEMPTS ||
      new Date(record.expires_at).getTime() <= Date.now()) return false;
  const expected = Buffer.from(String(record.token_hash), "hex");
  const supplied = Buffer.from(codeHash(userId, code), "hex");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    await conn.execute(
      "UPDATE password_reset_tokens SET attempts=attempts+1 WHERE id=? AND used_at IS NULL AND attempts < ?",
      [record.id, MAX_ATTEMPTS],
    );
    return false;
  }
  const [users] = await conn.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM users WHERE id = ? AND disabled_at IS NULL FOR UPDATE",
    [userId],
  );
  if (!users[0]) return false;
  const passwordHash = await bcrypt.hash(password, 12);
  await conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
  await conn.execute(
    "UPDATE password_reset_tokens SET used_at=NOW(3) WHERE user_id=? AND used_at IS NULL",
    [userId],
  );
  await conn.execute("UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL", [userId]);
  return true;
}

/** A token is consumed only together with the password change and session revocation. */
export async function consumeResetToken(conn: mysql.PoolConnection, token: string, password: string): Promise<boolean> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ? AND reset_type='legacy' FOR UPDATE",
    [hashResetToken(token)],
  );
  const record = rows[0];
  if (!record || record.used_at || new Date(record.expires_at).getTime() <= Date.now()) return false;
  const [users] = await conn.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM users WHERE id = ? AND disabled_at IS NULL FOR UPDATE",
    [record.user_id],
  );
  if (!users[0]) return false;
  const passwordHash = await bcrypt.hash(password, 12);
  await conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, record.user_id]);
  await conn.execute("UPDATE password_reset_tokens SET used_at = NOW(3) WHERE user_id = ? AND used_at IS NULL", [record.user_id]);
  await conn.execute("UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL", [record.user_id]);
  return true;
}