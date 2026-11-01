CREATE TABLE IF NOT EXISTS file_cleanup_queue (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  storage_mode ENUM('local', 'r2') NOT NULL,
  object_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error_code VARCHAR(64) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_cleanup_storage_key (storage_mode, object_key),
  KEY ix_file_cleanup_next_attempt (next_attempt_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
