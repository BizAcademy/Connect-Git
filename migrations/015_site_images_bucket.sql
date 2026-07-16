-- 015_site_images_bucket.sql
-- Crée un bucket Supabase Storage public "site-images" pour héberger les
-- images uploadées depuis le panneau admin (onglet Contenu).
--
-- Règles d'accès (RLS sur storage.objects pour ce bucket) :
--   • READ  : public (tout visiteur du site peut afficher l'image)
--   • WRITE / UPDATE / DELETE : utilisateurs authentifiés AVEC le rôle "admin"
--     (vérifié via la fonction has_role déjà utilisée dans le projet)

-- 1. Bucket public
INSERT INTO storage.buckets (id, name, public)
VALUES ('site-images', 'site-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 2. Politiques RLS — on les recrée proprement (idempotent)
DROP POLICY IF EXISTS "site-images public read"   ON storage.objects;
DROP POLICY IF EXISTS "site-images admin insert"  ON storage.objects;
DROP POLICY IF EXISTS "site-images admin update"  ON storage.objects;
DROP POLICY IF EXISTS "site-images admin delete"  ON storage.objects;

CREATE POLICY "site-images public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'site-images');

CREATE POLICY "site-images admin insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'site-images'
    AND public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "site-images admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'site-images'
    AND public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "site-images admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'site-images'
    AND public.has_role(auth.uid(), 'admin')
  );
