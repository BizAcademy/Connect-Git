-- Migration 010: Remove GROWFOLLOWERS (provider id 2) and add ExoSupplier (id 5)
--
-- Background:
--   - Migration 007 created `smm_providers_config` with CHECK (provider_id BETWEEN 1 AND 4)
--     and seeded rows 1..4. A 5th provider (ExoSupplier) was added later.
--   - The application now retires provider 2 (GROWFOLLOWERS) entirely. Existing
--     `orders.provider = 2` and `earnings.provider = 2` rows are left intact so
--     historical attribution stays correct, but no new traffic is routed to id 2.
--
-- This migration:
--   1. Drops the legacy CHECK (1..4) constraint and replaces it with one that
--      accepts id 1, 3, 4, 5 (id 2 explicitly rejected).
--   2. Removes the provider 2 row from `smm_providers_config`.
--   3. Inserts the provider 5 row if missing (idempotent for fresh installs).
--   4. Renumbers `display_order` to be contiguous 1..4 across the four remaining
--      providers, preserving their relative order.
--
-- Idempotent: safe to re-run.

-- 1. Replace the CHECK constraint
ALTER TABLE smm_providers_config
  DROP CONSTRAINT IF EXISTS smm_providers_config_provider_id_check;

ALTER TABLE smm_providers_config
  ADD CONSTRAINT smm_providers_config_provider_id_check
  CHECK (provider_id IN (1, 3, 4, 5));

-- 2. Remove provider 2 (GROWFOLLOWERS)
DELETE FROM smm_providers_config WHERE provider_id = 2;

-- 3. Seed provider 5 (ExoSupplier) if missing
INSERT INTO smm_providers_config (provider_id, display_order, enabled, header_title, header_text)
VALUES (5, 4, true, 'ExoSupplier', '')
ON CONFLICT (provider_id) DO NOTHING;

-- 4. Renumber display_order to a contiguous 1..N sequence
WITH ranked AS (
  SELECT
    provider_id,
    ROW_NUMBER() OVER (ORDER BY display_order, provider_id) AS new_order
  FROM smm_providers_config
)
UPDATE smm_providers_config c
SET display_order = ranked.new_order
FROM ranked
WHERE c.provider_id = ranked.provider_id;
