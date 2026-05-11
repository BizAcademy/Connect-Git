import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Search, RotateCcw, Wallet, FileText } from "lucide-react";
import { syncOrdersStatusWithRefunds } from "@/lib/orderSync";
import { fetchSmmProviders } from "@/lib/smm";
import { toast } from "sonner";
import { InvoiceModal, type InvoiceData } from "@/components/dashboard/InvoiceModal";

type RefundRow = {
  id: string;
  date: string;
  amount: number;
  service_name: string;
  service_category: string;
  external_order_id: string | null;
  provider: number | null;
  raw: any;
};

type Period = "all" | "today" | "month" | "year";

function shortId(id: string) {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export default function Refunds() {
  const { user, profile } = useAuth();
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>("all");
  const [q, setQ] = useState("");
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [providerLabels, setProviderLabels] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetchSmmProviders()
      .then((list) => {
        if (cancelled) return;
        const map: Record<number, string> = {};
        for (const p of list) map[p.provider_id] = p.header_title || `Fournisseur #${p.provider_id}`;
        setProviderLabels(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const providerLabel = (id: number | null | undefined): string => {
    const n = Number(id) || 1;
    return providerLabels[n] || `Fournisseur #${n}`;
  };

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // On ne récupère QUE les commandes ayant un remboursement effectif
      const { data } = await supabase
        .from("orders")
        .select("*")
        .eq("user_id", user.id)
        .not("refunded_at", "is", null)
        .gt("refunded_amount", 0)
        .order("refunded_at", { ascending: false });
      const initial = data || [];
      setOrders(initial);
      setLoading(false);

      // Sync silencieux : peut déclencher de nouveaux remboursements automatiques
      const result = await syncOrdersStatusWithRefunds(initial);
      if (result.refunds.length > 0) {
        const total = result.refunds.reduce((s, r) => s + r.amount, 0);
        toast.success(
          `Nouveau remboursement : ${total.toLocaleString("fr-FR")} FCFA recrédités sur votre solde.`,
        );
        // Recharger pour voir les nouveaux remboursements
        const { data: refreshed } = await supabase
          .from("orders")
          .select("*")
          .eq("user_id", user.id)
          .not("refunded_at", "is", null)
          .gt("refunded_amount", 0)
          .order("refunded_at", { ascending: false });
        setOrders(refreshed || []);
      }
    } catch {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [user]);

  // Realtime : mise à jour immédiate dès qu'un remboursement est appliqué
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`refunds-user-${user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `user_id=eq.${user.id}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [user]);

  const rows: RefundRow[] = useMemo(() => {
    return orders.map((o) => ({
      id: o.id,
      date: o.refunded_at,
      amount: Number(o.refunded_amount),
      service_name: o.service_name || "",
      service_category: o.service_category || "",
      external_order_id: o.external_order_id || null,
      provider: o.provider ?? null,
      raw: o,
    }));
  }, [orders]);

  const filtered = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      const t = new Date(r.date).getTime();
      if (period === "today" && t < startOfDay) return false;
      if (period === "month" && t < startOfMonth) return false;
      if (period === "year" && t < startOfYear) return false;
      if (ql) {
        const hay = `${r.id} ${r.service_name} ${r.service_category} ${r.external_order_id || ""}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [rows, period, q]);

  const total = useMemo(
    () => filtered.reduce((s, r) => s + r.amount, 0),
    [filtered],
  );

  const buildInvoice = (r: RefundRow): InvoiceData => {
    const o = r.raw;
    return {
      number: `BP-REM-${shortId(o.id)}`,
      date: r.date,
      type: "refund",
      customer: { name: profile?.username, email: user?.email || profile?.email },
      amount: r.amount,
      status: "Crédité",
      details: [
        { label: "Commande d'origine", value: `BP-CMD-${shortId(o.id)}` },
        { label: "Fournisseur", value: providerLabel(o.provider) },
        { label: "Service", value: `${r.service_category} · ${r.service_name}`.replace(/^ · /, "") },
        { label: "ID fournisseur", value: r.external_order_id ? `#${r.external_order_id}` : "—" },
        { label: "Motif", value: "Annulation/échec confirmé(e) chez le fournisseur" },
      ],
      note: "Le montant a été automatiquement recrédité sur votre solde BUZZ BOOSTER.",
    };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold font-heading flex items-center gap-2">
            <RotateCcw size={20} className="text-purple-600" />
            Remboursements
          </h2>
          <p className="text-sm text-muted-foreground">
            Toutes les sommes recréditées automatiquement sur votre solde
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw size={14} className="mr-1" /> Actualiser
        </Button>
      </div>

      {/* Stat unique */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4 md:col-span-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
            <Wallet size={14} className="text-purple-600" />
            Total remboursé{period !== "all" ? ` (${period === "today" ? "aujourd'hui" : period === "month" ? "ce mois" : "cette année"})` : ""}
          </div>
          <p className="text-2xl md:text-3xl font-bold text-purple-600 mt-1">
            +{total.toLocaleString("fr-FR")} <span className="text-sm font-normal text-muted-foreground">FCFA</span>
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {filtered.length} remboursement{filtered.length > 1 ? "s" : ""} affiché{filtered.length > 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Filtres */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-muted rounded-md p-0.5">
          {(["all", "today", "month", "year"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                period === p ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p === "all" ? "Tout" : p === "today" ? "Aujourd'hui" : p === "month" ? "Ce mois" : "Cette année"}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un service, ID..."
            className="pl-8 h-9 text-sm"
          />
        </div>
      </div>

      {/* Liste */}
      {loading ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Chargement…</CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <RotateCcw size={32} className="mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">
              {rows.length === 0
                ? "Aucun remboursement pour le moment."
                : "Aucun remboursement ne correspond à votre filtre."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Les remboursements s'affichent automatiquement quand une commande est annulée ou échoue chez le fournisseur.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Tableau (desktop) */}
          <div className="hidden md:block rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Service</th>
                  <th className="px-3 py-2 text-left">Réf. fournisseur</th>
                  <th className="px-3 py-2 text-right">Montant remboursé</th>
                  <th className="px-3 py-2 text-right">Facture</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div>{new Date(r.date).toLocaleDateString("fr-FR")}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(r.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </td>
                    <td className="px-3 py-2 max-w-[300px]">
                      <div className="font-medium truncate" title={r.service_name}>{r.service_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{r.service_category}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.external_order_id ? `#${r.external_order_id}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className="font-bold text-purple-600">
                        +{r.amount.toLocaleString("fr-FR")} FCFA
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => setInvoice(buildInvoice(r))}
                        title="Voir / imprimer la facture"
                      >
                        <FileText size={14} className="mr-1" /> Facture
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cards (mobile) */}
          <div className="md:hidden space-y-2">
            {filtered.map((r) => (
              <Card key={r.id}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{r.service_name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{r.service_category}</p>
                    </div>
                    <span className="font-bold text-purple-600 text-sm whitespace-nowrap">
                      +{r.amount.toLocaleString("fr-FR")} FCFA
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{new Date(r.date).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
                    {r.external_order_id && (
                      <span className="font-mono">#{r.external_order_id}</span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs"
                    onClick={() => setInvoice(buildInvoice(r))}
                  >
                    <FileText size={12} className="mr-1" /> Voir la facture
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {invoice && <InvoiceModal data={invoice} onClose={() => setInvoice(null)} />}
    </div>
  );
}
