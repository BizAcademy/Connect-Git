import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

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

function fileFor(providerId: number): string {
  return path.resolve(process.cwd(), "data", `smm-pricing-${providerId}.json`);
}
const LEGACY_FILE = path.resolve(process.cwd(), "data", "smm-pricing.json");

const cache: Record<number, PricingMap | null> = {};

export async function loadPricing(providerId: number = 1): Promise<PricingMap> {
  if (cache[providerId]) return cache[providerId]!;
  const FILE = fileFor(providerId);
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    let txt = await fs.readFile(FILE, "utf8").catch(() => "");
    // One-time legacy migration: if provider 1's per-provider file is
    // missing/empty, read the old smm-pricing.json so historical custom
    // prices are not lost. The provider-1 file is then created on first save.
    if (!txt && providerId === 1) {
      txt = await fs.readFile(LEGACY_FILE, "utf8").catch(() => "");
    }
    cache[providerId] = txt ? (JSON.parse(txt) as PricingMap) : {};
  } catch (err) {
    logger.error({ err, providerId }, "failed to load smm pricing, starting empty");
    cache[providerId] = {};
  }
  return cache[providerId]!;
}

export async function savePricing(map: PricingMap, providerId: number = 1): Promise<void> {
  cache[providerId] = map;
  const FILE = fileFor(providerId);
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(map, null, 2), "utf8");
}

export async function setEntry(
  serviceId: number | string,
  entry: PricingEntry,
  providerId: number = 1,
): Promise<PricingMap> {
  const map = await loadPricing(providerId);
  map[String(serviceId)] = { ...entry, updated_at: new Date().toISOString() };
  await savePricing(map, providerId);
  return map;
}

export async function deleteEntry(
  serviceId: number | string,
  providerId: number = 1,
): Promise<PricingMap> {
  const map = await loadPricing(providerId);
  delete map[String(serviceId)];
  await savePricing(map, providerId);
  return map;
}

// ---------------------------------------------------------------------------
// Per-provider, per-currency USD → local currency rates
// ---------------------------------------------------------------------------
// These define how much local currency the user pays per 1 USD of provider
// service cost. One rate per (provider group × currency code).
//
// Peakerr (provider 4) uses premium rates; all other providers use default.
export const USD_TO_LOCAL_RATES: Record<"peakerr" | "default", Record<string, number>> = {
  peakerr: { XAF: 1000, XOF: 1050, GMD: 80,  CDF: 2700, GNF: 9000 },
  default:  { XAF: 700,  XOF: 750,  GMD: 73,  CDF: 24,   GNF: 7300 },
};

// FCFA per unit of local currency — mirrors frontend currency.ts fcfaPerUnit.
const FCFA_PER_LOCAL: Record<string, number> = {
  XAF: 1, XOF: 1, GMD: 6.6667, CDF: 0.27, GNF: 0.0625,
};

/** USD → local currency rate for a given provider and currency. */
export function usdToLocalRate(providerId?: number, currency?: string): number {
  const rates = providerId === 4 ? USD_TO_LOCAL_RATES.peakerr : USD_TO_LOCAL_RATES.default;
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
