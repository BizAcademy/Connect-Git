-- Reset secrets are never stored in plaintext. Throttle keys are SHA-256 digests
-- (of account email and IP); storing both prevents distributed account flooding.
CREATE TABLE IF NOT EXISTS password_reset_throttles (
  throttle_key CHAR(64) NOT NULL,
  next_allowed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (throttle_key),
  KEY password_reset_throttles_cleanup_idx (next_allowed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY password_reset_tokens_hash_uq (token_hash),
  KEY password_reset_tokens_user_idx (user_id, expires_at),
  KEY password_reset_tokens_expiry_idx (expires_at),
  CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;