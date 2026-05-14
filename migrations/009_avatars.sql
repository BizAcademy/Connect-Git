-- Migration 009 : photo de profil utilisateur
-- Ajoute la colonne avatar_url dans profiles
-- Crée le bucket public Supabase Storage "avatars"

-- 1. Colonne avatar_url dans profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL;

-- 2. Bucket Storage public "avatars" (à créer UNE seule fois)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  2097152,   -- 2 MB max par fichier
  ARRAY['image/jpeg','image/jpg','image/png','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 3. Politique RLS Storage : lecture publique (bucket public, lecture gratuite)
CREATE POLICY "avatars_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- 4. Politique RLS Storage : upload/update uniquement par le propriétaire
--    Le nom de fichier commence par l'UUID de l'utilisateur authentifié.
CREATE POLICY "avatars_owner_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = split_part(name, '-', 1)
  );

CREATE POLICY "avatars_owner_update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = split_part(name, '-', 1)
  );

CREATE POLICY "avatars_owner_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = split_part(name, '-', 1)
  );
