import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

// Pricing overrides per provider:
//   { "<smmServiceId>": { price_fcfa: number, hidden?: boolean } }
// One JSON file per provider: data/smm-pricing-<providerId>.json
// (Legacy data/smm-pricing.json is read once at boot for provider 1 to
//  preserve historical overrides made before multi-provider support.)
export interface PricingEntry {
  price_fcfa: number;
  hidden?: boolean;
  featured?: boolean;   // pinned to top of service list
  updated_at?: string;
}
export type PricingMap = Record<string, PricingEntry>;

const cache: Record<number, PricingMap | null> = {};

export async function loadPricing(providerId: number = 1): Promise<PricingMap> {
  if (cache[providerId]) return cache[providerId]!;
  try {
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
      "SELECT service_id,price_minor,hidden,featured,updated_at FROM smm_pricing WHERE provider=?", [providerId],
    );
    cache[providerId] = Object.fromEntries(rows.map(r => [String(r.service_id), {
      price_fcfa: Number(r.price_minor), hidden: Boolean(r.hidden), featured: Boolean(r.featured),
      updated_at: new Date(r.updated_at).toISOString(),
    }]));
  } catch (err) {
    cache[providerId] = {};
    throw err;
  }
  return cache[providerId]!;
}

export async function savePricing(map: PricingMap, providerId: number = 1): Promise<void> {
  cache[providerId] = map;
}

export async function setEntry(
  serviceId: number | string,
  entry: PricingEntry,
  providerId: number = 1,
): Promise<PricingMap> {
  await getMysqlPool().execute(
    `INSERT INTO smm_pricing (provider,service_id,price_minor,hidden,featured) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE price_minor=VALUES(price_minor),hidden=VALUES(hidden),featured=VALUES(featured)`,
    [providerId, String(serviceId), Math.round(entry.price_fcfa), Boolean(entry.hidden), Boolean(entry.featured)],
  );
  cache[providerId] = null;
  return loadPricing(providerId);
}

export async function deleteEntry(
  serviceId: number | string,
  providerId: number = 1,
): Promise<PricingMap> {
  await getMysqlPool().execute("DELETE FROM smm_pricing WHERE provider=? AND service_id=?", [providerId, String(serviceId)]);
  cache[providerId] = null;
  return loadPricing(providerId);
}

// ---------------------------------------------------------------------------
// Per-provider, per-currency USD → local currency rates
// ---------------------------------------------------------------------------
// These define how much local currency the user pays per 1 USD of provider
// service cost. One rate per (provider group × currency code).
//
// Peakerr (provider 4) uses premium rates; all other providers use default.
export const USD_TO_LOCAL_RATES: Record<"peakerr" | "default", Record<string, number>> = {
  peakerr: { XAF: 1000, XOF: 1111, GMD: 80,  CDF: 9000, GNF: 9000 },
  default:  { XAF: 900,  XOF: 1000, GMD: 73,  CDF: 8100, GNF: 7300 },
};

// ---------------------------------------------------------------------------
// Dynamic admin override for USD→local rates
// ---------------------------------------------------------------------------
// Set by admin API routes when rates are saved to settings.
// Falls back to the hardcoded defaults above when null.

let _usdRatesOverride: typeof USD_TO_LOCAL_RATES | null = null;

/** Returns current USD→local rates (admin DB override if set, else hardcoded defaults). */
export function getUsdRates(): typeof USD_TO_LOCAL_RATES {
  return _usdRatesOverride ?? USD_TO_LOCAL_RATES;
}

/** Populate the in-memory override. Called by admin routes after DB write. */
export function setUsdRatesOverride(rates: typeof USD_TO_LOCAL_RATES): void {
  _usdRatesOverride = {
    default:  { ...USD_TO_LOCAL_RATES.default,  ...rates.default  },
    peakerr:  { ...USD_TO_LOCAL_RATES.peakerr,  ...rates.peakerr  },
  };
}

/** Clear the in-memory override (reverts to hardcoded defaults). */
export function clearUsdRatesOverride(): void {
  _usdRatesOverride = null;
}

// FCFA per unit of local currency — mirrors frontend currency.ts fcfaPerUnit.
// XOF: 1 XAF = 0.90 XOF → 1 XOF = 0.90 FCFA (interne XAF)
// CDF: 1 CDF = 1/9 XAF (FCFA) — 1 XAF = 9 CDF
const FCFA_PER_LOCAL: Record<string, number> = {
  XAF: 1, XOF: 0.90, GMD: 6.6667, CDF: 0.1111, GNF: 0.0625,
};

/** USD → local currency rate for a given provider and currency. */
export function usdToLocalRate(providerId?: number, currency?: string): number {
  const effective = getUsdRates();
  const rates = providerId === 4 ? effective.peakerr : effective.default;
  const cur = (currency ?? "XOF").toUpperCase();
  return rates[cur] ?? rates["XOF"]!;
}

/**
 * Backward-compat: USD → FCFA rate using the XAF (≡ FCFA) rate.
 * Kept so admin.ts and existing callers compile without changes.
 */
export function usdToFcfaRate(providerId?: number): number {
  return usdToLocalRate(providerId, "XAF");
}

/**
 * Default FCFA price per 1 000 units for a service, computed from the
 * provider USD rate using the currency-specific markup.
 *
 * Result is in FCFA (the platform's internal billing currency):
 *   FCFA = rate_usd × usdToLocalRate(provider, currency) × fcfaPerUnit(currency)
 *
 * Rounded to the nearest 10 FCFA.
 */
export function defaultPriceFcfaForCurrency(
  rateUsd: string | number,
  providerId?: number,
  currency?: string,
): number {
  const cur = (currency ?? "XOF").toUpperCase();
  const localRate = usdToLocalRate(providerId, cur);
  const fcfaPerUnit = FCFA_PER_LOCAL[cur] ?? 1;
  return Math.round((Number(rateUsd) * localRate * fcfaPerUnit) / 10) * 10;
}

/**
 * Backward-compat wrapper — defaults to XAF/FCFA (no change for existing calls
 * that do not know the user's country).
 */
export function defaultPriceFcfa(rateUsd: string | number, providerId?: number): number {
  return defaultPriceFcfaForCurrency(rateUsd, providerId, "XAF");
}

export interface EnrichedService {
  service: number;
  name: string;
  type: string;
  category: string;
  rate: string;
  min: string | number;
  max: string | number;
  provider: number;
  price_fcfa: number;
  price_is_custom: boolean;
  hidden: boolean;
  featured: boolean;
  [k: string]: unknown;
}

export async function enrichServices(
  services: any[],
  providerId: number = 1,
): Promise<EnrichedService[]> {
  const map = await loadPricing(providerId);
  const enriched = services.map((s) => {
    const override = map[String(s.service)];
    const customPrice = override?.price_fcfa;
    return {
      ...s,
      provider: providerId,
      price_fcfa: typeof customPrice === "number" ? customPrice : defaultPriceFcfa(s.rate, providerId),
      price_is_custom: typeof customPrice === "number",
      hidden: !!override?.hidden,
      featured: !!override?.featured,
    } as EnrichedService;
  });
  // Featured services bubble to the top within each category/globally
  return enriched.sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return 0;
  });
}
