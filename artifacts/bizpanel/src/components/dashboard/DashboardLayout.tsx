import { useEffect, useState } from "react";
import { useNavigate, useLocation, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { fetchUnreadCount } from "@/lib/support";
import { fetchTicketReplyUnread } from "@/lib/tickets";
import {
  LayoutDashboard, ShoppingCart, Clock, Wallet, CreditCard, Receipt,
  LogOut, Menu, X, ChevronRight, Headphones, MessageCircle, RotateCcw
} from "lucide-react";
import logoImg from "@/assets/logo-buzzbooster.png";

const menuItems = [
  { label: "Tableau de bord", href: "/dashboard", icon: LayoutDashboard, key: "home" },
  { label: "Nouvelle commande", href: "/dashboard/order", icon: ShoppingCart, key: "order" },
  { label: "Ordres", href: "/dashboard/orders", icon: Clock, key: "orders" },
  { label: "Recharger", href: "/dashboard/deposit", icon: Wallet, key: "deposit" },
  { label: "Historique paiements", href: "/dashboard/payments", icon: CreditCard, key: "payments" },
  { label: "Transactions", href: "/dashboard/transactions", icon: Receipt, key: "transactions" },
  { label: "Remboursements", href: "/dashboard/refunds", icon: RotateCcw, key: "refunds" },
  { label: "Support", href: "/dashboard/support", icon: Headphones, key: "support" },
];

export const DashboardLayout = () => {
  const { user, profile, loading, isAdmin, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadSupport, setUnreadSupport] = useState(0);

  // Admins should not access the user dashboard — redirect to admin panel
  useEffect(() => {
    if (!loading && user && isAdmin) {
      navigate("/admin", { replace: true });
    }
  }, [loading, user, isAdmin, navigate]);

  // Poll unread count = chat messages + ticket replies not yet seen
  useEffect(() => {
    if (!user || isAdmin) return;
    let cancelled = false;
    const refresh = async () => {
      const [chat, ticketReplies] = await Promise.all([
        fetchUnreadCount().catch(() => 0),
        fetchTicketReplyUnread().catch(() => 0),
      ]);
      if (!cancelled) setUnreadSupport(chat + ticketReplies);
    };
    refresh();
    const id = setInterval(refresh, 12000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user, isAdmin, location.pathname]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user) {
    navigate("/auth");
    return null;
  }

  const isActive = (href: string) =>
    href === "/dashboard"
      ? location.pathname === "/dashboard"
      : location.pathname.startsWith(href);

  return (
    <div className="min-h-screen bg-background flex">
      {/* Overlay mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col transform transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 lg:static lg:z-auto`}
      >
        <div className="p-4 border-b border-border flex items-center justify-between">
          <button onClick={() => navigate("/")} aria-label="BUZZ BOOSTER" className="flex items-center">
            <img src={logoImg} alt="BUZZ BOOSTER" className="h-9 w-auto rounded-md" />
          </button>
          <button className="lg:hidden" onClick={() => setSidebarOpen(false)}>
            <X size={20} />
          </button>
        </div>

        {/* User info */}
        <div className="p-4 border-b border-border">
          <p className="font-medium text-sm">{profile?.username || user.email}</p>
          <p className="text-xs text-muted-foreground">{user.email}</p>
          <div className="mt-2 bg-primary/10 rounded-md px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Solde</span>
            <p className="font-bold text-primary text-sm">
              {Number(profile?.balance || 0).toLocaleString()} FCFA
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="p-3 space-y-1 flex-1">
          {menuItems.map((item) => (
            <button
              key={item.href}
              onClick={() => { navigate(item.href); setSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
                isActive(item.href)
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
              {item.key === "support" && unreadSupport > 0 && (
                <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full min-w-5 h-5 px-1.5 inline-flex items-center justify-center">
                  {unreadSupport}
                </span>
              )}
              {isActive(item.href) && !(item.key === "support" && unreadSupport > 0) && (
                <ChevronRight size={14} className="ml-auto" />
              )}
            </button>
          ))}
          <Button
            size="sm"
            className="w-full justify-center gap-2 mt-2 bg-green-600 hover:bg-green-700 text-white"
            onClick={signOut}
          >
            <LogOut size={16} /> Déconnexion
          </Button>
        </nav>

      </aside>

      {/* Main content */}
      <main className="flex-1 min-h-screen flex flex-col overflow-hidden">
        <header className="bg-card border-b border-border p-4 flex items-center gap-3 sticky top-0 z-30">
          <button className="lg:hidden" onClick={() => setSidebarOpen(true)}>
            <Menu size={24} />
          </button>
          <div>
            <h1 className="font-heading text-base font-semibold">
              Bonjour, {profile?.username} 👋
            </h1>
            <p className="text-xs text-muted-foreground">Bienvenue sur BUZZ BOOSTER</p>
          </div>
          <Button size="sm" className="ml-auto" onClick={() => navigate("/dashboard/deposit")}>
            <Wallet size={14} className="mr-1" /> Recharger
          </Button>
        </header>

        <div className="flex-1 p-4 md:p-6 overflow-auto">
          <Outlet />
        </div>
      </main>

      {/* Bouton flottant Support */}
      <button
        onClick={() => navigate("/dashboard/support")}
        className="fixed bottom-4 right-4 md:bottom-6 md:right-6 z-50 w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center shadow-xl hover:scale-110 transition-transform"
        style={{ background: "hsl(190, 75%, 55%)" }}
        title="Contacter le support"
        aria-label="Support"
      >
        <MessageCircle className="text-white w-6 h-6 md:w-7 md:h-7" />
        {unreadSupport > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[20px] h-5 px-1 inline-flex items-center justify-center border-2 border-background">
            {unreadSupport}
          </span>
        )}
      </button>
    </div>
  );
};
