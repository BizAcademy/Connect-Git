-- Distinguish newly issued OTP records from legacy link tokens; legacy rows
-- retain their original expiry and can be consumed until that time.
ALTER TABLE password_reset_tokens
  ADD COLUMN IF NOT EXISTS attempts INT UNSIGNED NOT NULL DEFAULT 0 AFTER used_at,
  ADD COLUMN IF NOT EXISTS reset_type ENUM('legacy', 'otp') NOT NULL DEFAULT 'legacy' AFTER attempts;