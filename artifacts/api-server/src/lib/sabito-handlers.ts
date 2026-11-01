import { createGuard, databaseRead, type SabitoRead } from "./sabito-read";
import { depositStatus, depositBonusStatus } from "./sabito-deposits";
import { orderStatus, orderRefundStatus, providerStatusRead, type ProviderStatusRead } from "./sabito-orders";
import { referralCode, referralRewardStatus, walletBalance, walletMovementStatus } from "./sabito-wallet";

export type { SabitoJob, SabitoRead, SabitoResult } from "./sabito-read";
export { SABITO_OPERATIONS } from "./sabito-operations";

export function createSabitoHandlers(query: SabitoRead = databaseRead, providerRead: ProviderStatusRead = providerStatusRead) {
  const guard = createGuard(query);
  return {
    deposit_status: guard(depositStatus),
    order_status: guard(ctx => orderStatus(ctx, providerRead)),
    order_refund_status: guard(orderRefundStatus),
    deposit_bonus_status: guard(depositBonusStatus),
    referral_code: guard(referralCode),
    referral_reward_status: guard(ctx => referralRewardStatus(ctx, false)),
    referee_bonus_status: guard(ctx => referralRewardStatus(ctx, true)),
    wallet_balance: guard(walletBalance),
    wallet_movement_status: guard(walletMovementStatus),
    // No account_activation (not a Buzz Booster feature) or withdrawal_status.
  };
}
