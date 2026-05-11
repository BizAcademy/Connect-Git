-- Migration 004: refund tracking on orders table
-- Adds two columns used to record automatic and manual refunds when an SMM
-- order is canceled / refunded / failed by the provider. The PATCH that
-- writes refunded_at uses an "is.null" filter to guarantee idempotency
-- (no double refund possible).
--
-- Apply this in BOTH preview and production Supabase databases before
-- redeploying the API server.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_amount numeric;

CREATE INDEX IF NOT EXISTS idx_orders_refunded_at ON orders(refunded_at);
