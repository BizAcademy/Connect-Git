-- Migration 007: Multi-provider SMM support
--
-- Adds:
--   1. `provider` column (integer, default 1) to `orders` — records which
--      SMM panel processed the order (1=SMMpanel, 2=GROWFOLLOWERS,
--      3=JustAnotherPannel, 4=Peakerr).
--   2. `provider` column (integer, default 1) to `earnings` — same semantics
--      as orders.provider, used to attribute gains to the right panel.
--   3. `smm_providers_config` table — admin-controlled display settings for
--      each provider (enabled, display_order, header_title, header_text).
--      Seeded with a default row for each of the four providers.
--
-- Apply in BOTH preview and production Supabase databases.
-- Idempotent: all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.

-- 1. Add `provider` column to orders
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS provider integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider);

-- 2. Add `provider` column to earnings
ALTER TABLE earnings
  ADD COLUMN IF NOT EXISTS provider integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_earnings_provider ON earnings(provider);

-- 3. Create smm_providers_config
CREATE TABLE IF NOT EXISTS smm_providers_config (
  provider_id    integer PRIMARY KEY CHECK (provider_id BETWEEN 1 AND 4),
  display_order  integer NOT NULL DEFAULT 1,
  enabled        boolean NOT NULL DEFAULT true,
  header_title   text    NOT NULL DEFAULT '',
  header_text    text    NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: no two providers share the same display_order slot
CREATE UNIQUE INDEX IF NOT EXISTS idx_smm_providers_config_display_order
  ON smm_providers_config(display_order);

-- Seed default rows (one per provider). If rows already exist, leave them alone.
INSERT INTO smm_providers_config (provider_id, display_order, enabled, header_title, header_text)
VALUES
  (1, 1, true,  'SMMpanel',          ''),
  (2, 2, true,  'GROWFOLLOWERS',      ''),
  (3, 3, true,  'JustAnotherPannel',  ''),
  (4, 4, false, 'Peakerr',            '')
ON CONFLICT (provider_id) DO NOTHING;

-- RLS: allow service_role full access; allow authenticated admins to read+write
-- via the has_role('admin') check used by the API server.
ALTER TABLE smm_providers_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "service_role_full_smm_providers_config"
  ON smm_providers_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "admin_read_smm_providers_config"
  ON smm_providers_config
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = auth.uid()
        AND user_roles.role = 'admin'
    )
  );

CREATE POLICY IF NOT EXISTS "admin_write_smm_providers_config"
  ON smm_providers_config
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = auth.uid()
        AND user_roles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
       WHERE user_roles.user_id = auth.uid()
         AND user_roles.role = 'admin'
    )
  );
