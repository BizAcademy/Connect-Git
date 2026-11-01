import { useMutation } from "@tanstack/react-query";
import { authedFetch } from "@/lib/authFetch";

export type SabitoDiagnosticReport = {
  ok: boolean;
  checks: { stage: string; code: string; http?: number }[];
  environment: { key: string; present: boolean }[];
  connector: {
    started: boolean;
    state: string;
    lastPollHttp: number | null;
    lastPollAt: string | null;
    lastErrorCode: string | null;
  };
};

export async function runSabitoWebDiagnostic(): Promise<SabitoDiagnosticReport> {
  const response = await authedFetch("/api/admin/sabito/diagnostics", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: "{}", cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("Diagnostic absent du serveur : déploie la dernière version de Buzz Booster.");
    if (response.status === 401 || response.status === 403) throw new Error("Une session administrateur valide est requise.");
    if (response.status === 429) throw new Error("Attends une minute avant de relancer le diagnostic.");
    if (response.status === 409) throw new Error("Un diagnostic est déjà en cours. Réessaie dans un instant.");
    throw new Error("Diagnostic serveur indisponible. Réessaie.");
  }
  const report = await response.json() as SabitoDiagnosticReport;
  if (typeof report?.ok !== "boolean" || !Array.isArray(report.checks) ||
      !Array.isArray(report.environment) || !report.connector ||
      typeof report.connector.started !== "boolean" || typeof report.connector.state !== "string") {
    throw new Error("Réponse du diagnostic invalide.");
  }
  return report;
}

// Explicit manual action: never run this probe during render or polling.
export function useSabitoDiagnostics() {
  return useMutation({ mutationFn: runSabitoWebDiagnostic, retry: false });
}
