/** Public operation names only; safe to import into the supervisor. */
export const SABITO_OPERATIONS = [
  "deposit_status", "order_status", "order_refund_status", "deposit_bonus_status", "referral_code",
  "referral_reward_status", "referee_bonus_status", "wallet_balance", "wallet_movement_status",
] as const;
