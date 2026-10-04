-- Keep AfribaPAY-reported costs separate from fee_minor, which is the
-- application surcharge charged to the customer.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider_fee_minor BIGINT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provider_tax_minor BIGINT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provider_fee_total_minor BIGINT NULL DEFAULT NULL;