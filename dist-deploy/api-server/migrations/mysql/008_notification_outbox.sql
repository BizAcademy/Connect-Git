CREATE TABLE IF NOT EXISTS notification_outbox (
  event_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  payload_encrypted LONGTEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NULL,
  lock_token CHAR(36) NULL,
  locked_until DATETIME(3) NULL,
  delivery_id VARCHAR(255) NULL,
  last_http_status SMALLINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  INDEX notification_queue (status, available_at),
  INDEX notification_lease (status, locked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;