import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RefreshCw, Search, Receipt, ArrowDownCircle, ArrowUpCircle, RotateCcw, FileText,
} from "lucide-react";
import { syncOrdersStatusWithRefunds } from "@/lib/orderSync";
import { fetchSmmProviders } from "@/lib/smm";
import { toast } from "sonner";
import { InvoiceModal, type InvoiceData } from "@/components/dashboard/InvoiceModal";

type TxKind = "deposit" | "order" | "refund";
type TxRow = {
  id: string;
  kind: TxKind;
  date: string;
  amount: number;       // positive number; sign derived from kind
  status: string;
  status_label: string;
  status_color: string;
  detail: string;
  reference?: string | null;
  // Raw underlying records, used to build the printable invoice on demand
  raw: any;
};

const kindMeta: Record<TxKind, { label: string; sign: "+" | "−"; color: string; icon: any }> = {
  deposit: { label: "Dépôt",        sign: "+", color: "text-green-600",  icon: ArrowDownCircle },
  order:   { label: "Commande",     sign: "−", color: "text-red-600",    icon: ArrowUpCircle },
  refund:  { label: "Remboursement", sign: "+", color: "text-purple-600", icon: RotateCcw },
};

const orderStatusMap: Record<string, { label: string; color: string }> = {
  completed:  { label: "Terminé",   color: "bg-green-100 text-green-800 border-green-200" },
  processing: { label: "En cours",  color: "bg-blue-100 text-blue-800 border-blue-200" },
  pending:    { label: "En attente",color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  cancelled:  { label: "Annulé",    color: "bg-gray-100 text-gray-800 border-gray-200" },
  canceled:   { label: "Annulé",    color: "bg-gray-100 text-gray-800 border-gray-200" },
  refunded:   { label: "Remboursé", color: "bg-purple-100 text-purple-800 border-purple-200" },
  partial:    { label: "Partiel",   color: "bg-orange-100 text-orange-800 border-orange-200" },
  failed:     { label: "Échoué",    color: "bg-red-100 text-red-800 border-red-200" },
};
const paymentStatusMap: Record<string, { label: string; color: string }> = {
  completed: { label: "Validé",     color: "bg-green-100 text-green-800 border-green-200" },
  pending:   { label: "En attente", color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  failed:    { label: "Échoué",     color: "bg-red-100 text-red-800 border-red-200" },
  rejected:  { label: "Rejeté",     color: "bg-red-100 text-red-800 border-red-200" },
};

function shortId(id: string) { return id.replace(/-/g, "").slice(0, 8).toUpperCase(); }

export default function Transactions() {
  const { user, profile } = useAuth();
  const [orders, setOrders] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<"all" | "today" | "month" | "year">("all");
  const [kindF, setKindF] = useState<"all" | TxKind>("all");
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
      .catch(() => { /* silent — fallback "Fournisseur #N" suffit */ });
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
      const [ordRes, payRes] = await Promise.all([
        supabase.from("orders").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
        supabase.from("payments").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
      ]);
      const initial = ordRes.data || [];
      setOrders(initial);
      setPayments(payRes.data || []);
      setLoading(false);

      // Background sync: may trigger automatic refunds.
      const result = await syncOrdersStatusWithRefunds(initial);
      setOrders(result.orders);
      if (result.refunds.length > 0) {
        const total = result.refunds.reduce((s, r) => s + r.amount, 0);
        toast.success(
          `Remboursement automatique de ${total.toLocaleString("fr-FR")} FCFA crédité sur votre solde (${result.refunds.length} commande${result.refunds.length > 1 ? "s" : ""}).`,
        );
      }
    } catch (err) {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user]);

  // Build a unified, sorted list. A single canceled+refunded order produces
  // TWO journal entries (the original "Commande" and the matching "Remboursement"),
  // making the impact on the wallet immediately readable.
  const rows: TxRow[] = useMemo(() => {
    const out: TxRow[] = [];
    for (const p of payments) {
      const m = paymentStatusMap[p.status] || { label: p.status, color: "bg-gray-100 text-gray-800 border-gray-200" };
      out.push({
        id: `p-${p.id}`,
        kind: "deposit",
        date: p.created_at,
        amount: Number(p.amount),
        status: p.status,
        status_label: m.label,
        status_color: m.color,
        detail: `Dépôt ${(p.method || "").toUpperCase()}`,
        reference: p.reference || null,
        raw: p,
      });
    }
    for (const o of orders) {
      const status = (o.status || "").toLowerCase();
      const m = orderStatusMap[status] || { label: o.status, color: "bg-gray-100 text-gray-800 border-gray-200" };
      out.push({
        id: `o-${o.id}`,
        kind: "order",
        date: o.created_at,
        amount: Number(o.price),
        status: o.status,
        status_label: m.label,
        status_color: m.color,
        detail: `${o.service_category || ""}${o.service_category ? " · " : ""}${o.service_name || ""}`,
        reference: o.external_order_id ? `#${o.external_order_id}` : null,
        raw: o,
      });
      if (o.refunded_at && Number(o.refunded_amount) > 0) {
        out.push({
          id: `r-${o.id}`,
          kind: "refund",
          date: o.refunded_at,
          amount: Number(o.refunded_amount),
          status: "completed",
          status_label: "Remboursé",
          status_color: "bg-purple-100 text-purple-800 border-purple-200",
          detail: `Remboursement automatique · ${o.service_name || ""}`,
          reference: o.external_order_id ? `#${o.external_order_id}` : null,
          raw: { order: o, refunded_at: o.refunded_at, refunded_amount: o.refunded_amount },
        });
      }
    }
    return out.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [orders, payments]);

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
      if (kindF !== "all" && r.kind !== kindF) return false;
      if (ql) {
        const hay = `${r.id} ${r.detail} ${r.reference || ""}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [rows, period, kindF, q]);

  const totals = useMemo(() => {
    let credit = 0, debit = 0;
    for (const r of filtered) {
      if (r.kind === "order") {
        // Only count orders that were NOT refunded as a real debit
        const ref = r.raw?.refunded_at;
        if (!ref) debit += r.amount;
      } else {
        // deposit only counts as credit when "completed"
        if (r.kind === "refund" || r.status === "completed") credit += r.amount;
      }
    }
    return { credit, debit, net: credit - debit };
  }, [filtered]);

  const buildInvoice = (r: TxRow): InvoiceData => {
    const customer = { name: profile?.username, email: user?.email || profile?.email };
    if (r.kind === "deposit") {
      const p = r.raw;
      return {
        number: `BP-DEP-${shortId(p.id)}`,
        date: p.created_at,
        type: "deposit",
        customer,
        amount: Number(p.amount),
        status: paymentStatusMap[p.status]?.label || p.status,
        details: [
          { label: "Méthode", value: String(p.method || "—").toUpperCase() },
          { label: "Référence", value: p.reference || "—" },
        ],
      };
    }
    if (r.kind === "order") {
      const o = r.raw;
      return {
        number: `BP-CMD-${shortId(o.id)}`,
        date: o.created_at,
        type: "order",
        customer,
        amount: Number(o.price),
        status: orderStatusMap[(o.status || "").toLowerCase()]?.label || o.status,
        details: [
          { label: "Fournisseur", value: providerLabel(o.provider) },
          { label: "Service", value: `${o.service_category || ""} · ${o.service_name || ""}`.replace(/^ · /, "") },
          { label: "Lien cible", value: o.link || "—" },
          { label: "Quantité", value: Number(o.quantity).toLocaleString("fr-FR") },
          { label: "ID fournisseur", value: o.external_order_id ? `#${o.external_order_id}` : "—" },
        ],
        note: o.refunded_at
          ? `Cette commande a été remboursée le ${new Date(o.refunded_at).toLocaleString("fr-FR")} pour ${Number(o.refunded_amount).toLocaleString("fr-FR")} FCFA.`
          : undefined,
      };
    }
    // refund
    const o = r.raw.order;
    return {
      number: `BP-REM-${shortId(o.id)}`,
      date: r.raw.refunded_at,
      type: "refund",
      customer,
      amount: Number(r.raw.refunded_amount),
      status: "Crédité",
      details: [
        { label: "Commande d'origine", value: `BP-CMD-${shortId(o.id)}` },
        { label: "Fournisseur", value: providerLabel(o.provider) },
        { label: "Service", value: `${o.service_category || ""} · ${o.service_name || ""}`.replace(/^ · /, "") },
        { label: "ID fournisseur", value: o.external_order_id ? `#${o.external_order_id}` : "—" },
        { label: "Motif", value: "Annulation/échec confirmé(e) chez le fournisseur" },
      ],
      note: "Le montant a été automatiquement recrédité sur votre solde BUZZ BOOST.",
    };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold font-heading">Transactions</h2>
          <p className="text-sm text-muted-foreground">Journal unifié de vos dépôts, commandes et remboursements</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw size={14} className="mr-1" /> Actualiser
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Transactions</p>
          <p className="text-xl font-bold mt-1">{filtered.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Crédité</p>
          <p className="text-xl font-bold mt-1 text-green-600">+{totals.credit.toLocaleString("fr-FR")}</p>
          <p className="text-[10px] text-muted-foreground">FCFA</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Débité</p>
          <p className="text-xl font-bold mt-1 text-red-600">−{totals.debit.toLocaleString("fr-FR")}</p>
          <p className="text-[10px] text-muted-foreground">FCFA</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Solde net</p>
          <p className={`text-xl font-bold mt-1 ${totals.net >= 0 ? "text-green-600" : "text-red-600"}`}>
            {totals.net >= 0 ? "+" : ""}{totals.net.toLocaleString("fr-FR")}
          </p>
          <p className="text-[10px] text-muted-foreground">FCFA</p>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {([["all","Toutes les périodes"],["today","Aujourd'hui"],["month","Ce mois"],["year","Cette année"]] as const).map(([k,l]) => (
              <button key={k} onClick={() => setPeriod(k as any)}
                className={`px-3 py-1.5 rounded-md text-xs border ${period === k ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground hover:bg-muted"}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {([["all","Tous"],["deposit","Dépôts"],["order","Commandes"],["refund","Remboursements"]] as const).map(([k,l]) => (
              <button key={k} onClick={() => setKindF(k as any)}
                className={`px-3 py-1.5 rounded-md text-xs border ${kindF === k ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground hover:bg-muted"}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher par référence, service…" className="pl-8 h-9 text-sm" />
          </div>
        </CardContent>
      </Card>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <Receipt size={32} className="text-muted-foreground" />
            <p className="font-medium">Aucune transaction</p>
            <p className="text-xs text-muted-foreground">Vos dépôts, commandes et remboursements apparaîtront ici.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden md:block border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Détail</th>
                  <th className="px-3 py-2 text-left font-medium">Référence</th>
                  <th className="px-3 py-2 text-right font-medium">Montant</th>
                  <th className="px-3 py-2 text-left font-medium">Statut</th>
                  <th className="px-3 py-2 text-right font-medium">Facture</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const meta = kindMeta[r.kind];
                  const Icon = meta.icon;
                  return (
                    <tr key={r.id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {new Date(r.date).toLocaleDateString("fr-FR")}{" "}
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(r.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 ${meta.color}`}>
                          <Icon size={12} /> {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-[280px] truncate" title={r.detail}>{r.detail}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{r.reference || "—"}</td>
                      <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${meta.color}`}>
                        {meta.sign}{Math.round(r.amount).toLocaleString("fr-FR")} FCFA
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${r.status_color}`}>{r.status_label}</span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => setInvoice(buildInvoice(r))}
                          className="inline-flex items-center gap-1 text-primary hover:underline text-xs">
                          <FileText size={12} /> Voir
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <div className="md:hidden space-y-3">
            {filtered.map((r) => {
              const meta = kindMeta[r.kind];
              const Icon = meta.icon;
              return (
                <Card key={r.id}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${meta.color}`}>
                        <Icon size={13} /> {meta.label}
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${r.status_color}`}>{r.status_label}</span>
                    </div>
                    <p className="text-sm">{r.detail}</p>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{new Date(r.date).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      {r.reference && <span className="font-mono">{r.reference}</span>}
                    </div>
                    <div className="flex items-center justify-between border-t pt-2">
                      <button onClick={() => setInvoice(buildInvoice(r))}
                        className="inline-flex items-center gap-1 text-primary text-xs hover:underline">
                        <FileText size={12} /> Facture
                      </button>
                      <span className={`font-bold text-sm ${meta.color}`}>
                        {meta.sign}{Math.round(r.amount).toLocaleString("fr-FR")} FCFA
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {invoice && <InvoiceModal data={invoice} onClose={() => setInvoice(null)} />}
    </div>
  );
}
