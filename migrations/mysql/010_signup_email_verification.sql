-- Apply before deploying the registration/login code. Existing accounts without
-- a verification record are grandfathered; new users retain NULL. This remains
-- safe to reapply after new users register, since they have a verification row.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at DATETIME(3) NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS signup_email_verifications (
  user_id CHAR(36) NOT NULL,
  code_hash CHAR(64) NULL,
  expires_at DATETIME(3) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at DATETIME(3) NOT NULL,
  hour_window_started_at DATETIME(3) NOT NULL,
  sends_in_window TINYINT UNSIGNED NOT NULL DEFAULT 1,
  consumed_at DATETIME(3) NULL,
  PRIMARY KEY (user_id),
  KEY signup_email_verifications_expiry_idx (expires_at),
  CONSTRAINT signup_email_verifications_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE users u LEFT JOIN signup_email_verifications sev ON sev.user_id=u.id
SET u.email_verified_at=NOW(3)
WHERE u.email_verified_at IS NULL AND sev.user_id IS NULL;