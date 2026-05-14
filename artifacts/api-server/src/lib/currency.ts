/**
 * Currency conversion utilities.
 *
 * The internal balance is ALWAYS stored in FCFA (XOF/XAF, treated as 1:1).
 * These helpers convert between FCFA and a user's local currency for
 * display and for crediting deposits.
 */

export interface CurrencyInfo {
  /** ISO 4217 currency code (e.g. "CDF", "GNF", "GMD", "XOF", "XAF") */
  currency: string;
  /**
   * How many FCFA one unit of local currency is worth.
   * Examples:
   *  CDF: 1 CDF = 0.27 FCFA  → fcfaPerUnit = 0.27
   *  GNF: 1 GNF = 1/16 FCFA  → fcfaPerUnit = 0.0625
   *  GMD: 1 GMD = 1/0.15 FCFA → fcfaPerUnit ≈ 6.6667
   *  XOF/XAF: 1:1             → fcfaPerUnit = 1
   */
  fcfaPerUnit: number;
  /** Display symbol used in the UI */
  symbol: string;
}

/** AfribaPay-supported countries with their currency mapping. */
export const COUNTRY_CURRENCY: Record<string, CurrencyInfo> = {
  // XOF zone (BCEAO) — 1:1 with FCFA
  BJ: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  BF: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  CI: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  GW: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" }, // Guinée-Bissau
  ML: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  NE: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  SN: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },
  TG: { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" },

  // XAF zone (BEAC) — 1:1 with FCFA
  CM: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  CF: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  TD: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  CG: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  GQ: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },
  GA: { currency: "XAF", fcfaPerUnit: 1, symbol: "F CFA" },

  // Non-CFA countries — need conversion
  CD: { currency: "CDF", fcfaPerUnit: 0.27,       symbol: "CDF" }, // RDC: 1 CDF = 0.27 FCFA
  GN: { currency: "GNF", fcfaPerUnit: 0.0625,     symbol: "GNF" }, // Guinée Conakry: 1 FCFA = 16 GNF
  GM: { currency: "GMD", fcfaPerUnit: 6.6667,     symbol: "GMD" }, // Gambie: 1 FCFA = 0.15 GMD
};

const DEFAULT_CURRENCY: CurrencyInfo = { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" };

export function getCurrencyInfo(country: string | null | undefined): CurrencyInfo {
  if (!country) return DEFAULT_CURRENCY;
  return COUNTRY_CURRENCY[country.toUpperCase()] ?? DEFAULT_CURRENCY;
}

/**
 * Convert an amount in local currency to FCFA.
 * Used when crediting a deposit: the amount received from AfribaPay is in
 * local currency, so we must convert before storing in profiles.balance.
 */
export function toFcfa(localAmount: number, country: string | null | undefined): number {
  const info = getCurrencyInfo(country);
  return Math.round(localAmount * info.fcfaPerUnit);
}

/**
 * Convert an amount in FCFA to local currency (for display only).
 */
export function fromFcfa(fcfaAmount: number, country: string | null | undefined): number {
  const info = getCurrencyInfo(country);
  if (info.fcfaPerUnit === 1) return fcfaAmount;
  return Math.round(fcfaAmount / info.fcfaPerUnit);
}
