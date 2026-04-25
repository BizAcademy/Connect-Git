-- Migration: Restrict settings table access and purge payment secrets
--
-- Run this migration against your Supabase database using the SQL editor
-- in the Supabase dashboard or via psql with the connection string from
-- Supabase > Project Settings > Database > Connection string.
--
-- This migration:
--   1. Deletes the legacy SoleasPay credential rows that were previously
--      stored in the settings table. These credentials are now managed as
--      server-side environment variables (SOLEASPAY_API_KEY etc.) and must
--      never be stored in user-readable database tables.
--   2. Enables Row Level Security on the settings table so that
--      non-admin authenticated users cannot read any settings rows
--      directly (even via the Supabase client with their own JWT).
--
-- Apply once. Idempotent.

-- 1. Delete legacy payment credential rows
DELETE FROM settings
WHERE key IN (
  'soleaspay_api_key',
  'soleaspay_merchant_id',
  'soleaspay_callback_url'
);

-- 2. Enable RLS on the settings table (no-op if already enabled)
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- 3. Drop any existing permissive read policy so we start clean
DROP POLICY IF EXISTS "settings_read_all" ON settings;
DROP POLICY IF EXISTS "Allow authenticated read" ON settings;
DROP POLICY IF EXISTS "read_settings" ON settings;

-- 4. Admin-only read: only users with the 'admin' role can SELECT
CREATE POLICY "settings_admin_read" ON settings
  FOR SELECT
  USING (
    (SELECT has_role(auth.uid()::text, 'admin'))
  );

-- 5. Admin-only write: only admin users can INSERT / UPDATE / DELETE
CREATE POLICY "settings_admin_write" ON settings
  FOR ALL
  USING (
    (SELECT has_role(auth.uid()::text, 'admin'))
  )
  WITH CHECK (
    (SELECT has_role(auth.uid()::text, 'admin'))
  );
