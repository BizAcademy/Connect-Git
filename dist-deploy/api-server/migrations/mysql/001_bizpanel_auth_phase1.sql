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
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
  -- provider_order_id is the canonical external id. external_order_id remains
  -- during the cutover because it is part of existing browser/API contracts.
  provider_order_id VARCHAR(128) NULL, external_order_id VARCHAR(128) NULL,
  provider SMALLINT NOT NULL DEFAULT 1, service_id VARCHAR(128) NULL,
  service_name VARCHAR(512) NULL, service_category VARCHAR(512) NULL, link TEXT NULL,
  quantity INT NOT NULL, charge_minor BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  balance_before_minor BIGINT NULL, balance_after_minor BIGINT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  refunded_at DATETIME NULL, refunded_amount_minor BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY orders_user_created_idx (user_id, created_at), KEY orders_status_idx (status),
  UNIQUE KEY orders_provider_external_uq (provider, provider_order_id),
  KEY orders_provider_order_idx (provider, external_order_id), KEY orders_refunded_at_idx (refunded_at),
  CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
  -- provider_reference/reference and method/provider preserve the old API
  -- vocabulary; all monetary values below are integer minor units.
  provider_reference VARCHAR(191) NULL, reference VARCHAR(191) NULL,
  amount_minor BIGINT NOT NULL, fee_minor BIGINT NOT NULL DEFAULT 0,
  charge_minor BIGINT NULL, bonus_amount_minor BIGINT NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  status VARCHAR(32) NOT NULL DEFAULT 'pending', provider VARCHAR(64) NULL,
  method VARCHAR(64) NULL, order_id VARCHAR(191) NULL, transaction_id VARCHAR(191) NULL,
  country VARCHAR(8) NULL, operator VARCHAR(96) NULL, phone_number VARCHAR(64) NULL,
  credited_at DATETIME NULL, completed_at DATETIME NULL,
  bonus_status VARCHAR(32) NOT NULL DEFAULT 'not_eligible', bonus_credited_at DATETIME NULL,
  balance_before_minor BIGINT NULL, balance_after_minor BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY payments_reference_uq (provider_reference),
  UNIQUE KEY payments_order_id_uq (order_id), KEY payments_transaction_idx (transaction_id),
  KEY payments_user_created_idx (user_id, created_at), KEY payments_status_idx (status),
  KEY payments_bonus_status_idx (bonus_status),
  CONSTRAINT payments_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, amount_minor BIGINT NOT NULL,
  balance_after_minor BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  type VARCHAR(32) NOT NULL, reference_type VARCHAR(32) NULL, reference_id CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY wallet_transactions_user_created_idx (user_id, created_at),
  UNIQUE KEY wallet_transactions_reference_uq (user_id, reference_type, reference_id, type),
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
  qualifying_payment_id CHAR(36) NULL, qualifying_amount_minor BIGINT NULL,
  referrer_bonus_minor BIGINT NULL, referred_bonus_minor BIGINT NULL,
  referrer_credited_at DATETIME NULL, referred_credited_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME NULL,
  PRIMARY KEY (id), UNIQUE KEY referrals_referred_uq (referred_user_id),
  KEY referrals_referrer_idx (referrer_user_id), KEY referrals_status_idx (status),
  CONSTRAINT referrals_referrer_fk FOREIGN KEY (referrer_user_id) REFERENCES users(id),
  CONSTRAINT referrals_referred_fk FOREIGN KEY (referred_user_id) REFERENCES users(id),
  CONSTRAINT referrals_payment_fk FOREIGN KEY (qualifying_payment_id) REFERENCES payments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tickets (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
  short_code VARCHAR(32) NOT NULL, ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  order_external_id VARCHAR(128) NULL, order_local_id CHAR(36) NULL,
  provider_id SMALLINT NULL, service_name VARCHAR(512) NULL,
  action_type VARCHAR(32) NOT NULL, message TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open', admin_response TEXT NULL,
  resolved_at DATETIME NULL, resolved_by CHAR(36) NULL,
  cancel_executed BOOLEAN NOT NULL DEFAULT FALSE, cancel_executed_at DATETIME NULL,
  refunded BOOLEAN NOT NULL DEFAULT FALSE, refunded_amount_minor BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY tickets_short_code_uq (short_code),
  KEY tickets_user_updated_idx (user_id, updated_at), KEY tickets_status_ts_idx (status, ts),
  CONSTRAINT tickets_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT tickets_order_fk FOREIGN KEY (order_local_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT tickets_resolved_by_fk FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS earnings (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, order_id CHAR(36) NULL,
  provider_order_id VARCHAR(191) NOT NULL, service INT NOT NULL DEFAULT 0,
  service_name VARCHAR(512) NOT NULL DEFAULT '', quantity INT NOT NULL DEFAULT 0,
  rate_usd DECIMAL(18,8) NOT NULL DEFAULT 0, user_price_minor BIGINT NOT NULL,
  provider_cost_usd DECIMAL(18,8) NOT NULL DEFAULT 0, provider_cost_minor BIGINT NOT NULL DEFAULT 0,
  gain_minor BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  provider SMALLINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY earnings_provider_order_uq (provider, provider_order_id),
  KEY earnings_user_created_idx (user_id, created_at), KEY earnings_order_idx (order_id),
  CONSTRAINT earnings_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT earnings_order_fk FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Non-secret operational configuration. Credentials belong exclusively in
-- environment secrets, never in this table.
CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(191) NOT NULL, `value` TEXT NOT NULL,
  updated_by CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`), CONSTRAINT settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS site_content (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, section VARCHAR(96) NOT NULL,
  `key` VARCHAR(191) NOT NULL, label VARCHAR(255) NOT NULL DEFAULT '',
  `value` TEXT NOT NULL, type VARCHAR(32) NOT NULL DEFAULT 'text',
  updated_by CHAR(36) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY site_content_key_uq (`key`), KEY site_content_section_idx (section),
  CONSTRAINT site_content_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS smm_pricing (
  provider SMALLINT NOT NULL, service_id VARCHAR(128) NOT NULL,
  price_minor BIGINT NOT NULL DEFAULT 0, hidden BOOLEAN NOT NULL DEFAULT FALSE,
  featured BOOLEAN NOT NULL DEFAULT FALSE, updated_by CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, service_id),
  CONSTRAINT smm_pricing_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS smm_providers_config (
  provider_id SMALLINT NOT NULL, display_order SMALLINT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE, header_title VARCHAR(120) NOT NULL DEFAULT '',
  header_text VARCHAR(500) NOT NULL DEFAULT '', updated_by CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_id), UNIQUE KEY smm_provider_display_order_uq (display_order),
  CONSTRAINT smm_provider_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS referral_visits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, code VARCHAR(32) NOT NULL,
  visitor_key VARCHAR(191) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY referral_visits_code_idx (code),
  UNIQUE KEY referral_visits_dedupe_uq (code, visitor_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Support is retained for seven days by application policy. Message bodies and
-- attachment metadata are relational; attachment bytes stay in configured
-- application object/file storage, never in this table.
CREATE TABLE IF NOT EXISTS support_messages (
  id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sender VARCHAR(16) NOT NULL, sender_user_id CHAR(36) NOT NULL,
  text TEXT NOT NULL, image_filename VARCHAR(255) NULL,
  PRIMARY KEY (id), KEY support_messages_user_ts_idx (user_id, ts),
  CONSTRAINT support_messages_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT support_messages_sender_fk FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_thread_reads (
  user_id CHAR(36) NOT NULL, user_seen_at DATETIME NULL, admin_seen_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT support_thread_reads_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;