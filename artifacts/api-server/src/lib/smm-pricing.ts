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

// Default user-facing pricing: convert provider USD rate to FCFA at a fixed
// conversion rate. The platform margin is the spread between this rate and
// the real USD/XOF exchange rate. Rounded to the nearest 10 FCFA.
const USD_TO_FCFA = 700;
export function defaultPriceFcfa(rateUsd: string | number): number {
  return Math.round((Number(rateUsd) * USD_TO_FCFA) / 10) * 10;
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
      price_fcfa: typeof customPrice === "number" ? customPrice : defaultPriceFcfa(s.rate),
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
