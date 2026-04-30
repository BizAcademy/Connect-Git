import { logger } from "./logger";

export type ProviderId = 1 | 2 | 3 | 4 | 5;
export const ALL_PROVIDER_IDS: readonly ProviderId[] = [1, 2, 3, 4, 5] as const;

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
  2: {
    id: 2,
    apiUrl: process.env["SMM_PANEL_2_API_URL"],
    apiKey: process.env["SMM_PANEL_2_API_KEY"],
    configured: Boolean(process.env["SMM_PANEL_2_API_URL"] && process.env["SMM_PANEL_2_API_KEY"]),
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
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

export function parseProviderId(v: unknown, fallback: ProviderId = 1): ProviderId {
  const n = Number(v);
  if (n === 1 || n === 2 || n === 3 || n === 4 || n === 5) return n;
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
// Display config (order, enabled, header text) — sourced from Supabase table
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
  { provider_id: 2, display_order: 2, enabled: true, header_title: "Fournisseur 2", header_text: "Catalogue alternatif — sélectionnez un service compatible avec votre besoin." },
  { provider_id: 3, display_order: 3, enabled: true, header_title: "Fournisseur 3", header_text: "Catalogue alternatif — sélectionnez un service compatible avec votre besoin." },
  { provider_id: 4, display_order: 4, enabled: true, header_title: "Peakerr — Livraison rapide", header_text: "Fournisseur premium à livraison instantanée — idéal pour les commandes urgentes." },
  { provider_id: 5, display_order: 5, enabled: true, header_title: "ExoSupplier", header_text: "Fournisseur ExoSupplier — large catalogue de services SMM à tarifs compétitifs." },
];

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

let cfgCache: { ts: number; data: ProviderDisplay[] } | null = null;
const CFG_TTL_MS = 30_000;

export function invalidateProviderConfigCache() {
  cfgCache = null;
}

function srHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
    "Content-Type": "application/json",
  };
}

export async function loadProviderConfig(): Promise<ProviderDisplay[]> {
  if (cfgCache && Date.now() - cfgCache.ts < CFG_TTL_MS) return cfgCache.data;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    cfgCache = { ts: Date.now(), data: DEFAULT_CONFIG };
    return DEFAULT_CONFIG;
  }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/smm_providers_config?select=*&order=display_order.asc`,
      { headers: srHeaders() },
    );
    if (!r.ok) {
      logger.warn({ status: r.status }, "smm_providers_config read failed — using defaults");
      cfgCache = { ts: Date.now(), data: DEFAULT_CONFIG };
      return DEFAULT_CONFIG;
    }
    const rows = (await r.json()) as Array<Partial<ProviderDisplay>>;
    if (!rows.length) {
      cfgCache = { ts: Date.now(), data: DEFAULT_CONFIG };
      return DEFAULT_CONFIG;
    }
    const byId = new Map<number, ProviderDisplay>();
    for (const d of DEFAULT_CONFIG) byId.set(d.provider_id, d);
    for (const row of rows) {
      const id = Number(row.provider_id);
      if (id === 1 || id === 2 || id === 3 || id === 4 || id === 5) {
        const def = byId.get(id)!;
        byId.set(id, {
          provider_id: id as ProviderId,
          display_order: typeof row.display_order === "number" ? row.display_order : def.display_order,
          enabled: typeof row.enabled === "boolean" ? row.enabled : def.enabled,
          header_title: typeof row.header_title === "string" ? row.header_title : def.header_title,
          header_text: typeof row.header_text === "string" ? row.header_text : def.header_text,
        });
      }
    }
    const data = Array.from(byId.values()).sort((a, b) => a.display_order - b.display_order);
    cfgCache = { ts: Date.now(), data };
    return data;
  } catch (err) {
    logger.warn({ err }, "smm_providers_config load threw — using defaults");
    cfgCache = { ts: Date.now(), data: DEFAULT_CONFIG };
    return DEFAULT_CONFIG;
  }
}

export async function updateProviderConfig(
  providerId: ProviderId,
  patch: Partial<Pick<ProviderDisplay, "display_order" | "enabled" | "header_title" | "header_text">>,
): Promise<{ ok: boolean; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: "Configuration serveur manquante (SUPABASE_SERVICE_ROLE_KEY)" };
  }
  const body: Record<string, unknown> = {};
  if (typeof patch.display_order === "number") body["display_order"] = patch.display_order;
  if (typeof patch.enabled === "boolean") body["enabled"] = patch.enabled;
  if (typeof patch.header_title === "string") body["header_title"] = patch.header_title;
  if (typeof patch.header_text === "string") body["header_text"] = patch.header_text;
  if (Object.keys(body).length === 0) return { ok: true };

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/smm_providers_config?provider_id=eq.${providerId}`,
    {
      method: "PATCH",
      headers: { ...srHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, error: `${r.status}: ${txt.slice(0, 200)}` };
  }
  invalidateProviderConfigCache();
  return { ok: true };
}
