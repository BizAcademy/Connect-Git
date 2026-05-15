import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { formatBalance } from "@/lib/currency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { ShoppingCart, Wallet, CreditCard, TrendingUp, Clock, CheckCircle2 } from "lucide-react";
import { syncOrdersStatus } from "@/lib/orderSync";
import { AvatarUpload } from "@/components/ui/AvatarUpload";

export default function DashboardHome() {
  const { user, profile, patchProfile } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState({ total: 0, pending: 0, completed: 0, spent: 0 });
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    setAvatarUrl(profile?.avatar_url ?? null);
  }, [profile?.avatar_url]);

  useEffect(() => {
    if (!user) return;

    const computeStats = (orders: any[]) => {
      setStats({
        total: orders.length,
        pending: orders.filter(o => o.status === "pending" || o.status === "processing").length,
        completed: orders.filter(o => o.status === "completed").length,
        spent: orders.reduce((sum, o) => sum + (o.price || 0), 0),
      });
      setRecentOrders(orders.slice(0, 5));
    };

    const load = async () => {
      setLoading(true);
      const [ordersRes] = await Promise.all([
        supabase.from("orders").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
        supabase.from("payments").select("amount").eq("user_id", user.id).eq("status", "completed"),
      ]);

      const orders = ordersRes.data || [];
      computeStats(orders);
      setLoading(false);

      const synced = await syncOrdersStatus(orders);
      computeStats(synced);
    };
    load();

    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [user]);

  const statusColors: Record<string, string> = {
    pending: "text-yellow-600 bg-yellow-50 border-yellow-200",
    processing: "text-blue-600 bg-blue-50 border-blue-200",
    completed: "text-green-600 bg-green-50 border-green-200",
    failed: "text-red-600 bg-red-50 border-red-200",
  };

  const statusLabels: Record<string, string> = {
    pending: "En attente",
    processing: "En cours",
    completed: "Terminé",
    failed: "Échoué",
  };

  const username = profile?.username || user?.email?.split("@")[0] || "utilisateur";

  return (
    <div className="space-y-5">

      {/* ── Bannière d'accueil ──────────────────────────────────────────── */}
      <div className="flex items-center gap-4 bg-white rounded-2xl shadow-sm border border-gray-100 px-4 py-4">
        <AvatarUpload
          avatarUrl={avatarUrl}
          username={profile?.username}
          email={user?.email}
          size={68}
          onUpdated={(url) => {
            setAvatarUrl(url);
            patchProfile({ avatar_url: url });
          }}
        />
        <div className="min-w-0">
          <p className="text-lg font-bold text-gray-900 leading-tight truncate">
            Hey <span className="text-orange-500">{username}</span> 👋
          </p>
          <p
            className="text-xs sm:text-sm font-semibold mt-0.5 leading-tight"
            style={{ color: "#1d4ed8" }}
          >
            TABLEAU DE BORD &amp; HISTORIQUE DES COMMANDES
          </p>
          <p className="text-xs text-gray-400 mt-1 hidden sm:block">
            {formatBalance(Number(profile?.balance || 0), profile?.country)} disponible
          </p>
        </div>
      </div>

      {/* ── Stats ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="w-7 h-7 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-orange-100 flex items-center justify-center shrink-0">
                <Wallet className="text-orange-500 w-3.5 h-3.5 md:w-[18px] md:h-[18px]" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] md:text-xs text-gray-500 leading-tight">Solde</p>
                <p className="text-xs md:text-base font-bold text-orange-500 truncate">
                  {formatBalance(Number(profile?.balance || 0), profile?.country)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="w-7 h-7 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
                <ShoppingCart className="text-blue-600 w-3.5 h-3.5 md:w-[18px] md:h-[18px]" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] md:text-xs text-gray-500 leading-tight">Commandes</p>
                <p className="text-xs md:text-base font-bold text-gray-800">{stats.total}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="w-7 h-7 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-yellow-100 flex items-center justify-center shrink-0">
                <Clock className="text-yellow-600 w-3.5 h-3.5 md:w-[18px] md:h-[18px]" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] md:text-xs text-gray-500 leading-tight">En cours</p>
                <p className="text-xs md:text-base font-bold text-gray-800">{stats.pending}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-2 md:p-4">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="w-7 h-7 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-green-100 flex items-center justify-center shrink-0">
                <CheckCircle2 className="text-green-600 w-3.5 h-3.5 md:w-[18px] md:h-[18px]" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] md:text-xs text-gray-500 leading-tight">Terminées</p>
                <p className="text-xs md:text-base font-bold text-gray-800">{stats.completed}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Quick actions ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 md:gap-4">
        <Button className="h-9 md:h-12 text-xs md:text-sm px-2" onClick={() => navigate("/dashboard/order")}>
          <ShoppingCart className="mr-1 md:mr-2 w-3.5 h-3.5 md:w-4 md:h-4" />
          <span className="truncate">Nouvelle commande</span>
        </Button>
        <Button variant="outline" className="h-9 md:h-12 text-xs md:text-sm px-2" onClick={() => navigate("/dashboard/deposit")}>
          <Wallet className="mr-1 md:mr-2 w-3.5 h-3.5 md:w-4 md:h-4" />
          <span className="truncate">Recharger mon solde</span>
        </Button>
      </div>

      {/* ── Recent orders ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Commandes récentes</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/orders")}>
              Voir tout
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin h-7 w-7 border-4 border-orange-400 border-t-transparent rounded-full" />
            </div>
          ) : recentOrders.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <ShoppingCart size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Aucune commande pour l'instant</p>
            </div>
          ) : (
            <div className="space-y-3">
              {recentOrders.map(order => (
                <div key={order.id} className="flex items-center justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate text-gray-800">{order.service_name}</p>
                    <p className="text-xs text-gray-400 truncate">{order.link}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${statusColors[order.status] || "text-gray-600 bg-gray-50"}`}>
                      {statusLabels[order.status] || order.status}
                    </span>
                    <p className="text-xs font-bold text-orange-500 mt-1">{order.price.toLocaleString()} F</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Affiliate ──────────────────────────────────────────────────── */}
      {Number(profile?.affiliate_earnings || 0) > 0 && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
              <TrendingUp size={18} className="text-green-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-800">Gains d'affiliation</p>
              <p className="text-xs text-gray-500">
                Vous avez gagné {Number(profile?.affiliate_earnings).toLocaleString()} FCFA en parrainages
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
