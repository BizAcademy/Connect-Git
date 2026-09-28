import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { validateBizConnectNotificationConfig } from "./bizconnect-notification-client";
import { enqueueUserNotification } from "./notification-outbox";

const CODE_LIFETIME_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

function codeHash(userId: string, code: string): string {
  const config = validateBizConnectNotificationConfig();
  if (!config) throw new Error("Notification configuration is required for signup verification");
  return crypto.createHmac("sha256", config.clientSecret)
    .update("bizconnect-signup-email-otp-v1\0").update(userId).update("\0").update(code).digest("hex");
}

function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

async function queueCode(conn: mysql.PoolConnection, userId: string, initial: boolean): Promise<void> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_LIFETIME_MS);
  if (initial) {
    await conn.execute(
      `INSERT INTO signup_email_verifications
       (user_id, code_hash, expires_at, attempts, sent_at, hour_window_started_at, sends_in_window)
       VALUES (?, ?, ?, 0, NOW(3), NOW(3), 1)`,
      [userId, codeHash(userId, code), expiresAt],
    );
  } else {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT sent_at > DATE_SUB(NOW(3), INTERVAL 60 SECOND) AS in_cooldown,
         hour_window_started_at > DATE_SUB(NOW(3), INTERVAL 1 HOUR) AS in_hour_window,
         sends_in_window
       FROM signup_email_verifications WHERE user_id=? FOR UPDATE`,
      [userId],
    );
    const prior = rows[0];
    if (!prior || Boolean(prior.in_cooldown) ||
        (Boolean(prior.in_hour_window) && Number(prior.sends_in_window) >= MAX_SENDS_PER_HOUR)) return;
    const continueWindow = Boolean(prior.in_hour_window);
    await conn.execute(
      `UPDATE signup_email_verifications SET code_hash=?, expires_at=?, attempts=0,
         sent_at=NOW(3), hour_window_started_at=IF(?, hour_window_started_at, NOW(3)),
         sends_in_window=IF(?, sends_in_window+1, 1), consumed_at=NULL
       WHERE user_id=?`,
      [codeHash(userId, code), expiresAt, continueWindow, continueWindow, userId],
    );
  }

  const eventId = crypto.randomUUID();
  if (!initial) {
    await conn.execute(
      `UPDATE notification_outbox SET status='expired', payload_encrypted=NULL,
         lock_token=NULL, locked_until=NULL, finished_at=NOW(3)
       WHERE status='pending' AND event_key LIKE ?`,
      [`signup-verification-${userId}-%`],
    );
  }
  await enqueueUserNotification(conn, userId, `signup-verification-${userId}-${eventId}`, {
    subject: "Vérifiez votre adresse email BUZZ BOOSTER",
    title: "Vérification de votre adresse email",
    message: `Saisissez le code ${code} pour vérifier votre adresse email. Ce code expire dans 10 minutes.`,
    category: "security",
    otp_code: code,
    expires_at: expiresAt.toISOString(),
  });
}

/** Create a first OTP and its frozen encrypted email within the signup transaction. */
export async function queueSignupVerification(conn: mysql.PoolConnection, userId: string): Promise<void> {
  await queueCode(conn, userId, true);
}

/** Resends are serialized per user and obey persistent DB-backed rate limits. */
export async function resendSignupVerification(conn: mysql.PoolConnection, userId: string): Promise<void> {
  await queueCode(conn, userId, false);
}

/** A valid code is consumed once, and verification/session revocation commit together. */
export async function verifySignupEmail(
  conn: mysql.PoolConnection, userId: string, code: string,
): Promise<boolean> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT code_hash, attempts, consumed_at, expires_at > NOW(3) AS not_expired
     FROM signup_email_verifications WHERE user_id=? FOR UPDATE`,
    [userId],
  );
  const record = rows[0];
  if (!record || record.consumed_at || Number(record.attempts) >= MAX_ATTEMPTS) return false;
  if (!Boolean(record.not_expired)) {
    await conn.execute(
      "UPDATE signup_email_verifications SET consumed_at=NOW(3) WHERE user_id=? AND consumed_at IS NULL",
      [userId],
    );
    return false;
  }

  const expected = Buffer.from(String(record.code_hash), "hex");
  const supplied = Buffer.from(codeHash(userId, code), "hex");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    await conn.execute(
      "UPDATE signup_email_verifications SET attempts=attempts+1 WHERE user_id=? AND consumed_at IS NULL",
      [userId],
    );
    return false;
  }

  await conn.execute("UPDATE users SET email_verified_at=NOW(3) WHERE id=? AND email_verified_at IS NULL", [userId]);
  await conn.execute(
    "UPDATE signup_email_verifications SET consumed_at=NOW(3), code_hash=NULL WHERE user_id=?",
    [userId],
  );
  await conn.execute(
    "UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL", [userId],
  );
  return true;
}