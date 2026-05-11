-- 016_support_uploads_bucket.sql
-- Persistent Supabase Storage bucket for support chat images.
-- Replaces the local-disk storage in the API server container, which was
-- wiped on every Plesk redeploy (causing "Image expirée" errors).
--
-- Bucket is PRIVATE: only the API server (service role) reads/writes.
-- Owner check + admin check happen in the API server before serving.

insert into storage.buckets (id, name, public)
values ('support-uploads', 'support-uploads', false)
on conflict (id) do update set public = false;

-- No RLS policies on the bucket: only the API server (service_role) can
-- access it. Clients always go through the API endpoint
-- /api/support/uploads/:filename which performs auth + ownership checks.
