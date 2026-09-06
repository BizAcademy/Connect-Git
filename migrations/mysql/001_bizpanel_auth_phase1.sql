-- MariaDB/MySQL phase-1 cutover. Apply only to a new/empty BizPanel schema.
-- UUIDs remain canonical Supabase UUID strings (CHAR(36)); money is integer minor units.
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  disabled_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY users_email_uq (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS profiles (
  user_id CHAR(36) NOT NULL,
  email VARCHAR(254) NOT NULL,
  username VARCHAR(64) NOT NULL,
  country VARCHAR(8) NULL,
  currency VARCHAR(8) NULL,
  balance_minor BIGINT NOT NULL DEFAULT 0,
  affiliate_earnings_minor BIGINT NOT NULL DEFAULT 0,
  avatar_url TEXT NULL,
  referral_code VARCHAR(32) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id), UNIQUE KEY profiles_username_uq (username),
  UNIQUE KEY profiles_referral_code_uq (referral_code),
  CONSTRAINT profiles_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id CHAR(36) NOT NULL, role VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL, revoked_at DATETIME NULL, ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY auth_sessions_token_hash_uq (token_hash),
  KEY auth_sessions_user_expiry_idx (user_id, expires_at),
  CONSTRAINT auth_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, provider_order_id VARCHAR(128) NULL,
  provider SMALLINT NOT NULL DEFAULT 1, service_id VARCHAR(128) NULL, link TEXT NULL,
  quantity INT NOT NULL, charge_minor BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  status VARCHAR(32) NOT NULL DEFAULT 'pending', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY orders_user_created_idx (user_id, created_at), KEY orders_status_idx (status),
  KEY orders_provider_order_idx (provider, provider_order_id),
  CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, provider_reference VARCHAR(191) NULL,
  amount_minor BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  status VARCHAR(32) NOT NULL DEFAULT 'pending', provider VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME NULL,
  PRIMARY KEY (id), UNIQUE KEY payments_reference_uq (provider_reference),
  KEY payments_user_created_idx (user_id, created_at), KEY payments_status_idx (status),
  CONSTRAINT payments_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, amount_minor BIGINT NOT NULL,
  balance_after_minor BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  type VARCHAR(32) NOT NULL, reference_type VARCHAR(32) NULL, reference_id CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY wallet_transactions_user_created_idx (user_id, created_at),
  KEY wallet_transactions_reference_idx (reference_type, reference_id),
  CONSTRAINT wallet_transactions_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS balance_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, user_id CHAR(36) NOT NULL,
  previous_balance_minor BIGINT NOT NULL, new_balance_minor BIGINT NOT NULL,
  reason VARCHAR(128) NOT NULL, actor_user_id CHAR(36) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY balance_audit_user_created_idx (user_id, created_at),
  CONSTRAINT balance_audit_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT balance_audit_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS referrals (
  id CHAR(36) NOT NULL, referrer_user_id CHAR(36) NOT NULL, referred_user_id CHAR(36) NOT NULL,
  code_used VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'pending',
  qualifying_payment_id CHAR(36) NULL, referrer_bonus_minor BIGINT NULL, referred_bonus_minor BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME NULL,
  PRIMARY KEY (id), UNIQUE KEY referrals_referred_uq (referred_user_id),
  KEY referrals_referrer_idx (referrer_user_id), KEY referrals_status_idx (status),
  CONSTRAINT referrals_referrer_fk FOREIGN KEY (referrer_user_id) REFERENCES users(id),
  CONSTRAINT referrals_referred_fk FOREIGN KEY (referred_user_id) REFERENCES users(id),
  CONSTRAINT referrals_payment_fk FOREIGN KEY (qualifying_payment_id) REFERENCES payments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tickets (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, subject VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY tickets_user_updated_idx (user_id, updated_at), KEY tickets_status_idx (status),
  CONSTRAINT tickets_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS earnings (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, order_id CHAR(36) NULL,
  amount_minor BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'XOF', provider SMALLINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY earnings_user_created_idx (user_id, created_at), KEY earnings_order_idx (order_id),
  CONSTRAINT earnings_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT earnings_order_fk FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;