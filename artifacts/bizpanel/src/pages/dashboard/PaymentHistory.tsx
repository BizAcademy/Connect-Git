import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, CreditCard } from "lucide-react";
import { formatPaymentMethod } from "@/lib/paymentMethod";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
  completed: "bg-green-100 text-green-800 border-green-200",
  failed: "bg-red-100 text-red-800 border-red-200",
};

const statusLabels: Record<string, string> = {
  pending: "En attente",
  completed: "Complété",
  failed: "Échoué",
};

export default function PaymentHistory() {
  const { user } = useAuth();
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("payments")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setPayments(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [user]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold font-heading">Historique des paiements</h2>
          <p className="text-sm text-muted-foreground">Toutes vos transactions de rechargement</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw size={14} className="mr-1" /> Actualiser
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      ) : payments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <CreditCard size={28} className="text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-foreground">Aucun paiement enregistré</p>
              <p className="text-sm text-muted-foreground mt-1">Rechargez votre solde pour commencer</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {payments.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm">{formatPaymentMethod(p.method)}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${statusColors[p.status] || "bg-gray-100 text-gray-800"}`}>
                        {statusLabels[p.status] || p.status}
                      </span>
                    </div>
                    {p.reference && (
                      <p className="text-xs text-muted-foreground font-mono mt-1">Réf : {p.reference}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-primary text-sm">+{p.amount.toLocaleString()} {p.currency || "FCFA"}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(p.created_at).toLocaleDateString("fr-FR")} {new Date(p.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
