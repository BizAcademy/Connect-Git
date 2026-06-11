-- Migration 011: Fix payments.status CHECK constraint to allow 'failed' and 'rejected'.
--
-- PROBLEM
-- -------
-- The original `payments_status_check` constraint (created via the Supabase
-- dashboard) only allows `('pending','completed')`. As a consequence, every
-- attempt by the API server to mark a stale or AfribaPay-rejected payment
-- as 'failed' or 'rejected' is rejected by Postgres with error code 23514:
--
--   new row for relation "payments" violates check constraint "payments_status_check"
--
-- This causes two visible bugs in the admin panel:
--
--   1. AfribaPay status ≠ site status — the deposit shows as "failed/rejected"
--      in the AfribaPay merchant dashboard but stays stuck on "pending" on the
--      site, because the PATCH that would synchronize the two is rejected.
--
--   2. Earnings dashboard charts ("Journal quotidien des gains",
--      "Évolution des Revenus") may appear empty for new periods because
--      no deposit can transition out of `pending`, so no balance is credited
--      and no orders can be placed.
--
-- FIX
-- ---
-- Drop the existing constraint (if present) and recreate it allowing the
-- full set of states the application code already uses:
--
--     pending   — initial state after deposit initiation
--     completed — credited successfully
--     failed    — AfribaPay reported failure (after retries / OTP timeout)
--     rejected  — admin or scanner rejected the payment
--     cancelled — user cancelled before payment
--     refunded  — admin issued a refund after credit
--
-- This is safe to apply at any time. Existing rows keep their current
-- status values; no data migration is needed.
--
-- HOW TO APPLY
-- ------------
-- Run in the Supabase SQL Editor (Dashboard → SQL Editor → New Query).
-- Idempotent — safe to run multiple times.

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'rejected', 'cancelled', 'refunded'));
