import { useEffect, useState, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders, authedFetch } from "@/lib/authFetch";
import { invalidateSiteContentCache } from "@/hooks/useSiteContent";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoLoader } from "@/components/ui/LogoLoader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Users, ShoppingCart, CreditCard, Settings, Layers,
  FileText, LogOut, Shield, Edit2, Save, X, ToggleLeft, ToggleRight,
  Plus, Trash2, RefreshCw, Image, Type, Link, CheckCircle2, Search, RotateCcw, ChevronDown
} from "lucide-react";
import {
  fetchAdminSmmPricing,
  updateAdminSmmPricing,
  resetAdminSmmPricing,
  rescaleAdminSmmPricing,
  fetchAdminSmmBalance,
  fetchAdminEarnings,
  backfillAdminEarnings,
  fetchAdminProviders,
  updateAdminProvider,
  providerAdminName,
  type SmmService,
  type SmmProviderBalance,
  type AdminEarnings,
  type AdminProviderConfig,
} from "@/lib/smm";
import { syncOrdersStatus } from "@/lib/orderSync";
import { adminForceOrderRefund } from "@/lib/smm";
import { formatPaymentMethod } from "@/lib/paymentMethod";
import { InvoiceModal, type InvoiceData } from "@/components/dashboard/InvoiceModal";
import { Wallet, AlertTriangle, TrendingUp, Calendar, CalendarDays, CalendarRange, ArrowDownCircle, ArrowUpCircle, Receipt, Headphones, Send, Loader2, Image as ImageIcon, LayoutDashboard, Gift, Filter, Ticket as TicketIcon, XCircle } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchAdminTickets,
  fetchAdminTicketsUnread,
  adminRespondTicket,
  adminCloseTicket,
  adminCancelOrder,
  type Ticket as SupportTicket,
  type TicketActionType,
} from "@/lib/tickets";
import {
  fetchAdminDeposits,
  adminSetDepositStatus,
  adminCreditBonus,
  type AdminDeposit,
  type AdminDepositsResponse,
} from "@/lib/deposits";
import {
  fetchAdminThreads,
  fetchAdminThread,
  sendAdminReply,
  fileToCompressedDataUrl,
  markAdminRead,
  type SupportMessage,
  type ThreadSummary,
} from "@/lib/support";
import { SupportImage } from "@/components/SupportImage";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Legend,
} from "recharts";

const fmt = (n: number) => `${Math.round(n).toLocaleString()} FCFA`;

const COUNTRY_CURRENCY_MAP: Record<string, { currency: string; symbol: string }> = {
  BJ: { currency: "XOF", symbol: "XOF" },
  BF: { currency: "XOF", symbol: "XOF" },
  CI: { currency: "XOF", symbol: "XOF" },
  GW: { currency: "XOF", symbol: "XOF" },
  ML: { currency: "XOF", symbol: "XOF" },
  NE: { currency: "XOF", symbol: "XOF" },
  SN: { currency: "XOF", symbol: "XOF" },
  TG: { currency: "XOF", symbol: "XOF" },
  CM: { currency: "XAF", symbol: "XAF" },
  CF: { currency: "XAF", symbol: "XAF" },
  TD: { currency: "XAF", symbol: "XAF" },
  CG: { currency: "XAF", symbol: "XAF" },
  GQ: { currency: "XAF", symbol: "XAF" },
  GA: { currency: "XAF", symbol: "XAF" },
  CD: { currency: "CDF", symbol: "CDF" },
  GN: { currency: "GNF", symbol: "GNF" },
  GM: { currency: "GMD", symbol: "GMD" },
};

const KNOWN_COUNTRIES: { code: string; name: string }[] = [
  { code: "BJ", name: "Bénin" },
  { code: "BF", name: "Burkina Faso" },
  { code: "CM", name: "Cameroun" },
  { code: "CF", name: "Centrafrique" },
  { code: "TD", name: "Tchad" },
  { code: "CG", name: "Congo-Brazzaville" },
  { code: "CD", name: "Congo RDC" },
  { code: "CI", name: "Côte d'Ivoire" },
  { code: "GQ", name: "Guinée Équatoriale" },
  { code: "GA", name: "Gabon" },
  { code: "GM", name: "Gambie" },
  { code: "GN", name: "Guinée Conakry" },
  { code: "GW", name: "Guinée-Bissau" },
  { code: "ML", name: "Mali" },
  { code: "NE", name: "Niger" },
  { code: "SN", name: "Sénégal" },
  { code: "TG", name: "Togo" },
];

function getCurrencyInfo(country: string | null | undefined): { currency: string; symbol: string } | null {
  if (!country) return null;
  return COUNTRY_CURRENCY_MAP[country.toUpperCase()] ?? null;
}

/** Default conversion rates (fallback only — admin-configurable rates take precedence). */
const DEFAULT_FCFA_PER_UNIT: Record<string, number> = { CDF: 0.27, GNF: 0.0625, GMD: 6.6667 };

/**
 * Format a deposit amount with its real currency.
 * For CFA currencies (XOF/XAF) the amount is already in FCFA so we display it directly.
 * For non-CFA currencies we show "X [cur] → Y FCFA" using the admin-configured rate
 * (rateOverrides) when available, falling back to the default hardcoded rate.
 * @param rateOverrides - map of country code → fcfaPerUnit from /api/admin/currencies
 */
function fmtDepositAmount(
  amount: number,
  currency: string | null | undefined,
  country: string | null | undefined,
  rateOverrides?: Record<string, number>,
): string {
  const cur = (currency || (country ? COUNTRY_CURRENCY_MAP[country?.toUpperCase() ?? ""]?.currency : null) || "").toUpperCase();
  if (!cur || cur === "XOF" || cur === "XAF") return fmt(amount);
  const upper = country?.toUpperCase() ?? "";
  const fcfaPerUnit = (rateOverrides && upper && rateOverrides[upper] !== undefined)
    ? rateOverrides[upper]
    : DEFAULT_FCFA_PER_UNIT[cur] ?? null;
  if (fcfaPerUnit === null) return `${Math.round(amount).toLocaleString()} ${cur}`;
  const fcfa = Math.round(amount * fcfaPerUnit);
  return `${Math.round(amount).toLocaleString()} ${cur} → ${fcfa.toLocaleString()} FCFA`;
}

/**
 * Format a transaction amount with the correct local currency label.
 * - Deposits: use fmtDepositAmount (handles CDF/GNF/GMD conversions).
 * - Orders / refunds: amounts are stored in FCFA internally.
 *   - XAF zone → show "X XAF", XOF zone → show "X XOF" (1:1 with FCFA).
 *   - Non-CFA zones (CDF, GNF, GMD) → keep "X FCFA" to avoid confusion.
 */
function fmtTxAmount(
  amount: number,
  type: "order" | "deposit" | "refund",
  country?: string | null,
  currency?: string | null,
  rateOverrides?: Record<string, number>,
): string {
  if (type === "deposit") {
    return fmtDepositAmount(amount, currency, country, rateOverrides);
  }
  const cur = getCurrencyInfo(country);
  if (cur && (cur.currency === "XAF" || cur.currency === "XOF")) {
    return `${Math.round(amount).toLocaleString()} ${cur.currency}`;
  }
  return fmt(amount);
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const AdminSupport = () => {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [userMap, setUserMap] = useState<Record<string, { username?: string; email?: string }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [loadingT, setLoadingT] = useState(true);
  const [loadingM, setLoadingM] = useState(false);
  const [text, setText] = useState("");
  const [imageData, setImageData] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadThreads = async () => {
    setLoadingT(true);
    try {
      const t = await fetchAdminThreads();
      setThreads(t);
      // Resolve usernames
      const ids = t.map((x) => x.user_id);
      if (ids.length) {
        const { data } = await supabase
          .from("profiles")
          .select("user_id, username, email")
          .in("user_id", ids);
        const map: Record<string, { username?: string; email?: string }> = {};
        (data || []).forEach((p: any) => { map[p.user_id] = { username: p.username, email: p.email }; });
        setUserMap(map);
      }
      // ⚠️ Forme fonctionnelle obligatoire : `loadThreads` est appelé via
      // setInterval qui capture une closure périmée de `selected`. Sans le
      // `prev =>`, le polling resélectionne en boucle la 1ère conversation
      // et fait dérailler les clics + envois de message.
      if (t.length) setSelected((prev) => prev ?? t[0]!.user_id);
    } catch (e: any) {
      toast.error(e.message || "Erreur");
    } finally {
      setLoadingT(false);
    }
  };

  const loadMessages = async (uid: string, silent = false) => {
    if (!silent) setLoadingM(true);
    try {
      const r = await fetchAdminThread(uid);
      setMessages(r.messages);
    } catch (e: any) {
      if (!silent) toast.error(e.message || "Erreur");
    } finally {
      if (!silent) setLoadingM(false);
    }
  };

  useEffect(() => {
    loadThreads();
    const id = setInterval(loadThreads, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    loadMessages(selected);
    // Mark as read whenever admin opens this thread
    markAdminRead(selected).then(() => loadThreads()).catch(() => {});
    const id = setInterval(() => loadMessages(selected, true), 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) { toast.error("Seules les images sont acceptées"); return; }
    try {
      setImageData(await fileToCompressedDataUrl(f));
    } catch (err: any) {
      toast.error(err.message || "Image invalide");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onSend = async () => {
    if (!selected || (!text.trim() && !imageData)) return;
    setSending(true);
    try {
      const msg = await sendAdminReply(selected, text.trim(), imageData || undefined);
      setMessages((prev) => [...prev, msg]);
      setText("");
      setImageData(null);
      loadThreads();
    } catch (e: any) {
      toast.error(e.message || "Erreur");
    } finally {
      setSending(false);
    }
  };

  const userLabel = (uid: string) => {
    const u = userMap[uid];
    return u?.username || u?.email || uid.slice(0, 8);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Headphones size={15} /> {threads.length} conversation(s) — messages éphémères (7 jours)
        </p>
        <Button variant="outline" size="sm" onClick={loadThreads} disabled={loadingT}>
          <RefreshCw size={13} className={`mr-1 ${loadingT ? "animate-spin" : ""}`} /> Actualiser
        </Button>
      </div>

      <div className="grid grid-cols-[112px_1fr] sm:grid-cols-[180px_1fr] md:grid-cols-[260px_1fr] gap-2 md:gap-3 h-[75vh]">
        {/* Threads list */}
        <Card className="overflow-hidden flex flex-col">
          <div className="p-2 border-b text-[10px] sm:text-xs font-semibold uppercase text-muted-foreground bg-muted/40 truncate">
            Conversations
          </div>
          <div className="overflow-y-auto flex-1">
            {loadingT && threads.length === 0 ? (
              <div className="flex justify-center py-6"><Loader2 className="animate-spin opacity-50" size={20} /></div>
            ) : threads.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center p-4">Aucun message pour le moment.</p>
            ) : threads.map((t) => (
              <button
                key={t.user_id}
                onClick={() => setSelected(t.user_id)}
                className={`w-full text-left p-2 sm:p-3 border-b hover:bg-muted/40 transition-colors ${
                  selected === t.user_id ? "bg-primary/5 border-l-2 border-l-primary" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <p className="text-xs sm:text-sm font-medium truncate">{userLabel(t.user_id)}</p>
                  {t.unread_for_admin > 0 && (
                    <span className="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center shrink-0">
                      {t.unread_for_admin}
                    </span>
                  )}
                </div>
                <p className="hidden sm:block text-xs text-muted-foreground truncate mt-0.5">
                  {t.last_message.sender === "admin" ? "Vous: " : ""}
                  {t.last_message.image_filename && !t.last_message.text ? "📷 Image" : t.last_message.text}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{fmtTime(t.last_message.ts)}</p>
              </button>
            ))}
          </div>
        </Card>

        {/* Conversation */}
        <Card className="flex flex-col overflow-hidden">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Sélectionnez une conversation
            </div>
          ) : (
            <>
              <div className="p-2 sm:p-3 border-b bg-muted/30 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs sm:text-sm font-semibold truncate">{userLabel(selected)}</p>
                  <p className="text-[10px] sm:text-[11px] text-muted-foreground truncate">{userMap[selected]?.email || selected}</p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/10">
                {loadingM ? (
                  <div className="flex justify-center py-6"><Loader2 className="animate-spin opacity-50" size={20} /></div>
                ) : messages.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-6">Conversation vide.</p>
                ) : messages.map((m) => {
                  const mine = m.sender === "admin"; // admin perspective
                  return (
                    <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 ${
                        mine ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-card border rounded-bl-sm"
                      }`}>
                        {!mine && (
                          <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5 text-muted-foreground">
                            {userLabel(selected)}
                          </p>
                        )}
                        {m.image_filename && (
                          <div className="mb-1.5 -mx-1"><SupportImage filename={m.image_filename} /></div>
                        )}
                        {m.text && <p className="text-sm whitespace-pre-wrap break-words">{m.text}</p>}
                        <p className={`text-[10px] mt-1 ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                          {fmtTime(m.ts)}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
              <div className="p-3 border-t bg-card">
                {imageData && (
                  <div className="mb-2 relative inline-block">
                    <img src={imageData} alt="aperçu" className="h-20 rounded border" />
                    <button
                      onClick={() => setImageData(null)}
                      className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full p-0.5"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
                  <Button type="button" variant="outline" size="icon" onClick={() => fileRef.current?.click()} disabled={sending}>
                    <ImageIcon size={16} />
                  </Button>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
                    }}
                    placeholder="Répondre…"
                    rows={1}
                    className="flex-1 resize-none rounded-md border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 max-h-32"
                  />
                  <Button onClick={onSend} disabled={sending || (!text.trim() && !imageData)}>
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
};

type TxRow = {
  id: string;
  type: "order" | "deposit" | "refund";
  created_at: string;
  amount: number;
  status: string; // raw
  status_label: string;
  status_color: string;
  user_label: string;
  user_email?: string;
  detail: string;
  reference?: string | null;
  // Underlying records for the invoice modal + force-refund button
  raw?: any;
  external_order_id?: string | null;
  refunded_at?: string | null;
  user_id?: string;
  provider?: number | null;
  country?: string | null;
  currency?: string | null;
};

// Minimal shape we read off `orders` rows in Realtime payloads. Supabase
// types `payload.new` as `Record<string, unknown>`; this guard narrows it
// without an `any` cast.
interface OrderRowRT {
  id: string;
  user_id?: string;
  status?: string;
  refunded_at?: string | null;
  external_order_id?: string | null;
  provider?: number | null;
  [key: string]: unknown;
}
function asOrderRowRT(value: unknown): OrderRowRT | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v["id"] === "string" ? (v as OrderRowRT) : null;
}

const orderStatusMap: Record<string, { label: string; color: string }> = {
  completed: { label: "Terminé", color: "bg-green-100 text-green-700" },
  processing: { label: "En cours", color: "bg-blue-100 text-blue-700" },
  pending: { label: "En attente", color: "bg-yellow-100 text-yellow-700" },
  cancelled: { label: "Annulé", color: "bg-red-100 text-red-700" },
  rejected: { label: "Rejeté", color: "bg-red-100 text-red-700" },
  partial: { label: "Partiel", color: "bg-orange-100 text-orange-700" },
};
const paymentStatusMap: Record<string, { label: string; color: string }> = {
  completed: { label: "Validé", color: "bg-green-100 text-green-700" },
  pending: { label: "En attente", color: "bg-yellow-100 text-yellow-700" },
  rejected: { label: "Rejeté", color: "bg-red-100 text-red-700" },
};

const AdminTransactions = () => {
  const [rows, setRows] = useState<TxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<"today" | "month" | "total">("month");
  const [type, setType] = useState<"all" | "order" | "deposit" | "refund">("all");
  const [status, setStatus] = useState<"all" | "completed" | "pending" | "rejected" | "processing">("all");
  const [search, setSearch] = useState("");
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      // Source the unified journal from the server (service-role, RLS-bypass).
      const headers = await getAuthHeaders();
      const r = await authedFetch("/api/admin/transactions?limit=500", {
        headers,
      });
      if (!r.ok) {
        console.error("admin/transactions fetch failed", r.status);
        setRows([]);
        return;
      }
      const json = (await r.json()) as { rows: any[] };
      const serverRows: TxRow[] = (json.rows || []).map((row) => {
        const isOrder = row.kind === "order";
        const isRefund = row.kind === "refund";
        const m = isOrder
          ? orderStatusMap[row.status] || { label: row.status, color: "bg-gray-100 text-gray-700" }
          : isRefund
          ? { label: "Remboursé", color: "bg-purple-100 text-purple-700" }
          : paymentStatusMap[row.status] || { label: row.status, color: "bg-gray-100 text-gray-700" };
        return {
          id: row.id,
          type: row.kind,
          created_at: row.created_at,
          amount: Number(row.amount),
          status: row.status,
          status_label: m.label,
          status_color: m.color,
          user_label: row.user_label,
          user_email: row.user_email,
          detail: row.detail,
          reference: row.reference,
          raw: row,
          external_order_id: row.external_order_id || null,
          refunded_at: row.refunded_at || null,
          user_id: row.user_id,
          provider: typeof row.provider === "number" ? row.provider : null,
          country: row.country || null,
          currency: row.currency || null,
        };
      });

      // Trigger an admin-side sync for any non-final order so the journal
      // reflects fresh provider statuses (and fires auto-refunds when the
      // provider says canceled/refunded). Admin endpoint bypasses ownership.
      const ordersForSync = serverRows
        .filter((r) => r.type === "order" && r.external_order_id)
        .map((r) => ({ id: r.id, status: r.status, external_order_id: r.external_order_id, provider: r.provider }));
      const synced = await syncOrdersStatus(ordersForSync, { admin: true });
      const statusByRowId = new Map(synced.map((s) => [s.id, s.status]));
      const updated = serverRows.map((r) => {
        if (r.type !== "order") return r;
        const ns = statusByRowId.get(r.id);
        if (!ns || ns === r.status) return r;
        const m = orderStatusMap[ns] || { label: ns, color: "bg-gray-100 text-gray-700" };
        return { ...r, status: ns, status_label: m.label, status_color: m.color };
      });

      setRows(updated);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);

  // Realtime: when the background poller updates an order row, patch the
  // matching journal entry in place. We only patch existing rows here —
  // brand-new orders are picked up on the next 20s `load()` (which also
  // re-fetches deposits and refunds from the unified server endpoint).
  useEffect(() => {
    const channel = supabase
      .channel("admin-transactions-orders")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders" },
        (payload) => {
          const next = asOrderRowRT(payload.new);
          if (!next) return;
          // The transactions journal namespaces row IDs by type to avoid
          // collisions across deposits/orders/refunds (see admin route:
          // `o-${order.id}`). Match against that prefixed form.
          const rowId = `o-${next.id}`;
          setRows((prev) => prev.map((r) => {
            if (r.type !== "order" || r.id !== rowId) return r;
            const ns = String(next.status || r.status);
            const m = orderStatusMap[ns] || { label: ns, color: "bg-gray-100 text-gray-700" };
            return {
              ...r,
              status: ns,
              status_label: m.label,
              status_color: m.color,
              refunded_at: next.refunded_at || r.refunded_at,
            };
          }));
          if (next.refunded_at) {
            window.dispatchEvent(new CustomEvent("balance:refresh"));
          }
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const periodCutoff = period === "today" ? startOfDay : period === "month" ? startOfMonth : 0;

  const filtered = rows.filter((r) => {
    if (new Date(r.created_at).getTime() < periodCutoff) return false;
    if (type !== "all" && r.type !== type) return false;
    if (status !== "all" && r.status !== status) return false;
    if (search) {
      const s = search.toLowerCase();
      if (
        !r.user_label.toLowerCase().includes(s) &&
        !r.detail.toLowerCase().includes(s) &&
        !(r.reference || "").toLowerCase().includes(s)
      ) return false;
    }
    return true;
  });

  // Stats over the filtered set
  const totalOrders = filtered.filter((r) => r.type === "order");
  const totalDeposits = filtered.filter((r) => r.type === "deposit");
  const sumOrders = totalOrders.reduce((s, r) => s + r.amount, 0);
  const sumDepositsCompleted = totalDeposits.filter((r) => r.status === "completed").reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Transactions</p>
          <p className="text-xl font-bold mt-1">{filtered.length.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Commandes</p>
          <p className="text-xl font-bold mt-1">{totalOrders.length.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground">{sumOrders.toLocaleString()} FCFA</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Dépôts</p>
          <p className="text-xl font-bold mt-1">{totalDeposits.length.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground">{sumDepositsCompleted.toLocaleString()} FCFA validés</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">En attente</p>
          <p className="text-xl font-bold mt-1 text-yellow-600">
            {filtered.filter((r) => r.status === "pending" || r.status === "processing").length}
          </p>
        </div>
      </div>

      {/* Period filter */}
      <div className="flex gap-1.5 flex-wrap">
        {[
          { key: "today", label: "Aujourd'hui", icon: Calendar },
          { key: "month", label: "Mois en cours", icon: CalendarDays },
          { key: "total", label: "Total", icon: CalendarRange },
        ].map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key as any)}
            className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 border ${
              period === p.key ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"
            }`}
          >
            <p.icon size={13} />
            {p.label}
          </button>
        ))}
      </div>

      {/* Type + status + search */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex gap-1">
          {[
            { key: "all", label: "Tous", icon: Receipt },
            { key: "order", label: "Commandes", icon: ArrowUpCircle },
            { key: "deposit", label: "Dépôts", icon: ArrowDownCircle },
            { key: "refund", label: "Remboursements", icon: RotateCcw },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setType(t.key as any)}
              className={`px-2.5 py-1.5 rounded-md text-xs flex items-center gap-1.5 border ${
                type === t.key ? "bg-secondary border-secondary text-secondary-foreground" : "bg-background hover:bg-muted"
              }`}
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as any)}
          className="text-xs border rounded-md px-2 py-1.5 bg-background"
        >
          <option value="all">Tous statuts</option>
          <option value="completed">Validé / Terminé</option>
          <option value="processing">En cours</option>
          <option value="pending">En attente</option>
          <option value="rejected">Rejeté</option>
        </select>
        <div className="relative flex-1 min-w-[160px]">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher utilisateur, service, référence…"
            className="w-full pl-7 pr-2 py-1.5 text-xs border rounded-md bg-background"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw size={13} className={`mr-1 ${loading ? "animate-spin" : ""}`} />
          Actualiser
        </Button>
      </div>

      {/* Table */}
      {loading ? (
        <LogoLoader />
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-8">Aucune transaction pour ces filtres.</p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/60">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Utilisateur</th>
                  <th className="px-3 py-2 font-medium">Détail</th>
                  <th className="px-3 py-2 font-medium text-right">Montant</th>
                  <th className="px-3 py-2 font-medium">Statut</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 300).map((r) => {
                  const sign = r.type === "order" ? "−" : "+";
                  const colorClass =
                    r.type === "order" ? "text-red-600" :
                    r.type === "refund" ? "text-purple-600" : "text-green-600";
                  // Force refund is shown when an order is in a final unsuccessful
                  // status, has not been refunded yet, and has an external id.
                  const canForceRefund =
                    r.type === "order" &&
                    !r.refunded_at &&
                    !!r.external_order_id &&
                    ["canceled","cancelled","failed","refunded"].includes((r.status || "").toLowerCase());
                  return (
                  <tr key={r.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {new Date(r.created_at).toLocaleString("fr-FR", {
                        day: "2-digit", month: "2-digit", year: "2-digit",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="px-3 py-2">
                      {r.type === "order" ? (
                        <span className="inline-flex items-center gap-1 text-red-600">
                          <ArrowUpCircle size={12} /> Commande
                        </span>
                      ) : r.type === "refund" ? (
                        <span className="inline-flex items-center gap-1 text-purple-600">
                          <RotateCcw size={12} /> Remboursement
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-green-600">
                          <ArrowDownCircle size={12} /> Dépôt
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 truncate max-w-[140px]" title={r.user_email || ""}>{r.user_label}</td>
                    <td className="px-3 py-2 truncate max-w-[260px]">
                      {r.detail}
                      {r.reference && <span className="text-muted-foreground"> · {r.reference}</span>}
                      {r.type === "order" && r.refunded_at && (
                        <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5 ml-2">
                          <RotateCcw size={10} />
                          Annulée → Remboursée le{" "}
                          {new Date(r.refunded_at).toLocaleString("fr-FR", {
                            day: "2-digit", month: "2-digit", year: "2-digit",
                            hour: "2-digit", minute: "2-digit",
                          })}
                        </div>
                      )}
                      {r.type === "refund" && r.reference && (
                        <div className="mt-0.5 text-[10px] text-purple-700">
                          ↳ liée à la commande {r.reference}
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${colorClass}`}>
                      {sign}{fmtTxAmount(r.amount, r.type, r.country, r.currency)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full font-medium ${r.status_color}`}>
                        {r.status_label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={() => setInvoice(buildAdminInvoice(r))}
                          className="text-primary hover:underline inline-flex items-center gap-1"
                          title="Voir facture imprimable"
                        >
                          <FileText size={12} /> Facture
                        </button>
                        {canForceRefund && (
                          <button
                            onClick={async () => {
                              if (!r.external_order_id) return;
                              if (!window.confirm(`Forcer le remboursement de ${fmtTxAmount(r.amount, r.type, r.country, r.currency)} pour la commande #${r.external_order_id} ?`)) return;
                              setRefunding(r.id);
                              try {
                                const res = await adminForceOrderRefund(String(r.id));
                                if (res.error) {
                                  toast.error(res.error);
                                } else if (res.refunded) {
                                  toast.success(`Remboursement de ${fmtTxAmount(res.refunded_amount || 0, "refund", r.country, r.currency)} crédité.`);
                                } else {
                                  toast.info("Statut synchronisé. Aucun remboursement nécessaire (déjà remboursé ou statut non éligible).");
                                }
                                await load();
                              } catch (e: any) {
                                toast.error(e?.message || "Erreur");
                              } finally {
                                setRefunding(null);
                              }
                            }}
                            disabled={refunding === r.id}
                            className="text-purple-700 hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                            title="Forcer le remboursement"
                          >
                            <RotateCcw size={12} className={refunding === r.id ? "animate-spin" : ""} />
                            Rembourser
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 300 && (
            <p className="text-[11px] text-muted-foreground text-center py-2 border-t bg-muted/30">
              Affichage des 300 plus récentes sur {filtered.length.toLocaleString()}.
            </p>
          )}
        </div>
      )}

      {invoice && <InvoiceModal data={invoice} onClose={() => setInvoice(null)} />}
    </div>
  );
};

function shortAdminId(id: string) { return id.replace(/-/g, "").slice(0, 8).toUpperCase(); }

function buildAdminInvoice(r: TxRow): InvoiceData {
  const customer = { name: r.user_label, email: r.user_email };
  if (r.type === "deposit") {
    const p = r.raw;
    return {
      number: `BP-DEP-${shortAdminId(p.id)}`,
      date: p.created_at,
      type: "deposit",
      customer,
      amount: Number(p.amount),
      status: r.status_label,
      details: [
        { label: "Méthode", value: formatPaymentMethod(p.method) },
        { label: "Référence", value: p.reference || "—" },
        { label: "Utilisateur", value: r.user_label },
      ],
    };
  }
  if (r.type === "refund") {
    const o = r.raw;
    return {
      number: `BP-REM-${shortAdminId(o.id)}`,
      date: o.refunded_at,
      type: "refund",
      customer,
      amount: Number(o.refunded_amount),
      status: "Crédité",
      details: [
        { label: "Commande d'origine", value: `BP-CMD-${shortAdminId(o.id)}` },
        { label: "Service", value: `${o.service_category || ""} · ${o.service_name || ""}`.replace(/^ · /, "") },
        { label: "ID fournisseur", value: o.external_order_id ? `#${o.external_order_id}` : "—" },
        { label: "Utilisateur", value: r.user_label },
        { label: "Motif", value: "Annulation/échec confirmé(e) chez le fournisseur" },
      ],
      note: "Montant recrédité automatiquement sur le solde de l'utilisateur.",
    };
  }
  const o = r.raw;
  return {
    number: `BP-CMD-${shortAdminId(o.id)}`,
    date: o.created_at,
    type: "order",
    customer,
    amount: Number(o.price),
    status: r.status_label,
    details: [
      { label: "Service", value: `${o.service_category || ""} · ${o.service_name || ""}`.replace(/^ · /, "") },
      { label: "Lien cible", value: o.link || "—" },
      { label: "Quantité", value: Number(o.quantity || 0).toLocaleString("fr-FR") },
      { label: "ID fournisseur", value: o.external_order_id ? `#${o.external_order_id}` : "—" },
      { label: "Utilisateur", value: r.user_label },
    ],
    note: o.refunded_at
      ? `Commande remboursée le ${new Date(o.refunded_at).toLocaleString("fr-FR")} pour ${Number(o.refunded_amount || 0).toLocaleString("fr-FR")} FCFA.`
      : undefined,
  };
}

type JournalRange = "30" | "90" | "365" | "all" | "custom";

const AdminEarningsSection = () => {
  const [data, setData] = useState<AdminEarnings | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<"today" | "month" | "year">("month");
  const [range, setRange] = useState<JournalRange>("30");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const query =
        range === "all"
          ? { all: true as const }
          : range === "custom"
            ? customFrom
              ? { from: customFrom, to: customTo || undefined }
              : { days: 30 }
            : { days: Number(range) };
      setData(await fetchAdminEarnings(query));
    } catch (e: any) {
      if (!silent) setError(e.message || "Erreur");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleBackfill = async () => {
    const confirmed = window.confirm(
      "Importer les commandes existantes dans les statistiques ?\n\n" +
      "• Le chiffre d'affaires et le nombre de commandes seront restaurés.\n" +
      "• Le gain est estimé pour les commandes anciennes à partir de la marge\n" +
      "  par défaut (USD × 700 utilisateur vs USD × 600 fournisseur, ≈ 14,29 %).\n" +
      "• Les commandes déjà présentes avec un gain à 0 seront recalculées.\n" +
      "• Les nouvelles commandes calculent le gain exactement.\n\n" +
      "Cette opération est sûre — elle peut être relancée sans créer de doublons.",
    );
    if (!confirmed) return;

    setSyncing(true);
    try {
      const r = await backfillAdminEarnings();
      const parts: string[] = [];
      if (r.inserted > 0) parts.push(`${r.inserted} commande(s) ajoutée(s)`);
      if (typeof r.recomputed === "number" && r.recomputed > 0) {
        parts.push(`${r.recomputed} gain(s) recalculé(s)`);
      }
      if (parts.length > 0) {
        toast.success(`${parts.join(" · ")} — ${r.total_orders_scanned} commande(s) analysée(s).`);
      } else {
        toast.info(`Aucune nouvelle synchronisation nécessaire (${r.total_orders_scanned} commande(s) analysée(s)).`);
      }
      await load();
    } catch (e: any) {
      toast.error(e.message || "Échec de la synchronisation");
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    load();
    // Polling de secours toutes les 30 s (réduit depuis 2 min)
    const id = setInterval(() => load(true), 30_000);

    // Temps réel : recharger immédiatement dès qu'une commande ou un gain change
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      // Petit debounce pour fusionner les événements en rafale (ex. INSERT order
      // suivi immédiatement d'un INSERT earnings) en un seul fetch silencieux.
      debounceTimer = setTimeout(() => { void load(true); }, 600);
    };

    const channel = supabase
      .channel("admin-earnings-realtime")
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "earnings" },
        triggerReload,
      )
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "orders" },
        triggerReload,
      )
      .subscribe();

    return () => {
      clearInterval(id);
      if (debounceTimer) clearTimeout(debounceTimer);
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Custom-range dates are applied explicitly via the "Appliquer" button,
    // not on every keystroke — so they are not in the dep array.
  }, [range]);

  const cur = data?.summary[period];
  const proj = data?.projections;

  const chartData = (data?.series || []).map((p) => ({
    date: new Date(p.date + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" }),
    gain: p.gain,
  }));

  // Daily journal: most recent first (the API already returns ascending order
  // and pre-fills empty days inside the requested window).
  const journal = useMemo(() => {
    const rows = (data?.series || []).slice().reverse();
    return rows.map((r) => {
      const margin = r.revenue > 0 ? Math.round((r.gain / r.revenue) * 100) : 0;
      return { ...r, margin };
    });
  }, [data]);

  const journalTotal = data?.window?.total ?? journal.reduce(
    (acc, r) => ({
      gain: acc.gain + r.gain,
      revenue: acc.revenue + r.revenue,
      orders: acc.orders + r.count,
    }),
    { gain: 0, revenue: 0, orders: 0 },
  );

  const handleExportCsv = () => {
    if (!journal.length) {
      toast.info("Aucune donnée à exporter pour la période choisie.");
      return;
    }
    const header = ["Date", "Commandes", "Chiffre d'affaires (FCFA)", "Gain (FCFA)", "Marge (%)"];
    const lines = journal.map((r) =>
      [r.date, r.count, r.revenue, r.gain, r.margin].join(","),
    );
    lines.unshift(header.join(","));
    lines.push(["TOTAL", journalTotal.orders, journalTotal.revenue, journalTotal.gain,
      journalTotal.revenue > 0 ? Math.round((journalTotal.gain / journalTotal.revenue) * 100) : 0,
    ].join(","));
    const csv = "\uFEFF" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const win = data?.window;
    const tag = win ? `${win.from}_${win.to}` : new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `gains-admin_${tag}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`${journal.length} jour(s) exporté(s).`);
  };

  const fmtDay = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp size={18} className="text-primary" />
            Mes gains administrateur
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleBackfill}
              disabled={syncing || loading}
              title="Importer les commandes existantes dans les statistiques"
            >
              <RefreshCw size={14} className={`mr-1.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Synchronisation…" : "Synchroniser"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 flex items-center justify-between gap-3">
            <p className="text-sm text-red-700">Erreur : {error}</p>
            <Button size="sm" variant="outline" onClick={() => load()} disabled={loading}>
              Réessayer
            </Button>
          </div>
        )}
        {!data && !error && (
          <p className="text-sm text-muted-foreground">Chargement…</p>
        )}
        {data && (
          <>
            {/* Period selector */}
            <div className="flex gap-1.5 flex-wrap">
              {[
                { key: "today", label: "Aujourd'hui", icon: Calendar },
                { key: "month", label: "Mois en cours", icon: CalendarDays },
                { key: "year", label: "Année en cours", icon: CalendarRange },
              ].map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key as any)}
                  className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 border ${
                    period === p.key
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  <p.icon size={13} />
                  {p.label}
                </button>
              ))}
            </div>

            {/* Current period stats */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border bg-green-50/50 border-green-200 p-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Gains</p>
                <p className="text-xl font-bold text-green-700 mt-1">{fmt(cur?.gain || 0)}</p>
              </div>
              <div className="rounded-lg border bg-blue-50/50 border-blue-200 p-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Chiffre d'affaires</p>
                <p className="text-xl font-bold text-blue-700 mt-1">{fmt(cur?.revenue || 0)}</p>
              </div>
              <div className="rounded-lg border bg-purple-50/50 border-purple-200 p-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Commandes</p>
                <p className="text-xl font-bold text-purple-700 mt-1">{(cur?.orders || 0).toLocaleString()}</p>
              </div>
            </div>

            {/* Projections */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Projections (basées sur la moyenne des 30 derniers jours : {fmt(proj?.daily_avg_30d || 0)} / jour)
              </p>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] text-muted-foreground">Trimestrielle (90j)</p>
                  <p className="text-lg font-bold mt-0.5">{fmt(proj?.quarterly || 0)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] text-muted-foreground">Semestrielle (182j)</p>
                  <p className="text-lg font-bold mt-0.5">{fmt(proj?.semi_annual || 0)}</p>
                </div>
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <p className="text-[11px] text-muted-foreground">Annuelle (365j)</p>
                  <p className="text-lg font-bold text-primary mt-0.5">{fmt(proj?.annual || 0)}</p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                Total cumulé depuis le lancement : <span className="font-semibold text-foreground">{fmt(data.summary.total.gain)}</span>
                {" · "}{data.summary.total.orders.toLocaleString()} commandes
              </p>
            </div>

            {/* Chart */}
            <div>
              <p className="text-sm font-semibold mb-3">Évolution des Revenus</p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 5, bottom: 25 }}>
                    <defs>
                      <linearGradient id="gainGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11 }}
                      angle={-35}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `${v.toLocaleString()} F`}
                      width={80}
                    />
                    <RechartsTooltip
                      formatter={(v: number) => [`${v.toLocaleString()} FCFA`, "Gains"]}
                      labelStyle={{ color: "#111" }}
                      contentStyle={{ borderRadius: 8, fontSize: 12 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area
                      type="monotone"
                      dataKey="gain"
                      name="Revenus Administrateur (FCFA)"
                      stroke="#3b82f6"
                      strokeWidth={2.5}
                      fill="url(#gainGradient)"
                      dot={{ r: 3, fill: "#3b82f6" }}
                      activeDot={{ r: 5 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Daily journal — explicit list of every day in the window */}
            <div>
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <p className="text-sm font-semibold">Journal quotidien des gains</p>
                <Button size="sm" variant="outline" onClick={handleExportCsv} disabled={loading || journal.length === 0}>
                  Exporter CSV
                </Button>
              </div>

              {/* Window selector */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                {[
                  { key: "30", label: "30 jours" },
                  { key: "90", label: "90 jours" },
                  { key: "365", label: "365 jours" },
                  { key: "all", label: "Tout l'historique" },
                  { key: "custom", label: "Plage personnalisée" },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => setRange(opt.key as JournalRange)}
                    className={`px-3 py-1.5 rounded-md text-xs border ${
                      range === opt.key
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {range === "custom" && (
                <div className="flex flex-wrap items-end gap-2 mb-3">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Du</Label>
                    <Input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Au (optionnel)</Label>
                    <Input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <Button size="sm" variant="outline" onClick={() => load()} disabled={loading || !customFrom}>
                    Appliquer
                  </Button>
                </div>
              )}

              {data.window && (
                <p className="text-[11px] text-muted-foreground mb-2">
                  Période affichée : <span className="font-medium text-foreground">{fmtDay(data.window.from)}</span>
                  {" → "}
                  <span className="font-medium text-foreground">{fmtDay(data.window.to)}</span>
                  {" · "}
                  {data.window.days} jour{data.window.days > 1 ? "s" : ""}
                </p>
              )}

              <div className="rounded-lg border overflow-hidden">
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr className="text-left">
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium text-right">Commandes</th>
                        <th className="px-3 py-2 font-medium text-right">Chiffre d'affaires</th>
                        <th className="px-3 py-2 font-medium text-right">Gain</th>
                        <th className="px-3 py-2 font-medium text-right">Marge</th>
                      </tr>
                    </thead>
                    <tbody>
                      {journal.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                            Aucun jour dans la période choisie.
                          </td>
                        </tr>
                      ) : (
                        journal.map((r) => {
                          const isEmpty = r.count === 0;
                          return (
                            <tr key={r.date} className={`border-t ${isEmpty ? "text-muted-foreground" : ""}`}>
                              <td className="px-3 py-1.5 whitespace-nowrap">{fmtDay(r.date)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{r.count.toLocaleString()}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.revenue)}</td>
                              <td className={`px-3 py-1.5 text-right tabular-nums ${!isEmpty ? "font-semibold text-green-700" : ""}`}>{fmt(r.gain)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{isEmpty ? "—" : `${r.margin}%`}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                    <tfoot className="bg-muted/40 sticky bottom-0">
                      <tr className="border-t font-semibold">
                        <td className="px-3 py-2">Total de la période</td>
                        <td className="px-3 py-2 text-right tabular-nums">{journalTotal.orders.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(journalTotal.revenue)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-green-700">{fmt(journalTotal.gain)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {journalTotal.revenue > 0 ? `${Math.round((journalTotal.gain / journalTotal.revenue) * 100)}%` : "—"}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

const SmmProviderBalanceCard = ({ providerId = 1 }: { providerId?: number }) => {
  const [bal, setBal] = useState<SmmProviderBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setBal(await fetchAdminSmmBalance(providerId));
    } catch (e: any) {
      setError(e.message || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [providerId]);

  const usd = bal?.balance_usd ?? 0;
  const fcfa = bal?.balance_fcfa_equiv ?? 0;
  const isLow = usd < 5;
  const isEmpty = usd <= 0;

  return (
    <Card className={isEmpty ? "border-red-500 bg-red-50/50" : isLow ? "border-amber-500 bg-amber-50/50" : "border-green-500/40 bg-green-50/30"}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className={`h-10 w-10 rounded-full flex items-center justify-center ${isEmpty ? "bg-red-100 text-red-600" : isLow ? "bg-amber-100 text-amber-600" : "bg-green-100 text-green-600"}`}>
            <Wallet size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground">Solde — {providerAdminName(providerId)}</p>
            {loading && !bal ? (
              <p className="text-sm text-muted-foreground">Chargement…</p>
            ) : error ? (
              <p className="text-sm text-red-600">Erreur : {error}</p>
            ) : (
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={`text-2xl font-bold ${isEmpty ? "text-red-600" : isLow ? "text-amber-600" : "text-green-700"}`}>
                  ${usd.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">≈ {fcfa.toLocaleString()} FCFA</span>
              </div>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
        {(isEmpty || isLow) && !loading && !error && (
          <div className={`mt-3 text-xs flex items-start gap-2 p-2 rounded ${isEmpty ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              {isEmpty
                ? "Solde épuisé ! Toutes les commandes utilisateurs seront refusées et remboursées automatiquement. Recharge ton compte SMM Panel rapidement."
                : "Solde faible. Pense à recharger ton compte SMM Panel pour éviter le refus de commandes."}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Dashboard: horizontal row showing the balance of every CONFIGURED provider,
// in the admin-defined display_order. Re-fetches on tab focus and on the
// "providers:reordered" custom event so changing the order in the Services
// tab is reflected here without a manual reload.
// ---------------------------------------------------------------------------
const AdminProvidersBalanceRow = () => {
  const [providers, setProviders] = useState<AdminProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const list = await fetchAdminProviders();
      const visible = list
        .filter((p) => p.configured)
        .sort(
          (a, b) =>
            (a.display_order || a.provider_id) - (b.display_order || b.provider_id),
        );
      setProviders(visible);
    } catch {
      // Silently fall back to provider 1 if the API call fails — never
      // hide the dashboard because of a transient config-fetch error.
      setProviders([
        {
          provider_id: 1,
          display_order: 1,
          enabled: true,
          header_title: "",
          header_text: "",
          configured: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    const onReorder = () => load();
    window.addEventListener("providers:reordered", onReorder);
    return () => window.removeEventListener("providers:reordered", onReorder);
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="animate-spin text-primary" size={20} />
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <Card className="border-amber-300 bg-amber-50/50">
        <CardContent className="p-4 text-sm text-amber-800">
          Aucun fournisseur SMM n'est configuré (clés API manquantes).
        </CardContent>
      </Card>
    );
  }
  // 1 → full row, 2 → two columns, 3+ → three columns.
  const cols =
    providers.length >= 3 ? "lg:grid-cols-3" : providers.length === 2 ? "lg:grid-cols-2" : "";
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 ${cols} gap-3`}>
      {providers.map((p) => (
        <SmmProviderBalanceCard key={p.provider_id} providerId={p.provider_id} />
      ))}
    </div>
  );
};

type AdminUserRow = {
  user_id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  country: string | null;
  balance: number;
  is_active: boolean;
  created_at: string;
  affiliate_earnings?: number;
};

async function adminApiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  // authedFetch injects the auth header, refreshes the JWT proactively, and
  // owns the terminal "session expirée" UX (toast + signOut + redirect).
  const r = await authedFetch(path, { ...init, headers });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

const AdminUsers = () => {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [form, setForm] = useState<Partial<AdminUserRow>>({});
  const [saving, setSaving] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  const [totals, setTotals] = useState<{ total_balance: number; user_count: number; updated_at: number } | null>(null);
  const totalsSeqRef = useRef(0);
  const totalsMountedRef = useRef(true);

  const loadTotals = async () => {
    const seq = ++totalsSeqRef.current;
    try {
      const data = await adminApiFetch(`/api/admin/users/total-balance`);
      if (!totalsMountedRef.current || seq !== totalsSeqRef.current) return;
      setTotals({
        total_balance: Number(data.total_balance) || 0,
        user_count: Number(data.user_count) || 0,
        updated_at: Date.now(),
      });
    } catch {
      /* silent */
    }
  };

  const load = async (q = search) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("search", q);
      params.set("limit", "200");
      const data = await adminApiFetch(`/api/admin/users?${params.toString()}`);
      setUsers(data.users || []);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(""); loadTotals(); }, []);

  useEffect(() => {
    const channel = supabase
      .channel("admin-balances")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles" },
        () => loadTotals(),
      )
      .subscribe();
    const interval = window.setInterval(loadTotals, 15_000);
    return () => {
      totalsMountedRef.current = false;
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
      window.clearInterval(interval);
    };
  }, []);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    load(searchInput.trim());
  };

  const openEdit = (u: AdminUserRow) => {
    setEditing(u);
    setForm({
      username: u.username || "",
      email: u.email || "",
      phone: u.phone || "",
      whatsapp: u.whatsapp || "",
      country: u.country || "",
      balance: u.balance,
      is_active: u.is_active,
    });
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await adminApiFetch(`/api/admin/users/${editing.user_id}`, {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      toast.success("Utilisateur mis à jour");
      setEditing(null);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async () => {
    if (!editing) return;
    if (pw.length < 8) { toast.error("Le mot de passe doit contenir au moins 8 caractères"); return; }
    setPwSaving(true);
    try {
      await adminApiFetch(`/api/admin/users/${editing.user_id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: pw }),
      });
      toast.success("Mot de passe modifié");
      setPw("");
      setPwOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPwSaving(false);
    }
  };

  const toggleActive = async (u: AdminUserRow) => {
    try {
      await adminApiFetch(`/api/admin/users/${u.user_id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !u.is_active }),
      });
      toast.success(u.is_active ? "Compte désactivé" : "Compte activé");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="bg-blue-600 text-white border-blue-600">
        <CardContent className="p-5 flex items-center gap-4 flex-wrap">
          <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <Wallet size={22} />
          </div>
          <div className="flex-1 min-w-[180px]">
            <p className="text-xs opacity-80 uppercase tracking-wide">Solde total des utilisateurs</p>
            <p className="text-3xl font-bold">
              {totals ? totals.total_balance.toLocaleString("fr-FR") : "…"} FCFA
            </p>
            <p className="text-xs opacity-80 mt-0.5">
              {totals ? `${totals.user_count.toLocaleString("fr-FR")} compte(s)` : "Chargement…"}
              {totals && (
                <span className="ml-2">· mis à jour {new Date(totals.updated_at).toLocaleTimeString("fr-FR")}</span>
              )}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => loadTotals()}
            className="bg-white/20 hover:bg-white/30 text-white border-white/30">
            <RefreshCw size={14} className="mr-1" /> Rafraîchir
          </Button>
        </CardContent>
      </Card>
      <form onSubmit={onSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Rechercher (nom, email, téléphone)…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="pl-7 h-9"
          />
        </div>
        <Button type="submit" size="sm" variant="outline">Rechercher</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setSearchInput(""); setSearch(""); load(""); }}>
          <RefreshCw size={14} />
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">{users.length} utilisateur(s){search ? ` (filtré: "${search}")` : ""}</p>
      {loading ? (
        <LogoLoader />
      ) : (
        <div className="space-y-3">
          {users.map(u => (
            <Card key={u.user_id}>
              <CardContent className="p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm">{u.username || "(sans nom)"}</p>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${u.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {u.is_active ? "Actif" : "Inactif"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{u.email || "—"}</p>
                    {u.phone && (
                      <p className="text-xs text-muted-foreground truncate">{u.phone}</p>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {u.country ? (
                        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                          🌍 {u.country.toUpperCase()}
                          {(() => { const n = KNOWN_COUNTRIES.find(c => c.code === u.country?.toUpperCase()); return n ? ` · ${n.name}` : ""; })()}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">Pays inconnu</span>
                      )}
                      {u.country && getCurrencyInfo(u.country) && (
                        <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                          {getCurrencyInfo(u.country)!.currency}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm font-bold text-primary whitespace-nowrap">{Number(u.balance).toLocaleString()} FCFA</p>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => openEdit(u)}>
                      <Edit2 size={13} className="mr-1" />Modifier
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => toggleActive(u)} title={u.is_active ? "Désactiver" : "Activer"}>
                      {u.is_active ? <ToggleRight size={14} className="text-green-600" /> : <ToggleLeft size={14} className="text-red-500" />}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {users.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-6">Aucun utilisateur</p>
          )}
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Modifier l'utilisateur</DialogTitle>
            <DialogDescription>
              {editing?.user_id && <span className="text-xs font-mono break-all">{editing.user_id}</span>}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <Label className="text-xs">Nom d'utilisateur</Label>
              <Input value={form.username ?? ""} onChange={e => setForm({ ...form, username: e.target.value })} className="h-10 mt-1" />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">Email</Label>
              <Input type="email" value={form.email ?? ""} onChange={e => setForm({ ...form, email: e.target.value })} className="h-10 mt-1" />
            </div>
            <div>
              <Label className="text-xs">Téléphone</Label>
              <Input value={form.phone ?? ""} onChange={e => setForm({ ...form, phone: e.target.value })} className="h-10 mt-1" />
            </div>
            <div>
              <Label className="text-xs">WhatsApp</Label>
              <Input value={form.whatsapp ?? ""} onChange={e => setForm({ ...form, whatsapp: e.target.value })} className="h-10 mt-1" />
            </div>
            <div>
              <Label className="text-xs">Pays</Label>
              <select
                value={form.country ?? ""}
                onChange={e => setForm({ ...form, country: e.target.value })}
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">— Non renseigné —</option>
                {KNOWN_COUNTRIES.map(c => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name} {COUNTRY_CURRENCY_MAP[c.code] ? `(${COUNTRY_CURRENCY_MAP[c.code].currency})` : ""}
                  </option>
                ))}
              </select>
              {form.country && getCurrencyInfo(form.country) && (
                <p className="text-xs text-amber-700 mt-1">
                  Devise : <strong>{getCurrencyInfo(form.country)!.currency}</strong> ({getCurrencyInfo(form.country)!.symbol})
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs">Solde (FCFA)</Label>
              <Input type="number" min={0} value={form.balance ?? 0} onChange={e => setForm({ ...form, balance: Number(e.target.value) })} className="h-10 mt-1" />
            </div>
            <div className="sm:col-span-2 flex items-center gap-2 pt-1">
              <input
                id="is_active"
                type="checkbox"
                checked={!!form.is_active}
                onChange={e => setForm({ ...form, is_active: e.target.checked })}
                className="h-4 w-4"
              />
              <Label htmlFor="is_active" className="text-sm cursor-pointer">Compte actif</Label>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => { setPw(""); setPwOpen(true); }} className="sm:mr-auto">
              Réinitialiser le mot de passe
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Annuler</Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password reset dialog */}
      <Dialog open={pwOpen} onOpenChange={(o) => { setPwOpen(o); if (!o) setPw(""); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Réinitialiser le mot de passe</DialogTitle>
            <DialogDescription>
              Saisissez le nouveau mot de passe (min. 8 caractères). Transmettez-le à l'utilisateur de manière sécurisée.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Nouveau mot de passe</Label>
            <Input
              type="password"
              value={pw}
              onChange={e => setPw(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              className="h-9"
            />
            <p className="text-xs text-muted-foreground">{pw.length} caractère(s)</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPwOpen(false)}>Annuler</Button>
            <Button size="sm" onClick={resetPassword} disabled={pwSaving || pw.length < 8}>
              {pwSaving ? "Modification…" : "Modifier le mot de passe"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const STATUSES = ["pending", "processing", "completed", "partial", "canceled", "refunded", "failed"];
const STATUS_LABELS: Record<string, string> = {
  pending: "En attente", processing: "En cours", completed: "Terminé",
  partial: "Partiel", canceled: "Annulé", cancelled: "Annulé",
  refunded: "Remboursé", failed: "Échoué",
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

const AdminOrders = () => {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<"all" | "today" | "month" | "year">("all");
  const [statusF, setStatusF] = useState<string>("all");
  const [q, setQ] = useState("");
  const [usernames, setUsernames] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(500);
    const list = data || [];
    setOrders(list);
    setLoading(false);

    const ids = Array.from(new Set(list.map((o: any) => o.user_id).filter(Boolean)));
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("user_id, username, email").in("user_id", ids);
      const map: Record<string, string> = {};
      for (const p of profs || []) map[p.user_id] = p.username || p.email || p.user_id.slice(0, 8);
      setUsernames(map);
    }
  };

  useEffect(() => { load(); }, []);

  // Realtime: reflect background poller updates instantly in the admin
  // orders list (no filter — admin sees everyone's orders).
  useEffect(() => {
    const channel = supabase
      .channel("admin-orders-list")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders" },
        (payload) => {
          const next = asOrderRowRT(payload.new);
          if (!next) return;
          setOrders((prev) => prev.map((o) => (o.id === next.id ? { ...o, ...next } : o)));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "orders" },
        (payload) => {
          const row = asOrderRowRT(payload.new);
          if (!row) return;
          setOrders((prev) => (prev.some((o) => o.id === row.id) ? prev : [{ ...row }, ...prev]));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

  const REFUND_STATUSES = new Set(["canceled", "cancelled", "failed", "refunded"]);

  const updateStatus = async (id: string, status: string) => {
    const shouldRefund = REFUND_STATUSES.has(status.toLowerCase());

    await supabase.from("orders").update({ status }).eq("id", id);
    setOrders(orders.map(o => o.id === id ? { ...o, status } : o));

    if (shouldRefund) {
      try {
        const result = await adminForceOrderRefund(id);
        if (result.refunded && result.refunded_amount) {
          toast.success(`Statut mis à jour · Remboursement de ${result.refunded_amount.toLocaleString()} FCFA crédité à l'utilisateur.`);
        } else if (result.error) {
          toast.warning(`Statut mis à jour, mais remboursement échoué : ${result.error}`);
        } else {
          toast.success("Statut mis à jour (commande déjà remboursée ou montant nul).");
        }
      } catch {
        toast.warning("Statut mis à jour, mais erreur lors du remboursement. Vérifiez manuellement.");
      }
    } else {
      toast.success("Statut mis à jour");
    }
  };

  const filtered = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
    const ql = q.trim().toLowerCase();

    return orders.filter((o) => {
      const t = new Date(o.created_at).getTime();
      if (period === "today" && t < startOfDay) return false;
      if (period === "month" && t < startOfMonth) return false;
      if (period === "year" && t < startOfYear) return false;
      if (statusF !== "all") {
        const s = (o.status || "").toLowerCase();
        const norm = s === "cancelled" ? "canceled" : s;
        if (norm !== statusF) return false;
      }
      if (ql) {
        const hay = `${o.id} ${o.external_order_id || ""} ${o.service_name || ""} ${o.link || ""} ${usernames[o.user_id] || ""}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [orders, period, statusF, q, usernames]);

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
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">
          {filtered.length} sur {orders.length} commande{orders.length > 1 ? "s" : ""}
        </p>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw size={14} className="mr-1" />Actualiser</Button>
      </div>

      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            {([
              ["all", "Toutes les périodes"],
              ["today", "Aujourd'hui"],
              ["month", "Ce mois"],
              ["year", "Cette année"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setPeriod(k)}
                className={`px-3 py-1.5 rounded-md text-xs border ${
                  period === k ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground border-border hover:bg-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {(["all", ...STATUSES] as string[]).map((k) => (
              <button
                key={k}
                onClick={() => setStatusF(k)}
                className={`px-3 py-1.5 rounded-md text-xs border inline-flex items-center gap-1.5 ${
                  statusF === k ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground border-border hover:bg-muted"
                }`}
              >
                {k === "all" ? "Tous" : STATUS_LABELS[k] || k}
                <span className={`text-[10px] px-1.5 rounded ${statusF === k ? "bg-white/20" : "bg-muted"}`}>
                  {counts[k] ?? 0}
                </span>
              </button>
            ))}
          </div>

          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher par ID, lien, service, utilisateur..."
            className="w-full h-9 px-3 text-sm rounded-md border bg-background"
          />
        </CardContent>
      </Card>

      {loading ? (
        <LogoLoader />
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground py-8">Aucune commande pour ces filtres.</p>
      ) : (
        <div className="space-y-3">
          {filtered.map(o => {
            const s = (o.status || "").toLowerCase();
            return (
              <Card key={o.id}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm">{o.service_name}</p>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATUS_STYLES[s] || "bg-gray-100 text-gray-800 border-gray-300"}`}>
                          {STATUS_LABELS[s] || o.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {o.service_category} · {Number(o.quantity).toLocaleString()} unités · {Number(o.price).toLocaleString()} FCFA
                      </p>
                      <p className="text-xs text-muted-foreground truncate">🔗 <a href={o.link} target="_blank" rel="noreferrer" className="text-primary hover:underline">{o.link}</a></p>
                      <div className="flex gap-3 mt-1 flex-wrap text-[11px] text-muted-foreground">
                        <span>👤 {usernames[o.user_id] || o.user_id?.slice(0, 8) || "—"}</span>
                        <span>📅 {new Date(o.created_at).toLocaleDateString("fr-FR")} {new Date(o.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                        {o.external_order_id && <span className="font-mono">#{o.external_order_id}</span>}
                      </div>
                    </div>
                    <select
                      value={s === "cancelled" ? "canceled" : s}
                      onChange={e => updateStatus(o.id, e.target.value)}
                      className="text-xs border rounded px-2 py-1 bg-background"
                    >
                      {STATUSES.map(st => <option key={st} value={st}>{STATUS_LABELS[st]}</option>)}
                    </select>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

const AdminPayments = () => {
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from("payments").select("*, profiles(username, email)").order("created_at", { ascending: false }).limit(100);
    setPayments(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const validate = async (payment: any) => {
    if (payment.status === "completed") { toast.error("Déjà validé"); return; }
    const { data: prof } = await supabase.from("profiles").select("balance").eq("user_id", payment.user_id).single();
    if (prof) {
      await supabase.from("profiles").update({ balance: Number(prof.balance) + Number(payment.amount) }).eq("user_id", payment.user_id);
    }
    await supabase.from("payments").update({ status: "completed" }).eq("id", payment.id);
    toast.success(`${Number(payment.amount).toLocaleString()} FCFA crédités`);
    load();
  };

  const reject = async (id: string) => {
    await supabase.from("payments").update({ status: "rejected" }).eq("id", id);
    toast.success("Paiement rejeté");
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{payments.length} paiement(s)</p>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw size={14} className="mr-1" />Actualiser</Button>
      </div>
      {loading ? <LogoLoader /> : (
        <div className="space-y-3">
          {payments.map(p => (
            <Card key={p.id}>
              <CardContent className="p-4 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm">{Number(p.amount).toLocaleString()} FCFA</p>
                  <p className="text-xs text-muted-foreground">{(p.profiles as any)?.username} · {formatPaymentMethod(p.method)}</p>
                  <p className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleDateString("fr-FR")}</p>
                  {p.reference && <p className="text-xs text-muted-foreground">Réf: {p.reference}</p>}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${p.status === "completed" ? "bg-green-100 text-green-700" : p.status === "rejected" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                  {p.status === "completed" ? "Validé" : p.status === "rejected" ? "Rejeté" : "En attente"}
                </span>
                {p.status === "pending" && (
                  <div className="flex gap-1">
                    <Button size="sm" className="h-7 px-2 text-xs" onClick={() => validate(p)}>Valider</Button>
                    <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => reject(p.id)}>Rejeter</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// --- SMM Panel pricing editor (admin) ----------------------------------------
const PLATFORM_FILTERS = [
  { key: "all", label: "Tous" },
  { key: "instagram", label: "Instagram", match: /instagram/i },
  { key: "tiktok", label: "TikTok", match: /tiktok|tik tok/i },
  { key: "youtube", label: "YouTube", match: /youtube|yt /i },
  { key: "facebook", label: "Facebook", match: /facebook|fb /i },
  { key: "telegram", label: "Telegram", match: /telegram/i },
  { key: "whatsapp", label: "WhatsApp", match: /whatsapp/i },
  { key: "spotify", label: "Spotify", match: /spotify/i },
  { key: "twitter", label: "Twitter/X", match: /twitter|^x | x$/i },
];

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Provider config (display order, enabled flag, header texts) editor.
// Each row corresponds to one of the three SMM providers.
// ---------------------------------------------------------------------------
const AdminProvidersConfig = ({ onChanged }: { onChanged?: () => void }) => {
  const [rows, setRows] = useState<AdminProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Partial<AdminProviderConfig>>>({});

  const load = async () => {
    setLoading(true);
    try {
      const list = await fetchAdminProviders();
      // Sort by display_order so the admin sees rows in the same order they
      // appear to users on the picker.
      setRows(
        list.sort(
          (a, b) =>
            (a.display_order || a.provider_id) - (b.display_order || b.provider_id),
        ),
      );
      setDrafts({});
    } catch (e: any) {
      toast.error(e.message || "Erreur chargement fournisseurs");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const setDraft = (id: number, patch: Partial<AdminProviderConfig>) => {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  };

  const save = async (row: AdminProviderConfig) => {
    const draft = drafts[row.provider_id] || {};
    if (Object.keys(draft).length === 0) return;
    setSavingId(row.provider_id);
    try {
      await updateAdminProvider(row.provider_id, {
        display_order: draft.display_order,
        enabled: draft.enabled,
        header_title: draft.header_title,
        header_text: draft.header_text,
      });
      toast.success(`${providerAdminName(row.provider_id)} mis à jour`);
      await load();
      onChanged?.();
      // Notify the dashboard balance row so it re-fetches and re-orders
      // its 3 cards without requiring a tab switch / page reload.
      window.dispatchEvent(new CustomEvent("providers:reordered"));
    } catch (e: any) {
      toast.error(e.message || "Erreur");
    } finally {
      setSavingId(null);
    }
  };

  const v = <K extends keyof AdminProviderConfig>(row: AdminProviderConfig, key: K): AdminProviderConfig[K] => {
    const d = drafts[row.provider_id];
    return (d && d[key] !== undefined ? d[key] : row[key]) as AdminProviderConfig[K];
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Fournisseurs SMM</CardTitle>
        <p className="text-xs text-muted-foreground">
          Active/désactive un fournisseur, change son ordre d'affichage et personnalise son titre + texte
          d'introduction (vu par tes utilisateurs sur la page « Choisissez votre fournisseur »).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="animate-spin text-primary" size={20} />
          </div>
        ) : (
          rows.map((row) => {
            const dirty = !!drafts[row.provider_id] && Object.keys(drafts[row.provider_id]!).length > 0;
            return (
              <div key={row.provider_id} className="border rounded-lg p-3 space-y-2 bg-background">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold">{providerAdminName(row.provider_id)}</span>
                  <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">#{row.provider_id}</span>
                  {row.configured ? (
                    <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">
                      Clés API en place
                    </span>
                  ) : (
                    <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full">
                      Clés API manquantes — désactivé
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setDraft(row.provider_id, { enabled: !v(row, "enabled") })}
                    disabled={!row.configured}
                    className={`ml-auto text-xs flex items-center gap-1 px-2 py-1 rounded border ${
                      v(row, "enabled")
                        ? "bg-green-50 border-green-300 text-green-700"
                        : "bg-muted border-border text-muted-foreground"
                    } ${!row.configured ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {v(row, "enabled") ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                    {v(row, "enabled") ? "Activé" : "Désactivé"}
                  </button>
                </div>

                <div className="grid sm:grid-cols-[120px_1fr] gap-2 items-center">
                  <Label className="text-xs">Ordre d'affichage</Label>
                  <select
                    className="h-8 text-sm border rounded-md px-2 bg-background"
                    value={String(v(row, "display_order") ?? row.provider_id)}
                    onChange={(e) => setDraft(row.provider_id, { display_order: Number(e.target.value) })}
                  >
                    <option value="1">1 (premier)</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5 (dernier)</option>
                  </select>
                </div>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  Choisir un emplacement déjà pris échangera automatiquement les deux fournisseurs.
                </p>

                <div className="grid sm:grid-cols-[120px_1fr] gap-2 items-center">
                  <Label className="text-xs">Titre header</Label>
                  <Input
                    className="h-8"
                    value={String(v(row, "header_title") ?? "")}
                    onChange={(e) => setDraft(row.provider_id, { header_title: e.target.value })}
                    placeholder={providerAdminName(row.provider_id)}
                  />
                </div>

                <div className="grid sm:grid-cols-[120px_1fr] gap-2 items-start">
                  <Label className="text-xs pt-2">Texte header</Label>
                  <textarea
                    rows={2}
                    className="w-full text-sm border rounded-md px-2 py-1.5 bg-background"
                    value={String(v(row, "header_text") ?? "")}
                    onChange={(e) => setDraft(row.provider_id, { header_text: e.target.value })}
                    placeholder="Phrase courte affichée sous le titre"
                  />
                </div>

                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => save(row)}
                    disabled={!dirty || savingId === row.provider_id}
                  >
                    <Save size={13} className="mr-1" />
                    Enregistrer
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
};

const AdminServicesTab = () => {
  const [providerId, setProviderId] = useState<1 | 3 | 4 | 5>(1);
  const [bump, setBump] = useState(0);
  return (
    <div className="space-y-4">
      <AdminProvidersConfig onChanged={() => setBump((n) => n + 1)} />

      <div className="flex flex-wrap gap-2">
        {[1, 3, 4, 5].map((id) => (
          <button
            key={id}
            onClick={() => setProviderId(id as 1 | 3 | 4 | 5)}
            className={`px-3 py-1.5 rounded-md text-sm border ${
              providerId === id
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-muted"
            }`}
          >
            {providerAdminName(id)}
          </button>
        ))}
      </div>

      <AdminServices key={`${providerId}-${bump}`} providerId={providerId} />
    </div>
  );
};

const AdminServices = ({ providerId = 1 }: { providerId?: number }) => {
  const [services, setServices] = useState<SmmService[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("all");
  const [showCustomOnly, setShowCustomOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<number | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchAdminSmmPricing(providerId);
      setServices(data);
    } catch (e: any) {
      toast.error(e.message || "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [providerId]);
  useEffect(() => { setPage(1); }, [search, platform, showCustomOnly, providerId]);

  const filtered = services.filter((s) => {
    if (showCustomOnly && !s.price_is_custom) return false;
    if (platform !== "all") {
      const def = PLATFORM_FILTERS.find((p) => p.key === platform);
      if (def?.match && !def.match.test(`${s.category} ${s.name}`)) return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.category.toLowerCase().includes(q) && String(s.service) !== q) {
        return false;
      }
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSlice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const startEdit = (s: SmmService) => {
    setEditing(s.service);
    setPriceInput(String(s.price_fcfa));
  };

  const savePrice = async (s: SmmService) => {
    const p = Number(priceInput);
    if (!Number.isFinite(p) || p < 0) { toast.error("Prix invalide"); return; }
    setSavingId(s.service);
    try {
      await updateAdminSmmPricing(s.service, { price_fcfa: Math.round(p) }, providerId);
      setServices((prev) => prev.map((x) => x.service === s.service ? { ...x, price_fcfa: Math.round(p), price_is_custom: true } : x));
      setEditing(null);
      toast.success("Prix mis à jour");
    } catch (e: any) {
      toast.error(e.message || "Erreur");
    } finally {
      setSavingId(null);
    }
  };

  const toggleHidden = async (s: SmmService) => {
    setSavingId(s.service);
    try {
      await updateAdminSmmPricing(s.service, { hidden: !s.hidden, price_fcfa: s.price_fcfa }, providerId);
      setServices((prev) => prev.map((x) => x.service === s.service ? { ...x, hidden: !s.hidden } : x));
    } catch (e: any) {
      toast.error(e.message || "Erreur");
    } finally {
      setSavingId(null);
    }
  };

  const toggleFeatured = async (s: SmmService) => {
    setSavingId(s.service);
    try {
      await updateAdminSmmPricing(s.service, { featured: !s.featured, price_fcfa: s.price_fcfa }, providerId);
      setServices((prev) => prev.map((x) => x.service === s.service ? { ...x, featured: !s.featured } : x));
      toast.success(s.featured ? "Retiré des services rapides" : "Mis en avant comme service rapide");
    } catch (e: any) {
      toast.error(e.message || "Erreur");
    } finally {
      setSavingId(null);
    }
  };

  const resetPrice = async (s: SmmService) => {
    if (!confirm(`Réinitialiser le prix de "${s.name.slice(0, 60)}" au prix par défaut ?`)) return;
    setSavingId(s.service);
    try {
      await resetAdminSmmPricing(s.service, providerId);
      await load();
      toast.success("Prix réinitialisé");
    } catch (e: any) {
      toast.error(e.message || "Erreur");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <SmmProviderBalanceCard providerId={providerId} />

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <p className="text-sm font-medium">{services.length.toLocaleString()} services — {providerAdminName(providerId)}</p>
          <p className="text-xs text-muted-foreground">{services.filter((s) => s.price_is_custom).length} avec prix personnalisé</p>
        </div>
        <div className="flex items-center gap-2">
          {providerId === 4 && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const customCount = services.filter((s) => s.price_is_custom).length;
                if (customCount === 0) {
                  toast.info("Aucun prix personnalisé à réajuster");
                  return;
                }
                if (!confirm(
                  `Réajuster les ${customCount} prix personnalisés Peakerr en les multipliant par 1000/700 ≈ 1.4286 ?\n\n` +
                  `Exemple : un prix custom de 700 FCFA deviendra 1000 FCFA.\n\n` +
                  `Cette action est irréversible (il faudrait diviser par 1.4286 pour revenir).`,
                )) return;
                try {
                  const r = await rescaleAdminSmmPricing(4, 1000 / 700);
                  toast.success(`${r.updated} prix Peakerr réajustés`);
                  await load();
                } catch (e: any) {
                  toast.error(e.message || "Erreur lors du réajustement");
                }
              }}
              disabled={loading}
              className="text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
            >
              ×1000/700 prix custom
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw size={14} className={`mr-1 ${loading ? "animate-spin" : ""}`} />Actualiser
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un service (nom, catégorie ou ID)…"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORM_FILTERS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPlatform(p.key)}
                className={`px-2.5 py-1 rounded-md text-xs border ${
                  platform === p.key ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={() => setShowCustomOnly((v) => !v)}
              className={`px-2.5 py-1 rounded-md text-xs border ml-2 ${
                showCustomOnly ? "bg-amber-500 text-white border-amber-500" : "bg-background hover:bg-muted"
              }`}
            >
              ⭐ Prix personnalisés
            </button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <LogoLoader />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {filtered.length.toLocaleString()} résultat(s) — page {page}/{totalPages}
          </p>
          <div className="space-y-2">
            {pageSlice.map((s) => (
              <Card key={s.service} className={s.hidden ? "opacity-60 border-dashed" : ""}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded">#{s.service}</span>
                        <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full">{s.category}</span>
                        {s.price_is_custom && (
                          <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full">⭐ Personnalisé</span>
                        )}
                        {s.featured && (
                          <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">⚡ Rapide</span>
                        )}
                        {s.hidden && (
                          <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">Masqué</span>
                        )}
                      </div>
                      <p className="font-medium text-sm mt-1 leading-snug">{s.name}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Min {Number(s.min).toLocaleString()} · Max {Number(s.max).toLocaleString()} · Coût fournisseur ${Number(s.rate).toFixed(4)} / 1k
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {editing === s.service ? (
                        <>
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={0}
                              value={priceInput}
                              onChange={(e) => setPriceInput(e.target.value)}
                              className="h-8 w-24"
                              autoFocus
                            />
                            <span className="text-xs text-muted-foreground whitespace-nowrap">F/1k</span>
                          </div>
                          <Button size="sm" className="h-8 px-2" onClick={() => savePrice(s)} disabled={savingId === s.service}>
                            <Save size={13} />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setEditing(null)}>
                            <X size={13} />
                          </Button>
                        </>
                      ) : (
                        <>
                          <div className="text-right">
                            <p className="text-sm font-bold text-primary whitespace-nowrap">
                              {s.price_fcfa.toLocaleString()} FCFA
                            </p>
                            <p className="text-[10px] text-muted-foreground">par 1 000</p>
                          </div>
                          <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => startEdit(s)} title="Modifier le prix">
                            <Edit2 size={13} />
                          </Button>
                          {s.price_is_custom && (
                            <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => resetPrice(s)} title="Réinitialiser au prix par défaut">
                              <RotateCcw size={13} />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className={`h-8 px-2 ${s.featured ? "border-amber-400 bg-amber-50" : ""}`}
                            onClick={() => toggleFeatured(s)}
                            disabled={savingId === s.service}
                            title={s.featured ? "Retirer de \"Rapide\"" : "Marquer comme service rapide"}
                          >
                            <span className="text-[12px]">{s.featured ? "⚡" : "○"}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2"
                            onClick={() => toggleHidden(s)}
                            disabled={savingId === s.service}
                            title={s.hidden ? "Afficher" : "Masquer"}
                          >
                            {s.hidden ? <ToggleLeft size={14} className="text-red-500" /> : <ToggleRight size={14} className="text-green-600" />}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
            {pageSlice.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">Aucun service ne correspond aux filtres.</p>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                ← Précédent
              </Button>
              <span className="text-xs text-muted-foreground">{page} / {totalPages}</span>
              <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Suivant →
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const SECTION_LABELS: Record<string, string> = {
  hero: "🖼️ Section Hero (page d'accueil)",
  services: "📱 Section Services",
  "fonctionnalités": "⚡ Fonctionnalités",
  tarifs: "💰 Tarifs",
  footer: "🦶 Pied de page",
  navigation: "🧭 Navigation",
  auth_login: "🔐 Page de connexion",
  auth_signup: "📝 Page d'inscription",
};

const AdminContent = () => {
  const [content, setContent] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [urlErrors, setUrlErrors] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState<string | null>(null);

  const uploadImage = async (item: any, file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Le fichier doit être une image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image trop lourde (5 Mo max).");
      return;
    }
    setUploading(item.id);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${item.key}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("site-images")
        .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("site-images").getPublicUrl(path);
      const url = pub.publicUrl;
      const { error: dbErr } = await supabase
        .from("site_content")
        .update({ value: url })
        .eq("id", item.id);
      if (dbErr) throw dbErr;
      setContent((prev) => prev.map((c) => (c.id === item.id ? { ...c, value: url } : c)));
      setUrlErrors((prev) => ({ ...prev, [item.id]: false }));
      invalidateSiteContentCache();
      setSaved(item.id);
      setTimeout(() => setSaved(null), 2000);
      toast.success(`✅ Image "${item.label}" mise à jour`);
    } catch (e: any) {
      toast.error(e?.message || "Échec du téléversement");
    } finally {
      setUploading(null);
    }
  };

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from("site_content").select("*").order("section");
    setContent(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const update = (id: string, value: string) => {
    setContent(content.map(c => c.id === id ? { ...c, value } : c));
    setUrlErrors(prev => ({ ...prev, [id]: false }));
  };

  const save = async (item: any) => {
    setSaving(item.id);
    const { error } = await supabase.from("site_content").update({ value: item.value }).eq("id", item.id);
    setSaving(null);
    if (error) { toast.error(error.message); return; }
    invalidateSiteContentCache();
    setSaved(item.id);
    setTimeout(() => setSaved(null), 2000);
    toast.success(`✅ "${item.label}" mis à jour`);
  };

  const grouped = content.reduce((acc: any, c) => {
    if (!acc[c.section]) acc[c.section] = [];
    acc[c.section].push(c);
    return acc;
  }, {});

  const imageCount = content.filter(c => c.type === "image").length;
  const textCount = content.filter(c => c.type === "text").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted px-3 py-1.5 rounded-full">
          <Image size={14} /> {imageCount} image(s)
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted px-3 py-1.5 rounded-full">
          <Type size={14} /> {textCount} texte(s)
        </div>
        <p className="text-xs text-muted-foreground">Collez une URL d'image pour remplacer les visuels du site.</p>
      </div>

      {loading ? (
        <LogoLoader />
      ) : (
        Object.entries(grouped).map(([section, items]: [string, any]) => (
          <Card key={section}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">
                {SECTION_LABELS[section] || section}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {items.map((item: any) => (
                <div key={item.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    {item.type === "image"
                      ? <Image size={13} className="text-accent" />
                      : <Type size={13} className="text-muted-foreground" />
                    }
                    <Label className="text-xs font-medium">{item.label}</Label>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${item.type === "image" ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground"}`}>
                      {item.type === "image" ? "Image" : "Texte"}
                    </span>
                  </div>

                  {item.type === "image" && (
                    <div className="flex gap-3 items-start">
                      <div className="shrink-0 w-24 h-16 rounded-lg border border-border bg-muted overflow-hidden flex items-center justify-center">
                        {item.value && !urlErrors[item.id] ? (
                          <img
                            src={item.value}
                            alt={item.label}
                            className="w-full h-full object-cover"
                            onError={() => setUrlErrors(prev => ({ ...prev, [item.id]: true }))}
                          />
                        ) : (
                          <div className="text-center text-muted-foreground">
                            <Image size={20} className="mx-auto mb-1 opacity-40" />
                            <p className="text-xs opacity-60">{urlErrors[item.id] ? "URL invalide" : "Aucune image"}</p>
                          </div>
                        )}
                      </div>
                      <div className="flex-1 space-y-2">
                        {/* Bouton upload — méthode principale */}
                        <div>
                          <input
                            type="file"
                            accept="image/*"
                            id={`file-${item.id}`}
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadImage(item, f);
                              e.target.value = "";
                            }}
                          />
                          <label
                            htmlFor={`file-${item.id}`}
                            className={`inline-flex items-center gap-2 px-3 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium cursor-pointer hover:opacity-90 transition ${uploading === item.id ? "opacity-60 cursor-wait" : ""}`}
                          >
                            {uploading === item.id ? (
                              <><RefreshCw size={13} className="animate-spin" /> Téléversement…</>
                            ) : (
                              <><Image size={13} /> Téléverser une image</>
                            )}
                          </label>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            JPG / PNG / WebP — 5 Mo max. L'image est hébergée sur Supabase Storage.
                          </p>
                        </div>

                        {/* Champ URL — méthode avancée (optionnelle) */}
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition">
                            Ou utiliser une URL externe
                          </summary>
                          <div className="flex gap-2 mt-2">
                            <Input
                              value={item.value}
                              onChange={e => update(item.id, e.target.value)}
                              placeholder="https://exemple.com/image.jpg"
                              className={`h-9 text-sm ${urlErrors[item.id] ? "border-red-400" : ""}`}
                            />
                            <Button
                              size="sm"
                              className="h-9 px-3 shrink-0"
                              onClick={() => save(item)}
                              disabled={saving === item.id}
                            >
                              {saved === item.id
                                ? <CheckCircle2 size={14} className="text-green-300" />
                                : saving === item.id
                                ? <RefreshCw size={13} className="animate-spin" />
                                : <Save size={13} />
                              }
                            </Button>
                          </div>
                        </details>
                      </div>
                    </div>
                  )}

                  {item.type === "text" && (
                    <div className="flex gap-2">
                      <Input
                        value={item.value}
                        onChange={e => update(item.id, e.target.value)}
                        className="flex-1 h-9 text-sm"
                      />
                      <Button
                        size="sm"
                        className="h-9 px-3 shrink-0"
                        onClick={() => save(item)}
                        disabled={saving === item.id}
                      >
                        {saved === item.id
                          ? <CheckCircle2 size={14} className="text-green-300" />
                          : saving === item.id
                          ? <RefreshCw size={13} className="animate-spin" />
                          : <Save size={13} />
                        }
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
};

// =====================================================================
// ADMIN — Section "Devises" : taux de conversion configurables
// =====================================================================

interface CurrencyRate {
  country: string;
  name: string;
  currency: string;
  symbol: string;
  fcfaPerUnit: number;
  default: number;
}

const AdminCurrencies = () => {
  const [rates, setRates] = useState<CurrencyRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await authedFetch("/api/admin/currencies");
      const json = await data.json();
      const rs: CurrencyRate[] = json.rates ?? [];
      setRates(rs);
      const vals: Record<string, string> = {};
      for (const r of rs) vals[r.country] = String(r.fcfaPerUnit);
      setEditValues(vals);
    } catch {
      toast.error("Impossible de charger les taux");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (country: string) => {
    const raw = editValues[country] ?? "";
    const val = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(val) || val <= 0) {
      toast.error("Taux invalide — entrez un nombre positif");
      return;
    }
    setSaving(country);
    try {
      const r = await authedFetch("/api/admin/currencies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country, fcfaPerUnit: val }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error(j.error ?? "Sauvegarde impossible");
        return;
      }
      setRates(prev => prev.map(rt => rt.country === country ? { ...rt, fcfaPerUnit: val } : rt));
      setSaved(country);
      setTimeout(() => setSaved(null), 2000);
      toast.success(`Taux ${country} mis à jour`);
    } catch {
      toast.error("Erreur réseau");
    } finally {
      setSaving(null);
    }
  };

  const reset = async (country: string, defaultRate: number) => {
    setSaving(country);
    try {
      const r = await authedFetch(`/api/admin/currencies/${country}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error(j.error ?? "Réinitialisation impossible");
        return;
      }
      setRates(prev => prev.map(rt => rt.country === country ? { ...rt, fcfaPerUnit: defaultRate } : rt));
      setEditValues(prev => ({ ...prev, [country]: String(defaultRate) }));
      setSaved(country);
      setTimeout(() => setSaved(null), 2000);
      toast.success(`Taux ${country} réinitialisé`);
    } catch {
      toast.error("Erreur réseau");
    } finally {
      setSaving(null);
    }
  };

  const isModified = (r: CurrencyRate) => {
    const v = parseFloat((editValues[r.country] ?? "").replace(",", "."));
    return Number.isFinite(v) && Math.abs(v - r.fcfaPerUnit) > 1e-9;
  };

  const isCustom = (r: CurrencyRate) => Math.abs(r.fcfaPerUnit - r.default) > 1e-9;

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Taux de conversion non-CFA
            <Button size="sm" variant="ghost" onClick={load} className="h-7 px-2 ml-auto">
              <RefreshCw size={13} />
            </Button>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Seules les devises hors zone CFA nécessitent un taux de conversion. Les modifications sont
            appliquées immédiatement aux prochains dépôts, sans redéploiement.
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LogoLoader />
          ) : (
            <div className="space-y-4">
              {rates.map(r => (
                <div key={r.country} className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-sm">{r.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{r.currency}</span>
                      {isCustom(r) && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 text-amber-700 text-[10px] font-medium px-1.5 py-0.5">
                          Personnalisé
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">Défaut : {r.default}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    1 {r.symbol} = <strong>{r.fcfaPerUnit}</strong> FCFA&nbsp;
                    (équivalent : 1 FCFA = {r.fcfaPerUnit > 0 ? (1 / r.fcfaPerUnit).toFixed(4) : "—"} {r.symbol})
                  </div>
                  <div className="flex gap-2 items-center">
                    <div className="flex-1">
                      <Label className="text-xs">Nouveau taux (1 {r.symbol} = X FCFA)</Label>
                      <Input
                        type="number"
                        min="0.000001"
                        step="0.0001"
                        value={editValues[r.country] ?? ""}
                        onChange={e => setEditValues(prev => ({ ...prev, [r.country]: e.target.value }))}
                        className="mt-1 h-8 text-sm"
                        placeholder={String(r.default)}
                      />
                    </div>
                    <div className="flex gap-1 self-end">
                      <Button
                        size="sm"
                        className="h-8 px-3"
                        onClick={() => save(r.country)}
                        disabled={saving === r.country || !isModified(r)}
                      >
                        {saved === r.country ? (
                          <CheckCircle2 size={13} className="text-green-300" />
                        ) : saving === r.country ? (
                          <RefreshCw size={13} className="animate-spin" />
                        ) : (
                          <Save size={13} />
                        )}
                      </Button>
                      {isCustom(r) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2"
                          title="Remettre le taux par défaut"
                          onClick={() => reset(r.country, r.default)}
                          disabled={saving === r.country}
                        >
                          <RotateCcw size={13} />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="rounded-md bg-muted px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">Comment fonctionne la conversion</p>
        <p>Le solde est toujours stocké en FCFA. Lorsqu'un dépôt est reçu d'un pays non-CFA (ex : Congo RDC en CDF),
        le montant est converti en FCFA selon le taux configuré ici avant d'être crédité au compte de l'utilisateur.</p>
        <p>Les pays XOF/XAF (zone CFA) ont un taux fixe de 1:1 et ne sont pas modifiables.</p>
      </div>
    </div>
  );
};

const AdminSettings = () => {
  const [settings, setSettings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase
      .from("settings")
      .select("key, value")
      .then(({ data }) => {
        setSettings(data || []);
        setLoading(false);
      });
  }, []);

  const update = (key: string, value: string) => {
    setSettings(settings.map(s => s.key === key ? { ...s, value } : s));
  };

  const saveAll = async () => {
    setSaving(true);
    for (const s of settings) {
      await supabase.from("settings").update({ value: s.value }).eq("key", s.key);
    }
    setSaving(false);
    toast.success("Paramètres enregistrés");
  };

  const LABELS: Record<string, string> = {
    smm_api_url: "URL API SMM",
    smm_api_key: "Clé API SMM",
  };

  return (
    <div className="space-y-4 max-w-xl">
      {loading ? <LogoLoader /> : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-sm">API SMM</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {settings.filter(s => s.key.startsWith("smm")).map(s => (
                <div key={s.key}>
                  <Label className="text-xs">{LABELS[s.key] || s.key}</Label>
                  <Input value={s.value} onChange={e => update(s.key, e.target.value)} className="mt-1 h-8 text-sm" />
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Mobile Money</CardTitle></CardHeader>
            <CardContent>
              <div className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Gestion via variables d'environnement</p>
                <p>Les identifiants du prestataire de paiement (<code>AFRIBAPAY_API_USER</code>, <code>AFRIBAPAY_API_KEY</code>, <code>AFRIBAPAY_MERCHANT_KEY</code>) sont configurés en tant que secrets serveur et ne sont pas stockés dans la base de données. La signature du webhook utilise <code>AFRIBAPAY_API_KEY</code> (HMAC-SHA256). La Guinée et la R.D.C. sont exclues de la liste des pays.</p>
              </div>
            </CardContent>
          </Card>
          <Button onClick={saveAll} disabled={saving} className="w-full">
            {saving ? "Enregistrement..." : "Enregistrer tous les paramètres"}
          </Button>
        </>
      )}
    </div>
  );
};

// =====================================================================
// ADMIN — Section "Bonus" : liste filtrée des dépôts + bonus
// =====================================================================

const bonusStatusMap: Record<string, { label: string; color: string }> = {
  credited: { label: "Crédité", color: "bg-green-100 text-green-700" },
  pending: { label: "À créditer", color: "bg-amber-100 text-amber-700" },
  not_eligible: { label: "Non éligible", color: "bg-gray-100 text-gray-600" },
};

type StatusValue = "completed" | "failed" | "rejected" | "pending";
const STATUS_LABEL: Record<StatusValue, string> = {
  completed: "Validé (créditer)",
  pending: "En attente",
  rejected: "Rejeté",
  failed: "Échoué",
};

const AdminBonus = () => {
  const [data, setData] = useState<AdminDepositsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rateOverrides, setRateOverrides] = useState<Record<string, number>>({});

  // Filtres combinables
  const [statusF, setStatusF] = useState<"all" | StatusValue>("all");
  const [bonusF, setBonusF] = useState<"all" | "credited" | "pending" | "not_eligible">("all");
  const [period, setPeriod] = useState<"today" | "7d" | "30d" | "all">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [minUserDeposits, setMinUserDeposits] = useState("");

  // Confirmation pour TOUT changement de statut
  const [pendingChange, setPendingChange] = useState<
    | { id: string; nextStatus: StatusValue; current: AdminDeposit }
    | null
  >(null);
  // Confirmation pour crédit bonus manuel
  const [pendingBonus, setPendingBonus] = useState<AdminDeposit | null>(null);

  useEffect(() => {
    authedFetch("/api/admin/currencies")
      .then(r => r.json())
      .then((json: { rates?: Array<{ country: string; fcfaPerUnit: number }> }) => {
        const map: Record<string, number> = {};
        for (const r of json.rates ?? []) map[r.country.toUpperCase()] = r.fcfaPerUnit;
        setRateOverrides(map);
      })
      .catch(() => { /* silent — falls back to defaults */ });
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetchAdminDeposits({
        status: statusF,
        bonus_status: bonusF,
        period,
        from: from || undefined,
        to: to || undefined,
        search: search || undefined,
        min_amount: minAmount ? Number(minAmount) : undefined,
        min_user_deposits: minUserDeposits ? Number(minUserDeposits) : undefined,
        limit: 500,
      });
      setData(r);
    } catch (e: any) {
      toast.error(e.message || "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  // Recharger quand on change la période rapide (cohérent avec un comportement de "chip")
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [period]);

  const applyStatusChange = async () => {
    if (!pendingChange) return;
    const { id, nextStatus } = pendingChange;
    setBusyId(id);
    try {
      const r = await adminSetDepositStatus(id, nextStatus);
      if (r.already_credited) {
        toast.info("Ce dépôt était déjà crédité.");
      } else if (nextStatus === "completed") {
        const bonusMsg = r.bonus_credited ? ` (+${r.bonus_credited} FCFA bonus)` : "";
        toast.success(`Dépôt validé${bonusMsg}.`);
      } else {
        toast.success(`Statut changé en « ${STATUS_LABEL[nextStatus]} ».`);
      }
      load();
    } catch (e: any) {
      toast.error(e.message || "Échec du changement de statut");
    } finally {
      setBusyId(null);
      setPendingChange(null);
    }
  };

  const applyCreditBonus = async () => {
    if (!pendingBonus) return;
    const id = pendingBonus.id;
    setBusyId(id);
    try {
      const r = await adminCreditBonus(id);
      if (r.already_credited) toast.info("Bonus déjà crédité.");
      else toast.success(`Bonus de ${r.bonus_credited} FCFA crédité.`);
      load();
    } catch (e: any) {
      toast.error(e.message || "Échec du crédit du bonus");
    } finally {
      setBusyId(null);
      setPendingBonus(null);
    }
  };

  const resetFilters = () => {
    setStatusF("all"); setBonusF("all"); setPeriod("all");
    setFrom(""); setTo(""); setSearch(""); setMinAmount(""); setMinUserDeposits("");
  };

  const c = data?.counters;
  const rule = data?.bonus_rule;

  return (
    <div className="space-y-4">
      {/* Bandeau règle */}
      <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-sm flex items-start gap-3">
        <Gift size={20} className="text-amber-600 mt-0.5" />
        <div>
          <p className="font-bold">
            Règle : tout dépôt ≥ {(rule?.threshold_fcfa ?? 5000).toLocaleString()} FCFA confirmé
            crédite un bonus de +{(rule?.bonus_fcfa ?? 200).toLocaleString()} FCFA automatiquement.
          </p>
          <p className="text-amber-800/90 text-xs mt-0.5">
            Le bonus est appliqué une seule fois par dépôt (idempotent). Vous pouvez forcer le crédit du bonus pour les dépôts éligibles non encore récompensés.
          </p>
        </div>
      </div>

      {/* Compteurs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Dépôts (filtre)</p>
          <p className="text-xl font-bold mt-1">{(c?.total ?? 0).toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground">{(c?.total_amount_fcfa ?? 0).toLocaleString()} FCFA</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Bonus crédités (FCFA)</p>
          <p className="text-xl font-bold mt-1 text-green-600">{(c?.bonus_credited_fcfa ?? 0).toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground">{(c?.bonus_credited ?? 0).toLocaleString()} dépôt(s)</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Bonus en attente</p>
          <p className="text-xl font-bold mt-1 text-amber-600">{(c?.bonus_pending ?? 0).toLocaleString()}</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Éligibles (≥ seuil)</p>
          <p className="text-xl font-bold mt-1">{(c?.bonus_eligible ?? 0).toLocaleString()}</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] text-muted-foreground uppercase">Période</p>
          <p className="text-xl font-bold mt-1 capitalize">
            {period === "all" ? "Tous" : period === "today" ? "Aujourd'hui" : period === "7d" ? "7 jours" : "30 jours"}
          </p>
        </div>
      </div>

      {/* Filtres */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase">
            <Filter size={13} /> Filtres combinables
          </div>

          {/* Période rapide */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Période :</span>
            {(["today", "7d", "30d", "all"] as const).map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={period === p ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setPeriod(p)}
              >
                {p === "today" ? "Aujourd'hui" : p === "7d" ? "7 jours" : p === "30d" ? "30 jours" : "Tous"}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div>
              <Label className="text-xs">Statut paiement</Label>
              <select className="mt-1 w-full text-sm border rounded-md px-2 py-1.5 bg-background" value={statusF} onChange={(e) => setStatusF(e.target.value as any)}>
                <option value="all">Tous</option>
                <option value="completed">Validé</option>
                <option value="pending">En attente</option>
                <option value="rejected">Rejeté</option>
                <option value="failed">Échoué</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Statut bonus</Label>
              <select className="mt-1 w-full text-sm border rounded-md px-2 py-1.5 bg-background" value={bonusF} onChange={(e) => setBonusF(e.target.value as any)}>
                <option value="all">Tous</option>
                <option value="credited">Crédité</option>
                <option value="pending">À créditer</option>
                <option value="not_eligible">Non éligible</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Du</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs">Au</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs">Montant min.</Label>
              <Input type="number" placeholder="ex: 5000" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs">Dépôts par utilisateur ≥</Label>
              <Input type="number" placeholder="ex: 2" value={minUserDeposits} onChange={(e) => setMinUserDeposits(e.target.value)} className="h-9" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">Recherche (username, email, référence)</Label>
              <Input placeholder="ex: john / john@... / REF-..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-9" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => load()} disabled={loading}>
              <Search size={13} className="mr-1" /> Appliquer
            </Button>
            <Button size="sm" variant="outline" onClick={() => { resetFilters(); setTimeout(load, 0); }}>
              <RotateCcw size={13} className="mr-1" /> Réinitialiser
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Liste */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="animate-spin opacity-50" /></div>
          ) : !data || data.deposits.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-10">Aucun dépôt trouvé pour ces filtres.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Date</th>
                  <th className="text-left p-2">Utilisateur</th>
                  <th className="text-right p-2">Montant</th>
                  <th className="text-center p-2">Statut</th>
                  <th className="text-center p-2">Bonus</th>
                  <th className="text-left p-2">Crédité le</th>
                  <th className="text-left p-2">Référence</th>
                  <th className="text-right p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.deposits.map((d) => {
                  const eligible = Number(d.amount) >= (data.bonus_rule?.threshold_fcfa ?? 5000);
                  const bs = d.bonus_status || (eligible ? "pending" : "not_eligible");
                  const bm = bonusStatusMap[bs] || { label: bs, color: "bg-gray-100" };
                  const ps = paymentStatusMap[d.status] || { label: d.status, color: "bg-gray-100" };
                  const canRecreditBonus = d.status === "completed" && eligible && bs !== "credited";
                  return (
                    <tr key={d.id} className="border-t hover:bg-muted/20">
                      <td className="p-2 whitespace-nowrap text-xs">{fmtTime(d.created_at)}</td>
                      <td className="p-2 text-xs">
                        <div className="font-medium">{d.user_username || "—"}</div>
                        <div className="text-[11px] text-muted-foreground">{d.user_email || d.user_id.slice(0, 8) + "…"}</div>
                        {d.country && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className="text-[11px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                              {d.country.toUpperCase()}
                            </span>
                            {d.currency && (
                              <span className="text-[11px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                                {d.currency.toUpperCase()}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-right font-semibold whitespace-nowrap">{fmtDepositAmount(Number(d.amount), d.currency, d.country, rateOverrides)}</td>
                      <td className="p-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[11px] ${ps.color}`}>{ps.label}</span>
                      </td>
                      <td className="p-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[11px] ${bm.color}`}>
                          {bm.label}{d.bonus_amount ? ` (+${d.bonus_amount})` : ""}
                        </span>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">
                        {d.bonus_credited_at ? fmtTime(d.bonus_credited_at) : "—"}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground truncate max-w-[140px]">{d.reference || "—"}</td>
                      <td className="p-2 text-right">
                        <div className="flex gap-1 justify-end items-center flex-wrap">
                          {/* Sélecteur générique de statut (avec confirmation) */}
                          <div className="relative inline-flex">
                            <select
                              className="text-xs border rounded-md pl-2 pr-7 py-1 bg-background appearance-none"
                              disabled={busyId === d.id}
                              value={d.status}
                              onChange={(e) => {
                                const next = e.target.value as StatusValue;
                                if (next === d.status) return;
                                setPendingChange({ id: d.id, nextStatus: next, current: d });
                              }}
                              title="Changer le statut"
                            >
                              {(Object.keys(STATUS_LABEL) as StatusValue[]).map((s) => (
                                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                              ))}
                            </select>
                            <ChevronDown size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 opacity-60" />
                          </div>
                          {canRecreditBonus && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-amber-400 text-amber-700 h-7 px-2"
                              disabled={busyId === d.id}
                              onClick={() => setPendingBonus(d)}
                              title="Créditer le bonus manuellement"
                            >
                              <Gift size={12} className="mr-1" /> Bonus
                            </Button>
                          )}
                          {busyId === d.id && <Loader2 size={12} className="animate-spin opacity-60 ml-1" />}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Confirmation: changement de statut */}
      <AlertDialog open={!!pendingChange} onOpenChange={(o) => !o && setPendingChange(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer le changement de statut</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingChange && (
                <>
                  Le dépôt de{" "}
                  <strong>{fmt(Number(pendingChange.current.amount))}</strong> de{" "}
                  <strong>
                    {pendingChange.current.user_username
                      || pendingChange.current.user_email
                      || pendingChange.current.user_id.slice(0, 8) + "…"}
                  </strong>{" "}
                  va passer de <em>« {STATUS_LABEL[pendingChange.current.status as StatusValue] || pendingChange.current.status} »</em>{" "}
                  à <strong>« {STATUS_LABEL[pendingChange.nextStatus]} »</strong>.
                  {pendingChange.nextStatus === "completed" && (
                    <span className="block mt-2 text-amber-700">
                      Le solde de l'utilisateur sera crédité (l'opération est idempotente — un dépôt déjà crédité ne sera pas re-crédité).
                      {Number(pendingChange.current.amount) >= (data?.bonus_rule?.threshold_fcfa ?? 5000) &&
                        ` Un bonus de +${(data?.bonus_rule?.bonus_fcfa ?? 200).toLocaleString()} FCFA sera ajouté automatiquement.`}
                    </span>
                  )}
                  {(pendingChange.nextStatus === "rejected" || pendingChange.nextStatus === "failed") &&
                    pendingChange.current.credited_at && (
                      <span className="block mt-2 text-red-600">
                        Attention : ce dépôt a déjà été crédité. Le changement de statut sera refusé pour préserver l'intégrité du solde — un remboursement manuel est nécessaire.
                      </span>
                    )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={applyStatusChange}>Confirmer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation: crédit bonus manuel */}
      <AlertDialog open={!!pendingBonus} onOpenChange={(o) => !o && setPendingBonus(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Créditer le bonus manuellement ?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingBonus && (
                <>
                  Un bonus de <strong>+{(data?.bonus_rule?.bonus_fcfa ?? 200).toLocaleString()} FCFA</strong> sera crédité au solde de{" "}
                  <strong>
                    {pendingBonus.user_username
                      || pendingBonus.user_email
                      || pendingBonus.user_id.slice(0, 8) + "…"}
                  </strong>{" "}
                  pour le dépôt de <strong>{fmt(Number(pendingBonus.amount))}</strong>.
                  L'opération est idempotente (un seul crédit possible).
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={applyCreditBonus}>Créditer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// =============================================================================
// AdminTickets — incoming cancellation / refund / intervention requests sent
// from the user's "Annuler" form on each order. Each ticket carries the
// underlying order metadata so the admin can act on it (cancel at the SMM
// provider + instant refund) directly from the detail panel.
// =============================================================================

const TICKET_ACTION_LABELS: Record<TicketActionType, string> = {
  cancel: "Annulation",
  refund: "Remboursement",
  speed_up: "Accélération",
  other: "Autre",
};

const TICKET_STATUS_STYLES: Record<string, string> = {
  open: "bg-yellow-100 text-yellow-800 border-yellow-300",
  in_progress: "bg-blue-100 text-blue-800 border-blue-300",
  resolved: "bg-green-100 text-green-800 border-green-300",
  closed: "bg-gray-100 text-gray-700 border-gray-300",
};

const TICKET_STATUS_LABELS: Record<string, string> = {
  open: "Ouvert",
  in_progress: "En cours",
  resolved: "Résolu",
  closed: "Fermé",
};

function TicketStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${
        TICKET_STATUS_STYLES[status] || "bg-gray-100 text-gray-700 border-gray-300"
      }`}
    >
      {TICKET_STATUS_LABELS[status] || status}
    </span>
  );
}

const AdminTickets = ({ onChanged }: { onChanged?: () => void }) => {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [usernames, setUsernames] = useState<Record<string, string>>({});

  const resolveUsernames = async (list: SupportTicket[]) => {
    const ids = Array.from(new Set(list.map((t) => t.user_id).filter(Boolean)));
    if (!ids.length) return;
    const { data } = await supabase
      .from("profiles")
      .select("user_id, username, email")
      .in("user_id", ids);
    if (data) {
      const map: Record<string, string> = {};
      for (const p of data) {
        map[p.user_id] = p.username || p.email || p.user_id.slice(0, 8) + "…";
      }
      setUsernames((prev) => ({ ...prev, ...map }));
    }
  };

  const refresh = async () => {
    try {
      const list = await fetchAdminTickets();
      setTickets(list);
      void resolveUsernames(list);
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || "Échec du chargement des tickets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);

    // Realtime: refresh list instantly when a ticket is inserted or updated
    const channel = supabase
      .channel("admin-tickets-list")
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "tickets" },
        () => { void refresh(); },
      )
      .subscribe();

    return () => {
      clearInterval(id);
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredTickets = useMemo(() => {
    return filter === "open"
      ? tickets.filter((t) => t.status === "open" || t.status === "in_progress")
      : tickets;
  }, [tickets, filter]);

  const active = useMemo(
    () => tickets.find((t) => t.id === activeId) || null,
    [tickets, activeId],
  );

  // Reset the response field whenever the active ticket changes
  useEffect(() => {
    setResponse(active?.admin_response || "");
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRespond = async (resolve: boolean) => {
    if (!active) return;
    if (!response.trim() && !resolve) {
      toast.error("Réponse vide");
      return;
    }
    setBusy(true);
    try {
      await adminRespondTicket(active.id, response.trim(), resolve);
      toast.success(resolve ? "Ticket fermé — l'utilisateur voit la réponse" : "Réponse envoyée à l'utilisateur");
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Échec");
    } finally {
      setBusy(false);
    }
  };

  const onClose = async () => {
    if (!active) return;
    if (!window.confirm("Fermer définitivement ce ticket ?")) return;
    setBusy(true);
    try {
      await adminCloseTicket(active.id);
      toast.success("Ticket fermé");
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Échec");
    } finally {
      setBusy(false);
    }
  };

  const onCancelOrder = async () => {
    if (!active || !active.order_external_id || !active.provider_id) {
      toast.error("Impossible d'annuler : commande ou fournisseur manquant");
      return;
    }
    const confirmMsg =
      "Annuler la commande chez le fournisseur ET rembourser instantanément l'utilisateur ?\n\n" +
      "Cette action est irréversible.";
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const r = await adminCancelOrder(active.order_external_id, active.provider_id);
      if (r.refunded) {
        toast.success(
          `Remboursé : +${(r.refunded_amount || 0).toLocaleString("fr-FR")} FCFA crédités à l'utilisateur`,
        );
      } else {
        toast.success("Commande mise à jour (déjà remboursée précédemment)");
      }
      if (!r.provider_cancel.ok) {
        toast.warning(
          `Le fournisseur a refusé l'annulation : ${r.provider_cancel.error || "erreur inconnue"}. Le remboursement a été effectué quand même.`,
        );
      }
      // Close the ticket as resolved with a system note
      const note =
        (response ? response + "\n\n" : "") +
        `[Système] Commande annulée chez le fournisseur et utilisateur remboursé${
          r.refunded_amount ? ` de ${r.refunded_amount.toLocaleString("fr-FR")} FCFA` : ""
        }.${r.provider_cancel.ok ? "" : ` Note fournisseur : ${r.provider_cancel.error}`}`;
      await adminRespondTicket(active.id, note, true);
      await refresh();
    } catch (err: any) {
      toast.error(err?.message || "Échec");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-[120px_1fr] sm:grid-cols-[200px_1fr] md:grid-cols-[320px_1fr] gap-2 md:gap-4 h-[75vh]">
      {/* Left: list */}
      <Card className="flex flex-col overflow-hidden">
        <div className="p-1.5 sm:p-2 border-b flex flex-wrap gap-1">
          {(["open", "all"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                filter === k
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {k === "open" ? "À traiter" : "Tous"}
              <span className="ml-1.5 text-[10px] opacity-70">
                {k === "open"
                  ? tickets.filter((t) => t.status === "open" || t.status === "in_progress").length
                  : tickets.length}
              </span>
            </button>
          ))}
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={refresh}>
            <RefreshCw size={12} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={18} /></div>
          ) : filteredTickets.length === 0 ? (
            <p className="text-xs text-muted-foreground p-4 text-center">Aucun ticket</p>
          ) : (
            filteredTickets.map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveId(t.id)}
                className={`w-full text-left p-2 sm:p-3 border-b hover:bg-muted/50 transition-colors ${
                  activeId === t.id ? "bg-muted" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-1.5 mb-1 flex-wrap">
                  <span className="font-mono text-[10px] sm:text-[11px] font-bold text-primary truncate">{t.short_code}</span>
                  <TicketStatusBadge status={t.status} />
                </div>
                <div className="text-[10px] sm:text-[11px] font-medium text-foreground truncate">
                  {TICKET_ACTION_LABELS[t.action_type]}
                  {t.order_external_id && (
                    <span className="hidden sm:inline text-muted-foreground ml-1">
                      · #{t.order_external_id}
                    </span>
                  )}
                </div>
                <div className="hidden sm:block text-[10px] text-muted-foreground truncate">
                  {t.service_name || "—"}
                </div>
                <div className="text-[9px] sm:text-[10px] text-muted-foreground mt-1 truncate">
                  {new Date(t.ts).toLocaleDateString("fr-FR")}
                  <span className="hidden sm:inline">{" "}{new Date(t.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </Card>

      {/* Right: detail */}
      <Card className="flex flex-col overflow-hidden">
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Sélectionnez un ticket à gauche
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <div className="p-4 border-b space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-primary">{active.short_code}</span>
                  <TicketStatusBadge status={active.status} />
                  <span className="text-[11px] text-muted-foreground">
                    {TICKET_ACTION_LABELS[active.action_type]}
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(active.ts).toLocaleString("fr-FR")}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground space-y-0.5">
                <div>
                  <strong className="text-foreground">Utilisateur :</strong>{" "}
                  <span>
                    {usernames[active.user_id]
                      ? <><strong className="text-foreground">{usernames[active.user_id]}</strong></>
                      : <span className="font-mono">{active.user_id.slice(0, 8)}…</span>}
                  </span>
                </div>
                {active.order_external_id && (
                  <div>
                    <strong className="text-foreground">Commande :</strong>{" "}
                    <span className="font-mono">#{active.order_external_id}</span>
                    {active.provider_id != null && (
                      <span className="ml-2">
                        <strong className="text-foreground">Fournisseur :</strong> #{active.provider_id}
                      </span>
                    )}
                  </div>
                )}
                {active.service_name && (
                  <div>
                    <strong className="text-foreground">Service :</strong> {active.service_name}
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/20">
              <div className="bg-white border rounded-md p-3">
                <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wide">
                  Message du client
                </div>
                <p className="text-sm whitespace-pre-wrap">{active.message}</p>
              </div>
              {active.admin_response && (
                <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                  <div className="text-[10px] text-blue-900 mb-1 uppercase tracking-wide font-medium">
                    Réponse admin
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{active.admin_response}</p>
                </div>
              )}
              {active.cancel_executed && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-md p-3 text-xs text-emerald-900">
                  Annulation exécutée le{" "}
                  {active.cancel_executed_at
                    ? new Date(active.cancel_executed_at).toLocaleString("fr-FR")
                    : ""}
                  {active.refunded_amount_fcfa != null && (
                    <> — remboursé : {active.refunded_amount_fcfa.toLocaleString("fr-FR")} FCFA</>
                  )}
                </div>
              )}
            </div>

            <div className="p-3 border-t space-y-2">
              <Textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                rows={3}
                placeholder="Votre réponse à l'utilisateur..."
                disabled={busy || active.status === "closed"}
              />
              <div className="flex flex-wrap gap-2 justify-end">
                {active.order_external_id && active.provider_id != null && active.status !== "closed" && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={onCancelOrder}
                  >
                    {busy ? <Loader2 className="animate-spin mr-1" size={14} /> : <XCircle size={14} className="mr-1" />}
                    Annuler chez le fournisseur + rembourser
                  </Button>
                )}
                {active.status !== "closed" && (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => onRespond(false)}>
                      <Send size={14} className="mr-1" /> Envoyer la réponse
                    </Button>
                    <Button variant="default" size="sm" disabled={busy} onClick={() => onRespond(true)}>
                      <CheckCircle2 size={14} className="mr-1" /> Résolu &amp; Fermer
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default function Admin() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [supportUnread, setSupportUnread] = useState(0);
  const [ticketsUnread, setTicketsUnread] = useState(0);

  useEffect(() => {
    if (loading) return;
    if (!user) { navigate("/auth"); return; }

    supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }).then(({ data }) => {
      if (!data) { navigate("/dashboard"); toast.error("Accès refusé"); }
      else setIsAdmin(true);
      setChecking(false);
    });
  }, [user, loading]);

  // Poll total unread support messages for the tab badge
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const refresh = () =>
      fetchAdminThreads()
        .then((threads) => {
          if (cancelled) return;
          const total = threads.reduce((s, t) => s + (t.unread_for_admin || 0), 0);
          setSupportUnread(total);
        })
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isAdmin]);

  // Poll open ticket count for the Tickets tab badge + Realtime instant update
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const refresh = () =>
      fetchAdminTicketsUnread()
        .then((n) => { if (!cancelled) setTicketsUnread(n); })
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, 15000);

    // Supabase Realtime: instant badge update when a new ticket is inserted
    const channel = supabase
      .channel("admin-tickets-badge")
      .on(
        "postgres_changes" as any,
        { event: "INSERT", schema: "public", table: "tickets" },
        () => {
          if (!cancelled) {
            refresh();
            toast.info("Nouveau ticket reçu — vérifiez l'onglet Tickets.", {
              duration: 6000,
            });
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(id);
      void supabase.removeChannel(channel);
    };
  }, [isAdmin]);

  if (loading || checking) {
    return <LogoLoader fullPage />;
  }

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-background admin-compact">
      <header className="bg-card border-b border-border px-6 py-4 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield size={16} className="text-primary" />
          </div>
          <div>
            <p className="font-heading font-bold text-sm">
              <span className="text-primary">BUZZ</span> <span className="text-accent">BOOSTER</span>
              <span className="ml-2 text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded">ADMIN</span>
            </p>
            <p className="text-xs text-muted-foreground">Panneau d'administration</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/dashboard")}>Tableau de bord</Button>
          <Button variant="ghost" size="sm" onClick={signOut}><LogOut size={14} /></Button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
        <Tabs defaultValue="dashboard">
          <TabsList className="grid grid-cols-3 md:grid-cols-12 mb-6 h-auto gap-1">
            <TabsTrigger value="dashboard" className="flex flex-col gap-1 py-2 text-xs"><LayoutDashboard size={15} />Tableau de bord</TabsTrigger>
            <TabsTrigger value="users" className="flex flex-col gap-1 py-2 text-xs"><Users size={15} />Utilisateurs</TabsTrigger>
            <TabsTrigger value="orders" className="flex flex-col gap-1 py-2 text-xs"><ShoppingCart size={15} />Commandes</TabsTrigger>
            <TabsTrigger value="payments" className="flex flex-col gap-1 py-2 text-xs"><CreditCard size={15} />Paiements</TabsTrigger>
            <TabsTrigger value="bonus" className="flex flex-col gap-1 py-2 text-xs"><Gift size={15} />Bonus</TabsTrigger>
            <TabsTrigger value="transactions" className="flex flex-col gap-1 py-2 text-xs"><Receipt size={15} />Transactions</TabsTrigger>
            <TabsTrigger value="support" className="flex flex-col gap-1 py-2 text-xs relative">
              <Headphones size={15} />Support
              {supportUnread > 0 && (
                <span className="absolute top-1 right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center">
                  {supportUnread}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="tickets" className="flex flex-col gap-1 py-2 text-xs relative">
              <TicketIcon size={15} />Tickets
              {ticketsUnread > 0 && (
                <span className="absolute top-1 right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center">
                  {ticketsUnread}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="services" className="flex flex-col gap-1 py-2 text-xs"><Layers size={15} />Tarifs</TabsTrigger>
            <TabsTrigger value="content" className="flex flex-col gap-1 py-2 text-xs"><FileText size={15} />Contenu</TabsTrigger>
            <TabsTrigger value="currencies" className="flex flex-col gap-1 py-2 text-xs"><Wallet size={15} />Devises</TabsTrigger>
            <TabsTrigger value="settings" className="flex flex-col gap-1 py-2 text-xs"><Settings size={15} />Paramètres</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="space-y-6">
            <AdminProvidersBalanceRow />
            <AdminEarningsSection />
          </TabsContent>
          <TabsContent value="users"><AdminUsers /></TabsContent>
          <TabsContent value="orders"><AdminOrders /></TabsContent>
          <TabsContent value="payments"><AdminPayments /></TabsContent>
          <TabsContent value="bonus"><AdminBonus /></TabsContent>
          <TabsContent value="transactions"><AdminTransactions /></TabsContent>
          <TabsContent value="support"><AdminSupport /></TabsContent>
          <TabsContent value="tickets"><AdminTickets onChanged={() => fetchAdminTicketsUnread().then(setTicketsUnread).catch(() => {})} /></TabsContent>
          <TabsContent value="services"><AdminServicesTab /></TabsContent>
          <TabsContent value="content"><AdminContent /></TabsContent>
          <TabsContent value="currencies"><AdminCurrencies /></TabsContent>
          <TabsContent value="settings"><AdminSettings /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
