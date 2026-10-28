import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "@/lib/authFetch";

export const SABITO_SETTINGS_QUERY_KEY = ["sabito-visibility"] as const;
export type SabitoSettings = { enabled: boolean };

async function parseSettings(response: Response): Promise<SabitoSettings> {
  if (!response.ok) throw new Error("Impossible de charger ou d’enregistrer l’état de Sabito.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || typeof (data as SabitoSettings).enabled !== "boolean") {
    throw new Error("Réponse de configuration Sabito invalide.");
  }
  return { enabled: (data as SabitoSettings).enabled };
}

export function useSabitoSettings() {
  return useQuery({
    queryKey: SABITO_SETTINGS_QUERY_KEY,
    queryFn: async ({ signal }) => parseSettings(await fetch("/api/sabito/settings", {
      signal, cache: "no-store", credentials: "same-origin",
    })),
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: 1,
  });
}

export async function updateSabitoSettings(enabled: boolean): Promise<SabitoSettings> {
  return parseSettings(await authedFetch("/api/admin/sabito/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }), cache: "no-store",
  }));
}
