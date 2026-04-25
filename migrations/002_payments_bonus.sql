-- Migration: Add deposit bonus tracking columns to the payments table.
--
-- Run this migration against your Supabase database using the SQL editor
-- in the Supabase dashboard or via psql with the connection string from
-- Supabase > Project Settings > Database > Connection string.
--
-- Apply once. Idempotent.
--
-- Business rule: any deposit ≥ 5 000 FCFA confirmed as `completed` grants
-- the user a bonus of 200 FCFA credited on top of the deposited amount.
-- The bonus is tracked per-payment and credited atomically with the main
-- amount by the server.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS bonus_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_status text NOT NULL DEFAULT 'not_eligible',
  ADD COLUMN IF NOT EXISTS bonus_credited_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS credited_at timestamptz NULL;

-- Allowed bonus_status values: 'not_eligible' | 'pending' | 'credited'
-- (We do not add a CHECK constraint to keep this migration permissive in
-- case future statuses are added.)

-- Backfill bonus_amount/bonus_status for existing deposits ≥ 5 000 FCFA.
-- Already-completed deposits are marked as 'pending' (bonus not yet given);
-- the admin can then manually credit them via the admin panel "Bonus" tab.
UPDATE payments
SET
  bonus_amount = 200,
  bonus_status = CASE
    WHEN bonus_status = 'credited' THEN 'credited'
    ELSE 'pending'
  END
WHERE amount >= 5000
  AND bonus_amount = 0;

-- Index for the admin "Bonus" listing (filter by bonus_status)
CREATE INDEX IF NOT EXISTS payments_bonus_status_idx ON payments (bonus_status);
CREATE INDEX IF NOT EXISTS payments_amount_idx ON payments (amount);
