-- SMM request idempotency. Safe to run after migration 001.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(128) NULL;

ALTER TABLE orders
  ADD UNIQUE KEY IF NOT EXISTS orders_user_client_request_uq (user_id, client_request_id);