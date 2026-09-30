import type { PoolConnection } from "mysql2/promise";
import { queueSignupVerification } from "./signup-verification";
import { requeuePendingNotificationsForEmailChange } from "./notification-outbox";

/**
 * Called inside the admin edit transaction, after locking the account.
 * New notifications resolve users.email after this update on the same connection.
 */
export async function updateAccountEmail(
  conn: PoolConnection, userId: string, currentEmail: string, nextEmail: string,
): Promise<boolean> {
  const changed = nextEmail !== currentEmail.toLowerCase();
  await conn.execute(
    "UPDATE users SET email=?, email_verified_at=IF(?, NULL, email_verified_at) WHERE id=?",
    [nextEmail, changed, userId],
  );
  await conn.execute("UPDATE profiles SET email=? WHERE user_id=?", [nextEmail, userId]);
  if (!changed) return false;

  // Codes and queued security messages for the previous address are no longer valid.
  await conn.execute("UPDATE password_reset_tokens SET used_at=NOW(3) WHERE user_id=? AND used_at IS NULL", [userId]);
  await conn.execute("DELETE FROM signup_email_verifications WHERE user_id=?", [userId]);
  await conn.execute(
    `UPDATE notification_outbox SET status='expired', payload_encrypted=NULL,
      lock_token=NULL, locked_until=NULL, finished_at=NOW(3)
     WHERE status='pending' AND (event_key LIKE ? OR event_key LIKE ?)`,
    [`signup-verification-${userId}-%`, `password-reset-${userId}-%`],
  );
  await requeuePendingNotificationsForEmailChange(conn, currentEmail, nextEmail);
  // Enqueue the new code after changing users.email, atomically with the address.
  await queueSignupVerification(conn, userId);
  await conn.execute("UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL", [userId]);
  return true;
}