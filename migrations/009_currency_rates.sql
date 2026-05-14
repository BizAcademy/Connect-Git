-- Migration 009: Seed initial currency rate settings for non-CFA countries.
--
-- These rows allow the admin to configure conversion rates from the
-- "Devises" tab in the admin panel without modifying code or redeploying.
-- The API server uses the `currency_rate_<COUNTRY>` key pattern to look up
-- rates dynamically; a missing row falls back to the hardcoded default.
--
-- Apply this migration in the Supabase SQL editor.

INSERT INTO settings (key, value)
VALUES
  ('currency_rate_CD', '0.27'),    -- Congo RDC : 1 CDF = 0.27 FCFA
  ('currency_rate_GN', '0.0625'),  -- Guinée Conakry : 1 GNF = 0.0625 FCFA (1 FCFA = 16 GNF)
  ('currency_rate_GM', '6.6667')   -- Gambie : 1 GMD ≈ 6.6667 FCFA (1 FCFA ≈ 0.15 GMD)
ON CONFLICT (key) DO NOTHING;
