-- 006_realtime_orders.sql
-- Enable Supabase Realtime for the `orders` table so client UIs (user
-- MyOrders + admin Orders/Transactions) receive UPDATE/INSERT events the
-- moment a row changes — no polling, no manual refresh.
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
      AND tablename = 'orders'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.orders';
  END IF;
END$$;

-- Make sure UPDATE events carry enough information to drive UI diffing
-- (default REPLICA IDENTITY only includes the primary key in the OLD
-- record; FULL is needed when consumers want before/after diffs).
ALTER TABLE public.orders REPLICA IDENTITY FULL;
