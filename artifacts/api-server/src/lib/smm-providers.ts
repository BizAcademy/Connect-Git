import { logger } from "./logger";
import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

// Note: Provider ID 2 (GROWFOLLOWERS) was retired. IDs are kept non-contiguous
// (1, 3, 4, 5) on purpose so existing rows in `orders.provider` and
// `earnings.provider` that reference id=2 remain semantically meaningful
// instead of being silently re-routed to a different panel.
export type ProviderId = 1 | 3 | 4 | 5;
export const ALL_PROVIDER_IDS: readonly ProviderId[] = [1, 3, 4, 5] as const;

export interface ProviderRuntime {
  id: ProviderId;
  apiUrl: string | undefined;
  apiKey: string | undefined;
  configured: boolean;
}

const PROVIDERS: Record<ProviderId, ProviderRuntime> = {
  1: {
    id: 1,
    apiUrl: process.env["SMM_PANEL_API_URL"],
    apiKey: process.env["SMM_PANEL_API_KEY"],
    configured: Boolean(process.env["SMM_PANEL_API_URL"] && process.env["SMM_PANEL_API_KEY"]),
  },
  3: {
    id: 3,
    apiUrl: process.env["SMM_PANEL_3_API_URL"],
    apiKey: process.env["SMM_PANEL_3_API_KEY"],
    configured: Boolean(process.env["SMM_PANEL_3_API_URL"] && process.env["SMM_PANEL_3_API_KEY"]),
  },
  4: {
    id: 4,
    apiUrl: process.env["SMM_PANEL_4_API_URL"],
    apiKey: process.env["SMM_PANEL_4_API_KEY"],
    configured: Boolean(process.env["SMM_PANEL_4_API_URL"] && process.env["SMM_PANEL_4_API_KEY"]),
  },
  5: {
    id: 5,
    apiUrl: process.env["SMM_PANEL_5_API_URL"],
    apiKey: process.env["SMM_PANEL_5_API_KEY"],
    configured: Boolean(process.env["SMM_PANEL_5_API_URL"] && process.env["SMM_PANEL_5_API_KEY"]),
  },
};

export function getProvider(id: number): ProviderRuntime | null {
  return (PROVIDERS as Record<number, ProviderRuntime>)[id] ?? null;
}

export function isValidProviderId(v: unknown): v is ProviderId {
  const n = Number(v);
  return n === 1 || n === 3 || n === 4 || n === 5;
}

export function parseProviderId(v: unknown, fallback: ProviderId = 1): ProviderId {
  const n = Number(v);
  if (n === 1 || n === 3 || n === 4 || n === 5) return n;
  return fallback;
}

export async function callProvider(
  providerId: number,
  action: string,
  extra: Record<string, string | number> = {},
): Promise<any> {
  const p = getProvider(providerId);
  if (!p || !p.configured) {
    throw new Error(`Fournisseur SMM #${providerId} non configuré`);
  }
  const body = new URLSearchParams({
    key: p.apiKey!,
    action,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });
  const res = await fetch(p.apiUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Réponse JSON invalide du fournisseur #${providerId}: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Display config (order, enabled, header text) — sourced from MySQL.
// `smm_providers_config`. Cached for 30 s. Falls back to defaults when the
// table is missing so the app keeps working before the SQL is applied.
// ---------------------------------------------------------------------------

export interface ProviderDisplay {
  provider_id: ProviderId;
  display_order: number;
  enabled: boolean;
  header_title: string;
  header_text: string;
}

const DEFAULT_CONFIG: ProviderDisplay[] = [
  { provider_id: 1, display_order: 1, enabled: true, header_title: "Fournisseur 1", header_text: "Services en temps réel — fournisseur partenaire principal." },
  { provider_id: 3, display_order: 2, enabled: true, header_title: "Fournisseur 3", header_text: "Catalogue alternatif — sélectionnez un service compatible avec votre besoin." },
  { provider_id: 4, display_order: 3, enabled: true, header_title: "Peakerr — Livraison rapide", header_text: "Fournisseur premium à livraison instantanée — idéal pour les commandes urgentes." },
  { provider_id: 5, display_order: 4, enabled: true, header_title: "ExoSupplier", header_text: "Fournisseur ExoSupplier — large catalogue de services SMM à tarifs compétitifs." },
];

let cfgCache: { ts: number; data: ProviderDisplay[] } | null = null;
const CFG_TTL_MS = 30_000;

export function invalidateProviderConfigCache() {
  cfgCache = null;
}

export async function loadProviderConfig(): Promise<ProviderDisplay[]> {
  if (cfgCache && Date.now() - cfgCache.ts < CFG_TTL_MS) return cfgCache.data;
  try {
    await getMysqlPool().query(
      "INSERT IGNORE INTO smm_providers_config (provider_id,display_order,enabled,header_title,header_text) VALUES ?",
      [DEFAULT_CONFIG.map(d => [d.provider_id, d.display_order, d.enabled, d.header_title, d.header_text])],
    );
    const [rows] = await getMysqlPool().query<RowDataPacket[]>("SELECT provider_id,display_order,enabled,header_title,header_text FROM smm_providers_config ORDER BY display_order");
    if (!rows.length) {
      cfgCache = { ts: Date.now(), data: DEFAULT_CONFIG };
      return DEFAULT_CONFIG;
    }
    const byId = new Map<number, ProviderDisplay>();
    for (const d of DEFAULT_CONFIG) byId.set(d.provider_id, d);
    for (const row of rows) {
      const id = Number(row.provider_id);
      if (id === 1 || id === 3 || id === 4 || id === 5) {
        const def = byId.get(id)!;
        byId.set(id, {
          provider_id: id,
          display_order: Number.isFinite(Number(row.display_order)) ? Number(row.display_order) : def.display_order,
          enabled: row.enabled === undefined || row.enabled === null ? def.enabled : Boolean(row.enabled),
          header_title: typeof row.header_title === "string" ? row.header_title : def.header_title,
          header_text: typeof row.header_text === "string" ? row.header_text : def.header_text,
        });
      }
    }
    const data = Array.from(byId.values()).sort((a, b) => a.display_order - b.display_order);
    cfgCache = { ts: Date.now(), data };
    return data;
  } catch (err) {
    logger.error({ err }, "smm_providers_config load failed");
    throw err;
  }
}

export async function updateProviderConfig(
  providerId: ProviderId,
  patch: Partial<Pick<ProviderDisplay, "display_order" | "enabled" | "header_title" | "header_text">>,
): Promise<{ ok: boolean; error?: string }> {
  const columns = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!columns.length) return { ok: true };
  try {
    await getMysqlPool().execute(
      `UPDATE smm_providers_config SET ${columns.map(([k]) => `${k}=?`).join(",")} WHERE provider_id=?`,
      [...columns.map(([, v]) => v), providerId],
    );
    invalidateProviderConfigCache();
    return { ok: true };
  } catch (err) {
    logger.error({ err, providerId }, "smm provider config update failed");
    return { ok: false, error: "Mise à jour impossible" };
  }
}
