-- Migration 008: AfribaPay Mobile Money deposit columns
--
-- Adds AfribaPay-specific tracking columns to the `payments` table:
--
--   operator        — Mobile Money operator (ORANGE, MTN, WAVE, MOOV, …)
--   country         — ISO country code of the phone number (CI, SN, CM, …)
--   phone_number    — subscriber's mobile number used for the payment
--   currency        — currency code returned by AfribaPay (XOF, XAF, …)
--   transaction_id  — AfribaPay's unique transaction identifier (maps to
--                     `id` in the AfribaPay callback payload)
--   order_id        — AfribaPay's internal order reference (maps to
--                     `order_id` / `commande_id` in the callback payload)
--
-- These columns are populated by the server when an AfribaPay payment
-- initiation succeeds and are updated/confirmed by the webhook callback.
-- They are exposed in the admin Transactions journal for reconciliation.
--
-- Apply in BOTH preview and production Supabase databases.
-- Idempotent: all statements use ADD COLUMN IF NOT EXISTS.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS operator       text          NULL,
  ADD COLUMN IF NOT EXISTS country        text          NULL,
  ADD COLUMN IF NOT EXISTS phone_number   text          NULL,
  ADD COLUMN IF NOT EXISTS currency       text          NULL DEFAULT 'XOF',
  ADD COLUMN IF NOT EXISTS transaction_id text          NULL,
  ADD COLUMN IF NOT EXISTS order_id       text          NULL;

-- Index for webhook lookups by AfribaPay transaction_id
CREATE INDEX IF NOT EXISTS idx_payments_transaction_id ON payments(transaction_id)
  WHERE transaction_id IS NOT NULL;

-- Index for webhook lookups by AfribaPay order_id
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id)
  WHERE order_id IS NOT NULL;
