-- Additive migration: legacy balances/payments/orders are untouched.
ALTER TABLE profiles ADD COLUMN balance_usd_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN wallet_credited VARCHAR(8) NOT NULL DEFAULT 'local';
ALTER TABLE orders ADD COLUMN wallet_charged VARCHAR(8) NOT NULL DEFAULT 'local';
ALTER TABLE orders ADD COLUMN revenue_fcfa_minor BIGINT NULL;