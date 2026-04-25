import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchSmmProviders, prefetchSmmServices, type SmmProviderPublic } from "@/lib/smm";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronRight, Server, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function OrderProviderSelect() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<SmmProviderPublic[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchSmmProviders()
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
        // If a single provider is enabled, jump directly to its order page —
        // no point asking the user to "choose" between one option.
        if (list.length === 1) {
          navigate(`/dashboard/order/${list[0]!.provider_id}`, { replace: true });
          return;
        }
        // Background prefetch: warm the services cache for every available
        // provider so clicking one of them feels instant.
        for (const p of list) prefetchSmmServices(p.provider_id);
      })
      .catch((err: Error) => toast.error(`Erreur chargement fournisseurs : ${err.message}`))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="space-y-4 max-w-2xl">
        <div>
          <h2 className="text-xl font-bold font-heading">Nouvelle commande</h2>
          <p className="text-sm text-muted-foreground">
            Aucun fournisseur SMM n'est actuellement disponible. Réessayez plus tard ou contactez le support.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="-m-4 md:-m-6 p-4 md:p-8 min-h-full bg-gradient-to-br from-pink-200 via-fuchsia-300 to-purple-400">
      <div className="space-y-6 max-w-3xl mx-auto">
        <div className="flex flex-col items-center gap-3 text-center">
          <h2 className="inline-block bg-white/95 px-8 py-3 rounded-full border-2 border-green-600 text-green-600 font-extrabold italic text-xl uppercase shadow-lg tracking-wide">
            CHOISISSEZ VOTRE FOURNISSEUR
          </h2>
          <p className="text-sm text-purple-900/80 font-medium max-w-xl">
            Plusieurs fournisseurs sont disponibles. Sélectionnez celui dont vous souhaitez utiliser le catalogue.
          </p>
        </div>

        <div className="grid gap-3">
          {providers.map((p) => (
            <Card
              key={p.provider_id}
              className="hover:border-primary/60 transition-colors bg-white/90 backdrop-blur"
              onMouseEnter={() => prefetchSmmServices(p.provider_id)}
              onTouchStart={() => prefetchSmmServices(p.provider_id)}
            >
              <CardContent className="p-4 sm:p-5 flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Server size={22} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-base uppercase text-blue-600">
                    {p.header_title}
                  </h3>
                  {p.header_text && (
                    <p className="text-sm font-bold text-blue-600 mt-1">{p.header_text}</p>
                  )}
                  <Button
                    className="mt-3 h-9"
                    onClick={() => navigate(`/dashboard/order/${p.provider_id}`)}
                  >
                    Voir le catalogue
                    <ChevronRight size={16} className="ml-1" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
