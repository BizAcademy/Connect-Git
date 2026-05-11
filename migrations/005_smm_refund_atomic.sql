-- Migration 005: atomic SMM order refund RPC
--
-- Replaces the two-step PATCH+credit dance in the API server with a single
-- transactional Postgres function. This eliminates the residual risk of the
-- order being marked refunded while the balance credit is lost (e.g. if the
-- Node process crashes between the two HTTP calls).
--
-- Apply this in BOTH preview and production Supabase databases before
-- redeploying the API server.
--
-- Contract:
--   SELECT * FROM smm_refund_order('<order-uuid>', <amount-int>);
-- Returns one row:
--   refunded boolean      -- true if THIS call performed the refund
--   refunded_amount int   -- the amount that was credited (0 when not refunded)
--   user_id uuid          -- the owner of the order
--   new_balance numeric   -- the user's balance after the credit
--
-- Idempotency: if the order is already refunded (refunded_at IS NOT NULL),
-- the function returns refunded=false and does NOT credit the balance again.

CREATE OR REPLACE FUNCTION smm_refund_order(p_order_id uuid, p_amount integer)
RETURNS TABLE (
  refunded boolean,
  refunded_amount integer,
  user_id uuid,
  new_balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_already_refunded timestamptz;
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be a positive integer (got %)', p_amount;
  END IF;

  -- Lock the order row for the duration of the transaction so concurrent
  -- callers serialize on the same id.
  SELECT o.user_id, o.refunded_at
    INTO v_user_id, v_already_refunded
    FROM orders o
   WHERE o.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % not found', p_order_id;
  END IF;

  -- Already refunded → no-op (idempotent).
  IF v_already_refunded IS NOT NULL THEN
    SELECT p.balance INTO v_new_balance FROM profiles p WHERE p.user_id = v_user_id;
    RETURN QUERY SELECT false, 0, v_user_id, v_new_balance;
    RETURN;
  END IF;

  -- Mark the order refunded.
  UPDATE orders
     SET refunded_at = now(),
         refunded_amount = p_amount,
         updated_at = now()
   WHERE id = p_order_id;

  -- Credit the user's balance in the same transaction. If this UPDATE fails
  -- (e.g. profile missing) the entire transaction rolls back, leaving
  -- refunded_at NULL — so the next sync will retry safely.
  UPDATE profiles
     SET balance = COALESCE(balance, 0) + p_amount
   WHERE profiles.user_id = v_user_id
   RETURNING balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile for user % not found', v_user_id;
  END IF;

  RETURN QUERY SELECT true, p_amount, v_user_id, v_new_balance;
END;
$$;

-- Restrict EXECUTE to `service_role` only. The function is SECURITY DEFINER
-- so it runs with the owner's privileges (typically `postgres`), bypassing
-- RLS — exactly like the previous code path did via the service-role key.
-- Admin-only call sites are still gated by the API server's `requireAdmin`
-- middleware. End users never call this RPC directly.
REVOKE ALL ON FUNCTION smm_refund_order(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION smm_refund_order(uuid, integer) TO service_role;
