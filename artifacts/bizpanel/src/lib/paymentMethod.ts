// Maps internal payment method codes (stored in the database) to user-facing
// French labels. Always use this helper anywhere a payment method is displayed
// to a user, so internal provider names never leak into the UI.
export function formatPaymentMethod(method?: string | null): string {
  if (!method) return "—";
  const m = String(method).toLowerCase().trim();
  if (m === "afribapay" || m === "soleaspay" || m === "mobile_money" || m === "mobile-money") {
    return "Mobile Money";
  }
  if (m === "card" || m === "carte") return "Carte bancaire";
  if (m === "bank" || m === "virement") return "Virement bancaire";
  return m.charAt(0).toUpperCase() + m.slice(1);
}
