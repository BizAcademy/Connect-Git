import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { formatBalance } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import {
  ShoppingCart, Wallet, TrendingUp, Clock, CheckCircle2,
  ArrowRight, PlusCircle, BarChart2, Package,
} from "lucide-react";
import { syncOrdersStatus } from "@/lib/orderSync";
import { AvatarUpload } from "@/components/ui/AvatarUpload";

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  pending:    { label: "En attente",  cls: "text-amber-700  bg-amber-50  border-amber-200"  },
  processing: { label: "En cours",    cls: "text-blue-700   bg-blue-50   border-blue-200"   },
  completed:  { label: "Terminé",     cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  partial:    { label: "Partiel",     cls: "text-orange-700 bg-orange-50 border-orange-200"  },
  canceled:   { label: "Annulé",      cls: "text-red-700    bg-red-50    border-red-200"    },
  failed:     { label: "Échoué",      cls: "text-red-700    bg-red-50    border-red-200"    },
  refunded:   { label: "Remboursé",   cls: "text-purple-700 bg-purple-50 border-purple-200" },
};

export default function DashboardHome() {
  const { user, profile, patchProfile } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState({ total: 0, pending: 0, completed: 0 });
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => { setAvatarUrl(profile?.avatar_url ?? null); }, [profile?.avatar_url]);

  useEffect(() => {
    if (!user) return;
    const compute = (orders: any[]) => {
      setStats({
        total: orders.length,
        pending: orders.filter(o => o.status === "pending" || o.status === "processing").length,
        completed: orders.filter(o => o.status === "completed").length,
      });
      setRecentOrders(orders.slice(0, 6));
    };
    const load = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("orders").select("*").eq("user_id", user.id)
        .order("created_at", { ascending: false });
      const orders = data || [];
      compute(orders);
      setLoading(false);
      compute(await syncOrdersStatus(orders));
    };
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [user]);

  const username = profile?.username || user?.email?.split("@")[0] || "utilisateur";
  const balance  = Number(profile?.balance || 0);

  return (
    <div className="space-y-4 max-w-3xl mx-auto">

      {/* ── Carte d'accueil ─────────────────────────────────────────── */}
      <div
        className="rounded-2xl p-5 flex items-center gap-4 shadow-md"
        style={{ background: "linear-gradient(135deg,#f97316 0%,#fb923c 50%,#fdba74 100%)" }}
      >
        {/* Avatar cliquable */}
        <div className="flex-shrink-0">
          <AvatarUpload
            avatarUrl={avatarUrl}
            username={profile?.username}
            email={user?.email}
            size={72}
            onUpdated={(url) => { setAvatarUrl(url); patchProfile({ avatar_url: url }); }}
          />
        </div>

        {/* Texte */}
        <div className="flex-1 min-w-0 text-white">
          <p className="text-xs font-medium opacity-80 uppercase tracking-widest mb-0.5">
            Bienvenue
          </p>
          <p className="text-xl font-bold leading-tight truncate">
            Hey {username} 👋
          </p>
          <p className="text-[11px] font-semibold uppercase tracking-wide mt-1 opacity-90">
            Tableau de bord &amp; Historique des commandes
          </p>
        </div>

        {/* Solde */}
        <div className="hidden sm:flex flex-col items-end flex-shrink-0">
          <p className="text-[10px] uppercase tracking-wider text-white/70 font-medium">
            Mon solde
          </p>
          <p className="text-2xl font-black text-white leading-tight">
            {formatBalance(balance, profile?.country)}
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2 h-7 text-xs bg-white/20 hover:bg-white/30 text-white border-0"
            onClick={() => navigate("/dashboard/deposit")}
          >
            <PlusCircle size={12} className="mr-1" /> Recharger
          </Button>
        </div>
      </div>

      {/* Solde mobile uniquement */}
      <div className="sm:hidden flex items-center justify-between bg-white rounded-xl px-4 py-3 shadow-sm border border-orange-100">
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Mon solde</p>
          <p className="text-xl font-black text-orange-500">{formatBalance(balance, profile?.country)}</p>
        </div>
        <Button size="sm" className="h-8" onClick={() => navigate("/dashboard/deposit")}>
          <Wallet size={13} className="mr-1.5" /> Recharger
        </Button>
      </div>

      {/* ── Statistiques ────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total commandes", value: stats.total,     icon: Package,      color: "text-blue-600",    bg: "bg-blue-50"    },
          { label: "En cours",        value: stats.pending,   icon: Clock,        color: "text-amber-600",   bg: "bg-amber-50"   },
          { label: "Terminées",       value: stats.completed, icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-50" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-3 flex flex-col gap-2">
            <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center`}>
              <Icon size={16} className={color} />
            </div>
            <p className="text-xl font-black text-gray-800 leading-none">{value}</p>
            <p className="text-[10px] text-gray-400 font-medium leading-tight">{label}</p>
          </div>
        ))}
      </div>

      {/* ── Actions rapides ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => navigate("/dashboard/order")}
          className="group flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-3.5 shadow-sm hover:border-orange-300 hover:shadow-md transition-all"
        >
          <div className="w-10 h-10 rounded-xl bg-orange-50 flex items-center justify-center group-hover:bg-orange-100 transition-colors flex-shrink-0">
            <ShoppingCart size={18} className="text-orange-500" />
          </div>
          <div className="text-left min-w-0">
            <p className="text-sm font-semibold text-gray-800 truncate">Nouvelle commande</p>
            <p className="text-[10px] text-gray-400 truncate">Instagram, TikTok…</p>
          </div>
          <ArrowRight size={14} className="ml-auto text-gray-300 group-hover:text-orange-400 flex-shrink-0 transition-colors" />
        </button>

        <button
          onClick={() => navigate("/dashboard/orders")}
          className="group flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-3.5 shadow-sm hover:border-blue-300 hover:shadow-md transition-all"
        >
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center group-hover:bg-blue-100 transition-colors flex-shrink-0">
            <BarChart2 size={18} className="text-blue-500" />
          </div>
          <div className="text-left min-w-0">
            <p className="text-sm font-semibold text-gray-800 truncate">Mes commandes</p>
            <p className="text-[10px] text-gray-400 truncate">Suivre l'historique</p>
          </div>
          <ArrowRight size={14} className="ml-auto text-gray-300 group-hover:text-blue-400 flex-shrink-0 transition-colors" />
        </button>
      </div>

      {/* ── Commandes récentes ──────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-800">Commandes récentes</h2>
          <button
            onClick={() => navigate("/dashboard/orders")}
            className="text-xs text-orange-500 font-semibold hover:underline flex items-center gap-1"
          >
            Voir tout <ArrowRight size={12} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : recentOrders.length === 0 ? (
          <div className="text-center py-10">
            <ShoppingCart size={36} className="mx-auto text-gray-200 mb-3" />
            <p className="text-sm text-gray-400">Aucune commande pour l'instant</p>
            <Button size="sm" className="mt-3" onClick={() => navigate("/dashboard/order")}>
              Passer ma première commande
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {recentOrders.map(order => {
              const st = STATUS_STYLE[order.status] || { label: order.status, cls: "text-gray-600 bg-gray-50 border-gray-200" };
              return (
                <li key={order.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50/70 transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center flex-shrink-0">
                    <ShoppingCart size={14} className="text-orange-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{order.service_name}</p>
                    <p className="text-[10px] text-gray-400 truncate">{order.link}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${st.cls}`}>
                      {st.label}
                    </span>
                    <span className="text-xs font-bold text-orange-500">
                      {Number(order.price).toLocaleString()} F
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Affiliation ─────────────────────────────────────────────── */}
      {Number(profile?.affiliate_earnings || 0) > 0 && (
        <div className="flex items-center gap-4 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
            <TrendingUp size={18} className="text-emerald-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-800">Gains d'affiliation</p>
            <p className="text-xs text-emerald-600">
              {Number(profile?.affiliate_earnings).toLocaleString()} FCFA gagnés en parrainages
            </p>
          </div>
        </div>
      )}

    </div>
  );
}
