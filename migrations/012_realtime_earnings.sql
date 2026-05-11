-- Migration 012: Enable Supabase Realtime for the `earnings` table.
--
-- WHY
-- ---
-- The admin "Mes gains" dashboard subscribes to live changes on `earnings`
-- so that revenue cards, the "Évolution des Revenus" chart, and the
-- "Journal quotidien des gains" update the very moment a user places an
-- order — instead of waiting for the next polling cycle.
--
-- Without this migration the channel is created but Postgres never streams
-- INSERT/UPDATE events for `earnings`, so the dashboard appears static.
--
-- Idempotent: only adds the table if it isn't already part of the
-- supabase_realtime publication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'earnings'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.earnings';
  END IF;
END$$;

-- Make sure UPDATE events carry the full row (useful when consumers want
-- before/after diffs of gain_fcfa, status, etc.).
ALTER TABLE public.earnings REPLICA IDENTITY FULL;
