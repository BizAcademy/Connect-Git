import { Button } from "@/components/ui/button";
import { useSabitoDiagnostics } from "@/hooks/useSabitoDiagnostics";

const successCodes = new Set([
  "NODE_SUPPORTED", "SABITO_HTTPS_ORIGIN_VALID", "HTTPS_AUTH_OK_NO_OPERATIONS",
  "DATABASE_REACHABLE", "SCHEMA_READABLE",
]);
function formatDate(value: string | null) {
  if (!value) return "Aucun";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "Date invalide" : d.toLocaleString("fr-FR");
}

export function AdminSabitoDiagnostics() {
  const diag = useSabitoDiagnostics();
  const report = diag.data;
  const failed = report?.checks.filter(c => !successCodes.has(c.code)) ?? [];
  const waiting = report?.connector.state?.toLowerCase().includes("wait");

  return (
    <section className="space-y-3 border-t pt-3" aria-labelledby="admin-sabito-diag-title" data-testid="sabito-diagnostics">
      <h3 id="admin-sabito-diag-title" className="text-sm font-medium">Diagnostic serveur</h3>
      <p className="text-xs text-muted-foreground">
        Le diagnostic s’exécute dans l’environnement du serveur WEB uniquement. Il indique seulement la présence
        (oui/non) des variables et des codes de résultat sûrs, jamais leurs valeurs. Il ne démarre ni n’arrête
        le connecteur et ne modifie aucune donnée financière.
      </p>
      <Button variant="outline" size="sm" data-testid="sabito-diagnostics-run"
        disabled={diag.isPending} onClick={() => diag.mutate()}>
        {diag.isPending ? "Diagnostic en cours…" : report || diag.isError ? "Relancer le diagnostic" : "Lancer le diagnostic"}
      </Button>
      <p className="text-sm" role="status" aria-live="polite" data-testid="sabito-diagnostics-status">
        {diag.isPending ? "Diagnostic en cours…" : diag.isError ? "" : report
          ? report.ok ? "Vérifications techniques réussies ; test métier membre encore nécessaire." : "Le diagnostic a détecté des problèmes."
          : "Aucun diagnostic lancé."}
      </p>
      {diag.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive" data-testid="sabito-diagnostics-error">
          <p>{diag.error instanceof Error ? diag.error.message : "Diagnostic serveur indisponible."}</p>
          <Button variant="outline" size="sm" onClick={() => diag.mutate()} data-testid="sabito-diagnostics-retry">Réessayer</Button>
        </div>
      )}
      {report && !diag.isPending && (
        <div className="space-y-3 text-sm" data-testid="sabito-diagnostics-report">
          <p className="text-xs text-muted-foreground">
            Si les variables sont présentes ici mais absentes dans « Run Node.js commands », la commande et
            le serveur web ne reçoivent pas le même environnement. Il n’est pas nécessaire de créer de nouvelles clés.
          </p>
          {report.ok && (
            <p className="text-xs text-muted-foreground">
              Une réponse HTTP 200 confirme uniquement l’authentification HTTPS de la sonde (qui ne réclame aucune
              tâche). Elle ne garantit pas que toutes les opérations métier fonctionnent.
            </p>
          )}
          <div>
            <p className="font-medium">Résultats techniques</p>
            <ul className="space-y-1 text-xs" data-testid="sabito-diagnostics-checks">
              {report.checks.map((check, index) => <li key={`${check.stage}-${index}`}>
                {check.stage} : <span className="font-mono">{check.code}</span>
                {check.http !== undefined && ` (HTTP ${check.http})`}
              </li>)}
            </ul>
          </div>
          <div>
            <p className="font-medium">Vérifications échouées</p>
            {failed.length === 0 ? <p className="text-muted-foreground" data-testid="sabito-diagnostics-no-failures">Aucune.</p> : (
              <ul className="list-disc pl-5" data-testid="sabito-diagnostics-failures">
                {failed.map((c, i) => (
                  <li key={`${c.stage}-${i}`} className="text-destructive">
                    <span className="font-mono">{c.stage}</span> : <span className="font-mono">{c.code}</span>
                    {c.http != null && <> (HTTP {c.http})</>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-medium">Variables d’environnement (présence)</p>
            <ul className="space-y-1" data-testid="sabito-diagnostics-env">
              {report.environment.map(e => (
                <li key={e.key} className="flex justify-between gap-4" data-testid={`sabito-env-${e.key}`}>
                  <span className="font-mono text-xs">{e.key}</span>
                  <span className={e.present ? "" : "text-destructive"}>{e.present ? "Présente" : "Absente"}</span>
                </li>
              ))}
            </ul>
          </div>
          <div data-testid="sabito-diagnostics-connector">
            <p className="font-medium">Superviseur du connecteur (ce processus web)</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt>Démarré</dt><dd>{report.connector.started ? "Oui" : "Non"}</dd>
              <dt>État</dt><dd className="font-mono">{report.connector.state}</dd>
              <dt>Dernier sondage SDK réel (HTTP)</dt><dd>{report.connector.lastPollHttp ?? "Aucun"}</dd>
              <dt>Dernier sondage SDK réel (date)</dt><dd>{formatDate(report.connector.lastPollAt)}</dd>
              <dt>Dernier code d’erreur</dt><dd className="font-mono">{report.connector.lastErrorCode ?? "Aucun"}</dd>
            </dl>
            <p className="mt-1 text-xs text-muted-foreground">
              Le dernier sondage SDK est l’activité réelle du connecteur, distincte de la sonde HTTPS du diagnostic.
              {waiting && " Un état « en attente » peut signifier qu’un connecteur dédié est actif dans un autre processus."}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
