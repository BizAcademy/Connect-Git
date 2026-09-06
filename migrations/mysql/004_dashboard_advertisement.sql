CREATE TABLE IF NOT EXISTS dashboard_advertisement (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  title VARCHAR(255) NULL,
  message_segments JSON NULL,
  image_data LONGTEXT NULL,
  contact_label VARCHAR(120) NULL,
  contact_url VARCHAR(500) NULL,
  updated_by CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT dashboard_advertisement_singleton CHECK (id = 1),
  CONSTRAINT dashboard_advertisement_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO dashboard_advertisement (id, active) VALUES (1, FALSE);