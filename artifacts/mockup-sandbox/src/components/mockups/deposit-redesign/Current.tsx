import "./_group.css";
import DepositMethodPicker from "./_shared/DepositMethodPicker";

/** Isolated equivalent of the method === null branch in Deposit.tsx. */
export function Current() {
  return (
    <DepositMethodPicker
      onBack={() => {}}
      onContinue={() => {}}
    />
  );
}