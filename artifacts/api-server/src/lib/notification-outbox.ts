import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";
import { logger } from "./logger";
import {
  MailtrapNotificationClient, MailtrapNotificationError,
  validateMailtrapConfig, type NotificationEmail, type MailtrapDelivery,
} from "./mailtrap-notification-client";

type Content = Omit<NotificationEmail, "recipient_email" | "recipient_name">;
const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 90;

export function notificationsEnabled(): boolean {
  return validateMailtrapConfig() !== null;
}

/** Never derive password-reset destinations from an untrusted Host header. */
export function notificationAction(path: string): string {
  const raw = (process.env["NOTIFICATION_APP_URL"] ?? process.env["BCA_NOTIFICATION_APP_URL"])?.trim();
  if (!raw) throw new Error("NOTIFICATION_APP_URL is required for account emails");
  const base = new URL(raw);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("NOTIFICATION_APP_URL must be a trusted HTTPS application URL");
  }
  return new URL(path.replace(/^\/+/, ""), `${base.href.replace(/\/+$/, "")}/`).href;
}

// The queue contains recovery links and personal data. Encrypt it at rest;
// only the backend holding the configured token can decrypt queued messages.
function encryptionKey(): Buffer {
  const config = validateMailtrapConfig();
  if (!config) throw new Error("Notifications are not configured");
  return createHash("sha256").update("bizpanel-notification-outbox-v1\0").update(config.apiToken).digest();
}

export function encryptNotification(payload: NotificationEmail): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(part => part.toString("base64")).join(".");
}

export function decryptNotification(value: string): NotificationEmail {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted notification");
  const [iv, tag, body] = parts.map(part => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv!);
  decipher.setAuthTag(tag!);
  return JSON.parse(Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8"));
}

/** Use the business transaction: no HTTP call here, and no email before commit. */
export async function enqueueUserNotification(
  conn: PoolConnection, userId: string, key: string, content: Content,
): Promise<void> {
  if (!notificationsEnabled()) return;
  if (!/^[\x21-\x7E]{1,191}$/.test(key)) throw new Error("Invalid notification event key");
  const [rows] = await conn.execute<RowDataPacket[]>(
    "SELECT u.email, p.username FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=?",
    [userId],
  );
  const recipient = rows[0];
  if (!recipient || typeof recipient.email !== "string") throw new Error("Notification recipient unavailable");
  const payload: NotificationEmail = {
    ...content, recipient_email: recipient.email,
    ...(recipient.username ? { recipient_name: String(recipient.username) } : {}),
  };
  const expires = content.expires_at ? new Date(content.expires_at) : null;
  if (expires && !Number.isFinite(expires.getTime())) throw new Error("Invalid notification expiration");
  // Keep the FIRST frozen payload even if a caller repeats the logical event.
  await conn.execute(
    `INSERT INTO notification_outbox (event_key,payload_encrypted,expires_at)
     VALUES (?,?,?) ON DUPLICATE KEY UPDATE event_key=event_key`,
    [key, encryptNotification(payload), expires],
  );
}

export function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
}

export function isRetryableNotificationError(error: unknown): boolean {
  return error instanceof MailtrapNotificationError && error.retryable;
}

/** CAS leases also work on MariaDB versions without SKIP LOCKED. */
export async function dispatchNotifications(): Promise<void> {
  if (!notificationsEnabled()) return;
  const db = getMysqlPool();
  await db.execute(
    `UPDATE notification_outbox SET status='expired',payload_encrypted=NULL,
     lock_token=NULL,locked_until=NULL,finished_at=NOW(3)
     WHERE status IN ('pending','sending') AND expires_at<=NOW(3)
     AND (locked_until IS NULL OR locked_until<NOW(3))`,
  );
  const client = new MailtrapNotificationClient();
  for (let i = 0; i < 10; i++) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT event_key FROM notification_outbox
       WHERE ((status='pending' AND available_at<=NOW(3)) OR
       (status='sending' AND locked_until<NOW(3)))
       AND (expires_at IS NULL OR expires_at>NOW(3))
       ORDER BY available_at LIMIT 1`,
    );
    const key = rows[0]?.event_key;
    if (!key) return;
    const lease = randomUUID();
    const [claim] = await db.execute<ResultSetHeader>(
      `UPDATE notification_outbox SET status='sending',lock_token=?,
       locked_until=DATE_ADD(NOW(3),INTERVAL ${LEASE_SECONDS} SECOND),attempts=attempts+1
       WHERE event_key=? AND ((status='pending' AND available_at<=NOW(3)) OR
       (status='sending' AND locked_until<NOW(3)))
       AND (expires_at IS NULL OR expires_at>NOW(3))`,
      [lease, key],
    );
    if (!claim.affectedRows) continue;
    const [claimed] = await db.execute<RowDataPacket[]>(
      "SELECT payload_encrypted,attempts,expires_at FROM notification_outbox WHERE event_key=? AND lock_token=?",
      [key, lease],
    );
    const row = claimed[0];
    if (!row) continue;
    let delivery: MailtrapDelivery;
    try {
      const payload = decryptNotification(row.payload_encrypted);
      delivery = await client.sendEmail(payload);
    } catch (error) {
      // Never log provider errors, recipient data, URLs, or encrypted payloads.
      const retry = isRetryableNotificationError(error) && Number(row.attempts) < MAX_ATTEMPTS;
      const httpStatus = error instanceof MailtrapNotificationError ? error.httpStatus : null;
      const delay = retryDelaySeconds(Number(row.attempts));
      await db.execute(
        `UPDATE notification_outbox SET status=?,available_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),
         payload_encrypted=IF(?,payload_encrypted,NULL),lock_token=NULL,locked_until=NULL,
         last_http_status=?,finished_at=IF(?,NULL,NOW(3)) WHERE event_key=? AND lock_token=?`,
        [retry ? "pending" : "failed", delay, retry, httpStatus, retry, key, lease],
      );
      logger.warn({ eventKey: key, httpStatus, retry, attempt: row.attempts }, "Notification delivery deferred or failed");
      continue;
    }
    // A database outage after acceptance leaves a recoverable lease; Mailtrap
    // has no documented idempotency key, so a retry may deliver twice.
    await db.execute(
      `UPDATE notification_outbox SET status='sent',payload_encrypted=NULL,delivery_id=?,
       lock_token=NULL,locked_until=NULL,finished_at=NOW(3),last_http_status=NULL
       WHERE event_key=? AND lock_token=?`,
      [delivery.deliveryId, key, lease],
    );
    logger.info({ eventKey: key, deliveryId: delivery.deliveryId }, "Notification accepted");
  }
}

let started = false;
export function startNotificationWorker(): void {
  if (started || !notificationsEnabled()) return;
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await dispatchNotifications(); }
    catch { logger.error("Notification queue unavailable; check MySQL migrations and notification configuration"); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 5_000);
  timer.unref();
  void tick();
}