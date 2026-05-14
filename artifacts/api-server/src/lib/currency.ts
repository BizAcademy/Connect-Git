/**
 * Currency conversion utilities.
 *
 * The internal balance is ALWAYS stored in FCFA (XOF/XAF, treated as 1:1).
 * These helpers convert between FCFA and a user's local currency for
 * display and for crediting deposits.
 *
 * Conversion rates for non-CFA currencies (CD, GN, GM) are configurable
 * by the admin from the "Devises" tab.  The in-memory cache is populated
 * by the admin API routes and refreshed automatically from the settings
 * table by the deposit flow when the cache is stale.
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

/** AfribaPay-supported countries with their default currency mapping. */
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

  // Non-CFA countries — configurable via admin "Devises" tab
  CD: { currency: "CDF", fcfaPerUnit: 0.27,   symbol: "CDF" }, // RDC: 1 CDF = 0.27 FCFA
  GN: { currency: "GNF", fcfaPerUnit: 0.0625, symbol: "GNF" }, // Guinée Conakry: 1 FCFA = 16 GNF
  GM: { currency: "GMD", fcfaPerUnit: 6.6667, symbol: "GMD" }, // Gambie: 1 FCFA = 0.15 GMD
};

/** Non-CFA countries whose rates can be changed from the admin panel. */
export const NON_CFA_COUNTRIES_INFO: ReadonlyArray<{
  code: string;
  name: string;
  currency: string;
  symbol: string;
  defaultFcfaPerUnit: number;
}> = [
  { code: "CD", name: "Congo RDC",      currency: "CDF", symbol: "CDF",  defaultFcfaPerUnit: 0.27   },
  { code: "GN", name: "Guinée Conakry", currency: "GNF", symbol: "GNF",  defaultFcfaPerUnit: 0.0625 },
  { code: "GM", name: "Gambie",         currency: "GMD", symbol: "GMD",  defaultFcfaPerUnit: 6.6667 },
];

const DEFAULT_CURRENCY: CurrencyInfo = { currency: "XOF", fcfaPerUnit: 1, symbol: "F CFA" };

// ---------------------------------------------------------------------------
// In-memory rate cache — populated by the admin API and by the deposit flow.
// Key = ISO country code (2-letter, uppercase), value = fcfaPerUnit.
// ---------------------------------------------------------------------------

let _rateOverrides: Record<string, number> | null = null;
let _rateCacheExpiry = 0;
const RATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Replace the in-memory rate overrides.
 * Called by the admin "Devises" API routes and the deposit flow.
 */
export function setRateOverrides(overrides: Record<string, number>, ttlMs = RATE_CACHE_TTL_MS): void {
  _rateOverrides = { ...overrides };
  _rateCacheExpiry = Date.now() + ttlMs;
}

/** Returns true when the in-memory cache is still valid. */
export function isRateCacheValid(): boolean {
  return _rateOverrides !== null && Date.now() < _rateCacheExpiry;
}

/** Invalidate the cache (useful in tests or after a failed settings write). */
export function clearRateCache(): void {
  _rateOverrides = null;
  _rateCacheExpiry = 0;
}

export function getCurrencyInfo(country: string | null | undefined): CurrencyInfo {
  if (!country) return DEFAULT_CURRENCY;
  const upper = country.toUpperCase();
  const base = COUNTRY_CURRENCY[upper] ?? DEFAULT_CURRENCY;

  // Apply admin-configured override when the cache is still valid.
  if (_rateOverrides !== null && Date.now() < _rateCacheExpiry && _rateOverrides[upper] !== undefined) {
    return { ...base, fcfaPerUnit: _rateOverrides[upper]! };
  }
  return base;
}

/**
 * ISO 4217 currency code → fcfaPerUnit rate.
 * For XOF/XAF (CFA zones) the rate is 1:1.
 * For non-CFA currencies, the in-memory admin overrides take precedence
 * over these static defaults.
 */
const CURRENCY_DEFAULT_RATE: Record<string, number> = {
  XOF: 1,
  XAF: 1,
  CDF: 0.27,   // Congo RDC : 1 CDF = 0.27 FCFA
  GNF: 0.0625, // Guinée Conakry : 1 GNF = 0.0625 FCFA (1 FCFA = 16 GNF)
  GMD: 6.6667, // Gambie : 1 GMD ≈ 6.6667 FCFA (1 FCFA ≈ 0.15 GMD)
};

/**
 * Country code → ISO 4217 currency code.
 * Used to look up the rate when we only have a country code.
 */
const COUNTRY_TO_CURRENCY: Record<string, string> = {
  CD: "CDF", GN: "GNF", GM: "GMD",
};

/**
 * Convert an amount in a given ISO 4217 currency to FCFA.
 * This is the **primary conversion path**: use this when you have the
 * currency code directly (e.g. from payments.currency set by the deposit
 * initiation flow). Admin-configured rate overrides are applied when valid.
 *
 * Falls back to 1:1 for unknown currencies (safe for CFA zones).
 */
export function toFcfaByCurrency(localAmount: number, currencyCode: string | null | undefined): number {
  if (!currencyCode) return localAmount;
  const upper = currencyCode.toUpperCase();

  // Apply admin-configured override when cache is valid
  if (_rateOverrides !== null && Date.now() < _rateCacheExpiry) {
    // Overrides are keyed by country code; translate currency → country first
    const countryForCurrency = Object.entries(COUNTRY_TO_CURRENCY).find(([, c]) => c === upper)?.[0];
    if (countryForCurrency && _rateOverrides[countryForCurrency] !== undefined) {
      return Math.round(localAmount * _rateOverrides[countryForCurrency]!);
    }
  }

  const rate = CURRENCY_DEFAULT_RATE[upper] ?? 1;
  return Math.round(localAmount * rate);
}

/**
 * Convert an amount in local currency to FCFA.
 * Used when crediting a deposit: the amount received from AfribaPay is in
 * local currency, so we must convert before storing in profiles.balance.
 *
 * Prefer `toFcfaByCurrency` when the ISO 4217 currency code is available
 * (more reliable than a country-based lookup).
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
