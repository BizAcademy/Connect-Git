/**
 * Frontend currency utilities — mirrors the server-side lib.
 * Balance is always stored in FCFA; these helpers convert for display.
 */

export interface CurrencyInfo {
  currency: string;
  fcfaPerUnit: number;
  symbol: string;
}

export const COUNTRY_CURRENCY: Record<string, CurrencyInfo> = {
  // XOF zone (1:1)
  BJ: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  BF: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  CI: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  GW: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  ML: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  NE: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  SN: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  TG: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  // XAF zone (1:1)
  CM: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  CF: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  TD: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  CG: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  GQ: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  GA: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  // Non-CFA
  CD: { currency: "CDF", fcfaPerUnit: 0.27,   symbol: "CDF" },
  GN: { currency: "GNF", fcfaPerUnit: 0.0625, symbol: "GNF" },
  GM: { currency: "GMD", fcfaPerUnit: 6.6667, symbol: "GMD" },
};

const DEFAULT: CurrencyInfo = { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" };

export function getCurrencyInfo(country: string | null | undefined): CurrencyInfo {
  if (!country) return DEFAULT;
  return COUNTRY_CURRENCY[country.toUpperCase()] ?? DEFAULT;
}

/**
 * Convert FCFA balance to local currency for display.
 * e.g. 270 FCFA → 1 000 CDF (for a Congolais DRC user)
 */
export function fromFcfa(fcfa: number, country: string | null | undefined): number {
  const info = getCurrencyInfo(country);
  if (info.fcfaPerUnit === 1) return fcfa;
  return Math.round(fcfa / info.fcfaPerUnit);
}

/**
 * Format a balance in FCFA for display in the user's local currency.
 * Returns a string like "1 000 CDF" or "5 300 F CFA"
 */
export function formatBalance(fcfa: number, country: string | null | undefined): string {
  const info = getCurrencyInfo(country);
  const local = fromFcfa(fcfa, country);
  return `${local.toLocaleString("fr-FR")} ${info.symbol}`;
}

/** All countries shown at registration (AfribaPay supported) */
export const SIGNUP_COUNTRIES: { code: string; name: string; currency: string }[] = [
  { code: "BJ", name: "Bénin", currency: "XOF" },
  { code: "BF", name: "Burkina Faso", currency: "XOF" },
  { code: "CM", name: "Cameroun", currency: "XAF" },
  { code: "CF", name: "Centrafrique", currency: "XAF" },
  { code: "CG", name: "Congo-Brazzaville", currency: "XAF" },
  { code: "CD", name: "Congo RDC", currency: "CDF" },
  { code: "CI", name: "Côte d'Ivoire", currency: "XOF" },
  { code: "GA", name: "Gabon", currency: "XAF" },
  { code: "GM", name: "Gambie", currency: "GMD" },
  { code: "GN", name: "Guinée Conakry", currency: "GNF" },
  { code: "GW", name: "Guinée-Bissau", currency: "XOF" },
  { code: "GQ", name: "Guinée Équatoriale", currency: "XAF" },
  { code: "ML", name: "Mali", currency: "XOF" },
  { code: "NE", name: "Niger", currency: "XOF" },
  { code: "SN", name: "Sénégal", currency: "XOF" },
  { code: "TD", name: "Tchad", currency: "XAF" },
  { code: "TG", name: "Togo", currency: "XOF" },
];
