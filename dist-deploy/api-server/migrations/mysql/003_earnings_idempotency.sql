-- Earnings are recognized only after provider-confirmed completion.  The
-- provider/id pair is the durable idempotency key shared by manual sync and
-- the background poller.
ALTER TABLE earnings
  ADD UNIQUE KEY IF NOT EXISTS earnings_provider_order_uq (provider, provider_order_id);