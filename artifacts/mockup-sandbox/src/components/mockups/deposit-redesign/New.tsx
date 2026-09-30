import "./_group.css";
import DepositMethodPicker from "./_shared/DepositMethodPicker";

/** Standalone copy of the deposit-method picker with inert navigation callbacks. */
export function New() {
  return (
    <DepositMethodPicker
      onBack={() => {}}
      onContinue={() => {}}
    />
  );
}