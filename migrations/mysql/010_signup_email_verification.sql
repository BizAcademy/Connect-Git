-- Apply before deploying the registration/login code. Leave legacy accounts
-- unverified: the administrator exemption is checked from the current role at
-- login/session validation, not recorded as a permanent verification timestamp.
-- Migration 012 corrects installations that applied the earlier version of
-- this file, which grandfathered existing accounts.
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