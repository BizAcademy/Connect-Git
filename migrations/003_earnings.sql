-- Migration: Move the admin "earnings" ledger onto Supabase.
--
-- Run this migration against your Supabase database using the SQL editor
-- in the Supabase dashboard or via psql with the connection string from
-- Supabase > Project Settings > Database > Connection string.
--
-- Apply once. Idempotent.
--
-- Why this migration exists
-- -------------------------
-- The `earnings` table records, for every SMM order placed by a user, the
-- amount paid by the user (FCFA), the cost of the underlying provider call
-- (USD + FCFA), and the resulting administrator gain (FCFA). It is the
-- source of truth for the "Mes gains administrateur" admin dashboard and
-- its daily journal.
--
-- Until now this table lived on the per-container PostgreSQL database
-- (`helium`), which means each deployment had its own EMPTY copy. Moving
-- the table to Supabase (the same database that already stores payments,
-- profiles, orders, etc.) ensures preview and published environments share
-- a single ledger that survives redeploys.
--
-- Security model
-- --------------
-- The earnings ledger contains administrator-level financial information.
-- It must NEVER be readable from the client (Vite). RLS is enabled with NO
-- policies for the anon / authenticated roles, so the only way to read or
-- write the table is via the API server using the service role key
-- (`SUPABASE_SERVICE_ROLE_KEY`), which bypasses RLS by design.
--
-- Schema mirrors `lib/db/src/schema/earnings.ts` so the existing TypeScript
-- types continue to work without modification.

CREATE TABLE IF NOT EXISTS earnings (
  id                  serial PRIMARY KEY,
  ts                  timestamptz NOT NULL DEFAULT now(),
  provider_order_id   text NOT NULL,
  user_id             text NOT NULL DEFAULT '',
  service             integer NOT NULL,
  service_name        text NOT NULL DEFAULT '',
  quantity            integer NOT NULL,
  rate_usd            double precision NOT NULL,
  user_price_fcfa     integer NOT NULL,
  provider_cost_usd   double precision NOT NULL,
  provider_cost_fcfa  integer NOT NULL,
  gain_fcfa           integer NOT NULL
);

-- Index on ts for the daily-journal queries (range + ORDER BY ts DESC)
CREATE INDEX IF NOT EXISTS earnings_ts_idx ON earnings (ts);

-- Unique index on provider_order_id enforces idempotency at the database
-- level: concurrent backfill or webhook invocations cannot create
-- duplicate earnings rows for the same provider order.
CREATE UNIQUE INDEX IF NOT EXISTS earnings_provider_order_idx
  ON earnings (provider_order_id);

-- Lock the table down: no anon / authenticated access at all. The API
-- server reads and writes via the service role key (which bypasses RLS).
ALTER TABLE earnings ENABLE ROW LEVEL SECURITY;

-- Drop any previously-created permissive policies so we start clean
DROP POLICY IF EXISTS "earnings_read_all"            ON earnings;
DROP POLICY IF EXISTS "earnings_authenticated_read"  ON earnings;
DROP POLICY IF EXISTS "earnings_admin_read"          ON earnings;
DROP POLICY IF EXISTS "earnings_admin_write"         ON earnings;

-- (No policies are created on purpose — only the service role can access.)
