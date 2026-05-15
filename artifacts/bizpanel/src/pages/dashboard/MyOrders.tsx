import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, ShoppingCart, Search, Copy, Check, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { syncOrdersStatusWithRefunds, FINAL_STATUSES, type SyncRefundEvent } from "@/lib/orderSync";
import { fetchSmmOrderStatus } from "@/lib/smm";
import { useToast } from "@/hooks/use-toast";
import { fetchMyTickets } from "@/lib/tickets";
import { formatBalance } from "@/lib/currency";

// Minimal shape we read off `orders` rows from Realtime payloads. Supabase
// types `payload.new` as `Record<string, unknown>`; this guard narrows it
// without resorting to an `any` cast.
interface OrderRowRT {
  id: string;
  user_id?: string;
  status?: string;
  refunded_at?: string | null;
  external_order_id?: string | null;
  [key: string]: unknown;
}
function asOrderRowRT(value: unknown): OrderRowRT | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v["id"] === "string" ? (v as OrderRowRT) : null;
}

type Period = "all" | "today" | "month" | "year";
type StatusFilter =
  | "all"
  | "pending"
  | "processing"
  | "completed"
  | "partial"
  | "canceled"
  | "refunded"
  | "failed";

const STATUS_LABELS: Record<string, string> = {
  pending: "En attente",
  processing: "En cours",
  completed: "Terminé",
  partial: "Partiel",
  canceled: "Annulé",
  cancelled: "Annulé",
  refunded: "Remboursé",
  failed: "Échoué",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-300",
  processing: "bg-blue-100 text-blue-800 border-blue-300",
  completed: "bg-green-100 text-green-800 border-green-300",
  partial: "bg-orange-100 text-orange-800 border-orange-300",
  canceled: "bg-gray-100 text-gray-800 border-gray-300",
  cancelled: "bg-gray-100 text-gray-800 border-gray-300",
  refunded: "bg-purple-100 text-purple-800 border-purple-300",
  failed: "bg-red-100 text-red-800 border-red-300",
};

function StatusBadge({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${
        STATUS_STYLES[s] || "bg-gray-100 text-gray-800 border-gray-300"
      }`}
    >
      {STATUS_LABELS[s] || status}
    </span>
  );
}

// Statuses past which cancellation/intervention no longer makes sense.
const NON_CANCELLABLE_STATUSES = new Set([
  "completed", "canceled", "cancelled", "refunded", "failed",
]);

function canCancelOrder(status: string | undefined | null): boolean {
  return !NON_CANCELLABLE_STATUSES.has(String(status || "").toLowerCase());
}

// Compute a 0-100 progress percentage from the live provider data.
// - delivered = quantity - remains (when remains is known)
// - completed orders force 100; canceled/refunded/failed clamp to 0.
// - "pending" => 2% (sliver pour signaler "reçu") ; "processing" sans data => 5%
//   (jamais 0% pour ne pas faire reculer la jauge visuellement).
function computeProgress(
  status: string | undefined | null,
  quantity: number,
  remains: number | undefined,
): { pct: number; delivered: number | null } {
  const s = String(status || "").toLowerCase();
  if (s === "completed") return { pct: 100, delivered: quantity };
  if (NON_CANCELLABLE_STATUSES.has(s) && s !== "completed") {
    return { pct: 0, delivered: null };
  }
  if (!quantity || quantity <= 0 || remains === undefined || !Number.isFinite(remains)) {
    // Sliver minimal pour signaler que la commande est prise en compte sans
    // donner une fausse impression de progression — et SURTOUT, ne jamais
    // remonter au-dessus du sliver tant qu'on n'a pas de vraie donnée.
    return { pct: s === "pending" ? 2 : 5, delivered: null };
  }
  const delivered = Math.max(0, Math.min(quantity, quantity - remains));
  let pct = Math.max(0, Math.min(100, Math.round((delivered / quantity) * 100)));
  // Garde-fou : si la commande est "processing" et qu'on a une vraie donnée
  // qui dit 0% livré, on garde le sliver visuel (5%) plutôt que de revenir
  // à zéro — ça évite que la jauge "saute" entre tick et tick.
  if (pct === 0 && s !== "pending") pct = 5;
  return { pct, delivered };
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full">
      <div className="h-2 w-full bg-emerald-100 rounded-full overflow-hidden border border-emerald-200">
        <div
          className="h-full bg-emerald-500 transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <div className="text-[10px] text-emerald-700 font-medium mt-0.5">{pct}%</div>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="text-muted-foreground hover:text-foreground"
      title="Copier"
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export default function MyOrders() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>("all");
  const [statusF, setStatusF] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");
  const [details, setDetails] = useState<Record<string, { start_count?: number; remains?: number; charge?: string; currency?: string }>>({});
  // Set d'IDs locaux d'ordres pour lesquels un ticket d'annulation est déjà
  // ouvert (status open/in_progress + action_type === "cancel"). Le bouton
  // "Annuler" est gelé pour ces commandes — empêche les doubles soumissions.
  const [pendingCancelOrderIds, setPendingCancelOrderIds] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  // Évite les race conditions : seul le dernier loadDetails déclenché est pris
  // en compte. Les anciens fetchs en vol sont ignorés à leur retour, ce qui
  // empêche la jauge de "reculer" quand un fetch lent finit après un récent.
  const loadDetailsSeqRef = useRef(0);
  const detailsRef = useRef<typeof details>({});
  useEffect(() => { detailsRef.current = details; }, [details]);

  const notifyRefunds = (events: SyncRefundEvent[]) => {
    if (!events || events.length === 0) return;
    for (const ev of events) {
      toast({
        title: "Commande remboursée",
        description: `+${formatBalance(ev.amount, profile?.country)} recrédités sur votre solde (commande #${ev.externalId}).`,
      });
    }
    // Tell the rest of the dashboard (header balance, etc.) to refetch.
    window.dispatchEvent(new CustomEvent("balance:refresh"));
  };

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    const initial = data || [];
    setOrders(initial);
    setLoading(false);
    const { orders: synced, refunds } = await syncOrdersStatusWithRefunds(initial);
    setOrders(synced);
    notifyRefunds(refunds);
    void loadDetails(synced);
  };

  const loadDetails = useCallback(async (list: any[]) => {
    // Ne fetcher QUE les commandes non finales : les terminées/annulées ne
    // changent plus de remains, ça évite des appels API inutiles et le risque
    // que le provider renvoie "not found" pour des ids anciens.
    const targets = list.filter(
      (o) => o.external_order_id && !FINAL_STATUSES.has(String(o.status || "").toLowerCase()),
    );
    if (targets.length === 0) return;

    // Race-condition guard : on incrémente la séquence à chaque appel et on
    // jette tout résultat dont la séquence n'est plus la dernière.
    const mySeq = ++loadDetailsSeqRef.current;

    const BATCH = 6;
    const collected: Record<string, { start_count?: number; remains?: number; charge?: string; currency?: string }> = {};
    for (let i = 0; i < targets.length; i += BATCH) {
      if (mySeq !== loadDetailsSeqRef.current) return; // un load plus récent a démarré
      const slice = targets.slice(i, i + BATCH);
      await Promise.all(
        slice.map(async (o) => {
          try {
            const orderProvider =
              o.provider === 3 || o.provider === 4 || o.provider === 5 ? o.provider : 1;
            const d = await fetchSmmOrderStatus(o.external_order_id, orderProvider);
            if (d && !d.error) {
              const prev = detailsRef.current[o.id] || {};
              // Merge intelligent : on ne remplace JAMAIS une valeur connue
              // par `undefined` — sinon la jauge "régresse" quand le provider
              // omet un champ entre deux ticks. On ne garde aussi pas une
              // valeur de remains qui REMONTE (le restant ne peut que baisser
              // ou rester égal).
              const incomingRemains = d.remains !== undefined ? Number(d.remains) : undefined;
              const stableRemains =
                incomingRemains !== undefined && Number.isFinite(incomingRemains)
                  ? (prev.remains !== undefined && incomingRemains > prev.remains
                      ? prev.remains
                      : incomingRemains)
                  : prev.remains;
              collected[o.id] = {
                start_count:
                  d.start_count !== undefined ? Number(d.start_count) : prev.start_count,
                remains: stableRemains,
                charge: d.charge ?? prev.charge,
                currency: d.currency ?? prev.currency,
              };
            }
          } catch {
            // erreur silencieuse : on garde l'ancienne valeur (déjà dans prev)
          }
        }),
      );
    }
    if (mySeq !== loadDetailsSeqRef.current) return;
    // Un seul setDetails à la fin -> évite les re-renders intermédiaires.
    setDetails((prev) => ({ ...prev, ...collected }));
  }, []);

  useEffect(() => { load(); }, [user]);

  // Periodic silent refresh + visibility listener so newly placed orders
  // always appear even if the Supabase Realtime INSERT event is missed.
  useEffect(() => {
    if (!user) return;
    const silentLoad = async () => {
      const { data } = await supabase
        .from("orders").select("*").eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (data) setOrders(data);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void silentLoad(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", silentLoad);
    const id = setInterval(silentLoad, 15000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", silentLoad);
      clearInterval(id);
    };
  }, [user]);

  // Charge les tickets de l'utilisateur et indexe ceux d'annulation encore
  // ouverts par order_local_id. Rafraîchi à chaque retour sur l'onglet pour
  // refléter immédiatement un envoi récent (ex: ticket envoyé puis retour).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const tickets = await fetchMyTickets();
        if (cancelled) return;
        const ids = new Set<string>();
        for (const t of tickets) {
          if (
            t.action_type === "cancel" &&
            (t.status === "open" || t.status === "in_progress") &&
            t.order_local_id
          ) {
            ids.add(t.order_local_id);
          }
        }
        setPendingCancelOrderIds(ids);
      } catch {
        // silencieux — la freeze n'est qu'un garde-fou UX
      }
    };
    refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, [user]);

  // Re-sync périodique tant qu'il y a des commandes non finales.
  // - 45s suffisent : le serveur poller tourne en arrière-plan toutes les 60s
  //   et Supabase Realtime pousse déjà les changements de statut quasi en
  //   temps réel. Inutile de marteler le provider depuis chaque onglet ouvert.
  // - Mutex `running` : empêche deux ticks de se chevaucher si le précédent
  //   prend plus de 45s (réseau lent), ce qui évitait de la jauge instable.
  useEffect(() => {
    if (!user || orders.length === 0) return;
    const hasPending = orders.some(
      (o) => o.external_order_id && !FINAL_STATUSES.has((o.status || "").toLowerCase()),
    );
    if (!hasPending) return;
    let running = false;
    const id = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const { orders: synced, refunds } = await syncOrdersStatusWithRefunds(orders);
        setOrders(synced);
        notifyRefunds(refunds);
        void loadDetails(synced);
      } finally {
        running = false;
      }
    }, 45000);
    return () => clearInterval(id);
  }, [orders, user, loadDetails]);

  // Realtime: when the server poller updates an `orders` row in Supabase,
  // patch the local list immediately — no manual refresh, no waiting for
  // the 20s polling interval to fire.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`orders-user-${user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const next = asOrderRowRT(payload.new);
          if (!next) return;
          setOrders((prev) => prev.map((o) => (o.id === next.id ? { ...o, ...next } : o)));
          // If a refund just happened, refresh the wallet balance shown in the header.
          if (next.refunded_at) {
            window.dispatchEvent(new CustomEvent("balance:refresh"));
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "orders", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row = asOrderRowRT(payload.new);
          if (!row) return;
          setOrders((prev) => (prev.some((o) => o.id === row.id) ? prev : [row, ...prev]));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [user]);

  const filtered = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
    const ql = q.trim().toLowerCase();

    return orders.filter((o) => {
      // Period
      const t = new Date(o.created_at).getTime();
      if (period === "today" && t < startOfDay) return false;
      if (period === "month" && t < startOfMonth) return false;
      if (period === "year" && t < startOfYear) return false;

      // Status (treat both 'cancelled' and 'canceled' as "canceled")
      if (statusF !== "all") {
        const s = (o.status || "").toLowerCase();
        const norm = s === "cancelled" ? "canceled" : s;
        if (norm !== statusF) return false;
      }

      // Search across id, link, service name
      if (ql) {
        const hay = `${o.id} ${o.external_order_id || ""} ${o.service_name || ""} ${o.service_category || ""} ${o.link || ""}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [orders, period, statusF, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: orders.length };
    for (const o of orders) {
      const s = (o.status || "").toLowerCase();
      const norm = s === "cancelled" ? "canceled" : s;
      c[norm] = (c[norm] || 0) + 1;
    }
    return c;
  }, [orders]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold font-heading">Ordres</h2>
          <p className="text-sm text-muted-foreground">Historique complet de vos commandes</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw size={14} className="mr-1" /> Actualiser
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {([
              ["all", "Toutes les périodes"],
              ["today", "Aujourd'hui"],
              ["month", "Ce mois"],
              ["year", "Cette année"],
            ] as [Period, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setPeriod(k)}
                className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                  period === k
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:bg-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {([
              ["all", "Tous"],
              ["pending", "En attente"],
              ["processing", "En cours"],
              ["completed", "Terminés"],
              ["partial", "Partiels"],
              ["canceled", "Annulés"],
              ["refunded", "Remboursés"],
              ["failed", "Échoués"],
            ] as [StatusFilter, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setStatusF(k)}
                className={`px-3 py-1.5 rounded-md text-xs border inline-flex items-center gap-1.5 transition-colors ${
                  statusF === k
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:bg-muted"
                }`}
              >
                {label}
                <span className={`text-[10px] px-1.5 rounded ${statusF === k ? "bg-white/20" : "bg-muted"}`}>
                  {counts[k] ?? 0}
                </span>
              </button>
            ))}
          </div>

          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher par ID, lien, service..."
              className="pl-8 h-9 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <ShoppingCart size={28} className="text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-foreground">
                {orders.length === 0 ? "Aucune commande pour l'instant" : "Aucune commande ne correspond aux filtres"}
              </p>
              {orders.length === 0 && (
                <p className="text-sm text-muted-foreground mt-1">Commencez par passer votre première commande</p>
              )}
            </div>
            {orders.length === 0 && (
              <Button onClick={() => navigate("/dashboard/order")}>Passer une commande</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {filtered.length} commande{filtered.length > 1 ? "s" : ""} affichée{filtered.length > 1 ? "s" : ""}
          </p>

          {/* Desktop table */}
          <div className="hidden md:block border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">ID</th>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Service</th>
                    <th className="px-3 py-2 text-left font-medium">Lien</th>
                    <th className="px-3 py-2 text-right font-medium">Charge</th>
                    <th className="px-3 py-2 text-right font-medium">Démarrage</th>
                    <th className="px-3 py-2 text-right font-medium">Quantité</th>
                    <th className="px-3 py-2 text-right font-medium">Restant</th>
                    <th className="px-3 py-2 text-left font-medium min-w-[120px]">Progression</th>
                    <th className="px-3 py-2 text-left font-medium">Statut</th>
                    <th className="px-3 py-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((o) => {
                    const d = details[o.id] || {};
                    const { pct } = computeProgress(o.status, Number(o.quantity), d.remains);
                    const cancellable = canCancelOrder(o.status);
                    return (
                      <tr key={o.id} className="border-t hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono">
                          <div className="flex items-center gap-1">
                            <span>{o.external_order_id || "—"}</span>
                            {o.external_order_id && <CopyBtn text={String(o.external_order_id)} />}
                          </div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div>{new Date(o.created_at).toLocaleDateString("fr-FR")}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {new Date(o.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                          </div>
                        </td>
                        <td className="px-3 py-2 max-w-[260px]">
                          <div className="font-medium text-foreground truncate" title={o.service_name}>{o.service_name}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{o.service_category}</div>
                        </td>
                        <td className="px-3 py-2 max-w-[220px]">
                          <a
                            href={o.link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline truncate block"
                            title={o.link}
                          >
                            {o.link}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="font-medium text-primary">{formatBalance(Number(o.price), profile?.country)}</div>
                          {d.charge !== undefined && (
                            <div className="text-[10px] text-muted-foreground">
                              {d.charge} {d.currency || "USD"}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {d.start_count !== undefined ? Number(d.start_count).toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2 text-right">{Number(o.quantity).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">
                          {d.remains !== undefined ? Number(d.remains).toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <ProgressBar pct={pct} />
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={o.status} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {cancellable && o.external_order_id ? (
                            pendingCancelOrderIds.has(o.id) ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled
                                className="h-7 text-[11px] border-amber-300 text-amber-700 bg-amber-50 cursor-not-allowed"
                                title="Une demande d'annulation est déjà en cours pour cette commande."
                              >
                                <XCircle size={12} className="mr-1" /> Annulation en cours
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[11px] border-red-300 text-red-700 hover:bg-red-50"
                                onClick={() => navigate(`/dashboard/orders/cancel/${encodeURIComponent(o.id)}`)}
                              >
                                <XCircle size={12} className="mr-1" /> Annuler
                              </Button>
                            )
                          ) : (
                            <span className="text-muted-foreground text-[11px]">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {filtered.map((o) => {
              const d = details[o.id] || {};
              const { pct } = computeProgress(o.status, Number(o.quantity), d.remains);
              const cancellable = canCancelOrder(o.status);
              return (
                <Card key={o.id}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{o.service_name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{o.service_category}</p>
                      </div>
                      <StatusBadge status={o.status} />
                    </div>
                    <a
                      href={o.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary hover:underline block truncate"
                    >
                      🔗 {o.link}
                    </a>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <span className="text-muted-foreground">Quantité :</span>{" "}
                        <span className="font-medium">{Number(o.quantity).toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Charge :</span>{" "}
                        <span className="font-medium text-primary">{formatBalance(Number(o.price), profile?.country)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Démarrage :</span>{" "}
                        <span className="font-medium">{d.start_count !== undefined ? Number(d.start_count).toLocaleString() : "—"}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Restant :</span>{" "}
                        <span className="font-medium">{d.remains !== undefined ? Number(d.remains).toLocaleString() : "—"}</span>
                      </div>
                    </div>
                    <div className="pt-1">
                      <div className="text-[10px] text-muted-foreground mb-1">Progression</div>
                      <ProgressBar pct={pct} />
                    </div>
                    <div className="flex items-center justify-between pt-1 text-[10px] text-muted-foreground border-t">
                      <span>
                        {new Date(o.created_at).toLocaleDateString("fr-FR")}{" "}
                        {new Date(o.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      {o.external_order_id && (
                        <span className="font-mono">#{o.external_order_id}</span>
                      )}
                    </div>
                    {cancellable && o.external_order_id && (
                      <div className="pt-1">
                        {pendingCancelOrderIds.has(o.id) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled
                            className="w-full h-8 text-xs border-amber-300 text-amber-700 bg-amber-50 cursor-not-allowed"
                            title="Une demande d'annulation est déjà en cours pour cette commande."
                          >
                            <XCircle size={14} className="mr-1" /> Annulation en cours
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full h-8 text-xs border-red-300 text-red-700 hover:bg-red-50"
                            onClick={() => navigate(`/dashboard/orders/cancel/${encodeURIComponent(o.id)}`)}
                          >
                            <XCircle size={14} className="mr-1" /> Annuler la commande
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
