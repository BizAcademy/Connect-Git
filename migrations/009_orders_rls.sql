-- Migration 009: Ensure RLS SELECT policies exist on orders and payments
-- tables so authenticated users can read their own rows.
-- Safe to run multiple times (uses DO $$ ... IF NOT EXISTS pattern).

-- Enable RLS (idempotent)
ALTER TABLE orders  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- orders: users read their own rows
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'orders'
      AND policyname = 'users_select_own_orders'
  ) THEN
    CREATE POLICY users_select_own_orders ON orders
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- orders: users can insert their own rows (needed for order placement)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'orders'
      AND policyname = 'users_insert_own_orders'
  ) THEN
    CREATE POLICY users_insert_own_orders ON orders
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- orders: service-role bypass (already implicit, explicit for clarity)
-- Note: service_role always bypasses RLS, so no extra policy needed.

-- payments: users read their own rows
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'payments'
      AND policyname = 'users_select_own_payments'
  ) THEN
    CREATE POLICY users_select_own_payments ON payments
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- Ensure Supabase Realtime uses REPLICA IDENTITY FULL on orders
-- so row-level filters work correctly for INSERT events.
ALTER TABLE orders REPLICA IDENTITY FULL;
