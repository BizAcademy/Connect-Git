-- Migration 010 : pays et devise par utilisateur
-- Ajoute country (ISO2) et currency (ISO4217) à profiles

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS country TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT NULL;

-- Index pour les lookups par pays (ex : rapports admin)
CREATE INDEX IF NOT EXISTS profiles_country_idx ON profiles (country);
