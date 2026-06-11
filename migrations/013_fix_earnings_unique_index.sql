-- Migration 013: Fix earnings unique index for multi-provider support
--
-- The original unique index (migration 003) was on provider_order_id alone.
-- With multi-provider support (migration 007), two different providers can
-- legitimately return the same numeric order ID. The old index silently
-- drops the second insert (via Prefer: resolution=ignore-duplicates),
-- causing lost earnings.
--
-- This migration replaces it with a composite unique index on
-- (provider, provider_order_id).
--
-- Idempotent: safe to run multiple times.

DROP INDEX IF EXISTS earnings_provider_order_idx;

CREATE UNIQUE INDEX IF NOT EXISTS earnings_provider_order_idx
  ON earnings (provider, provider_order_id);
