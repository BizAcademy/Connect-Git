import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { useSabitoSettings, updateSabitoSettings, SABITO_SETTINGS_QUERY_KEY } from "@/hooks/useSabitoSettings";

export function AdminSabitoSettings() {
  const queryClient = useQueryClient();
  const settings = useSabitoSettings();
  const mutation = useMutation({
    mutationFn: updateSabitoSettings,
    onSuccess: async value => {
      // Do not let an older in-flight poll overwrite the newly saved flag.
      await queryClient.cancelQueries({ queryKey: SABITO_SETTINGS_QUERY_KEY });
      queryClient.setQueryData(SABITO_SETTINGS_QUERY_KEY, value);
      toast.success(value.enabled ? "Sabito est activé." : "Sabito est désactivé.");
    },
    onError: () => toast.error("Modification non enregistrée. Réessaie."),
  });
  const ready = !!settings.data && !settings.isError;
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Sabito AI</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="admin-sabito-enabled">Afficher Sabito sur le site</Label>
          <Switch
            id="admin-sabito-enabled"
            checked={settings.data?.enabled ?? false}
            disabled={!ready || mutation.isPending}
            onCheckedChange={enabled => mutation.mutate(enabled)}
            aria-describedby="admin-sabito-description"
          />
        </div>
        <p id="admin-sabito-description" className="text-xs text-muted-foreground">
          Masque ou affiche le bouton et le chat pour les visiteurs et les membres.
          Les pages déjà ouvertes se mettent à jour sous 15 secondes.
        </p>
        <p className="text-sm" role="status">
          {mutation.isPending ? "Enregistrement…" : settings.isPending ? "Chargement…" :
            settings.isError ? "État indisponible." : settings.data?.enabled ? "Activé" : "Désactivé"}
        </p>
        {settings.isError && <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>Réessayer</Button>}
        {mutation.isError && <p role="alert" className="text-sm text-destructive">La modification n’a pas été enregistrée.</p>}
      </CardContent>
    </Card>
  );
}
