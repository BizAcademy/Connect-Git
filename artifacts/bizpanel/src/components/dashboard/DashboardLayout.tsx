import { useEffect, useRef, useState } from "react";
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
import { LogoLoader } from "@/components/ui/LogoLoader";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { CountrySelectModal } from "@/components/ui/CountrySelectModal";
import { formatBalance } from "@/lib/currency";
import { authedFetch } from "@/lib/authFetch";

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
  const { user, profile, loading, isAdmin, signOut, refreshProfile, patchProfile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadSupport, setUnreadSupport] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [showCountryModal, setShowCountryModal] = useState(false);

  useEffect(() => {
    setAvatarUrl(profile?.avatar_url ?? null);
  }, [profile?.avatar_url]);

  useEffect(() => {
    if (loading || !profile || profile.country) return;
    const pending = localStorage.getItem("bb_pending_country");
    if (pending) {
      authedFetch("/api/profile/country", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: pending }),
      })
        .then(async (res) => {
          if (res.ok) {
            localStorage.removeItem("bb_pending_country");
            const data = await res.json().catch(() => ({}));
            if (data.country) patchProfile({ country: data.country, currency: data.currency });
            refreshProfile().catch(() => undefined);
          } else {
            setShowCountryModal(true);
          }
        })
        .catch(() => setShowCountryModal(true));
    } else {
      setShowCountryModal(true);
    }
  }, [loading, profile]);

  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTransitioning(true);
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
    transitionTimer.current = setTimeout(() => setTransitioning(false), 500);
    return () => { if (transitionTimer.current) clearTimeout(transitionTimer.current); };
  }, [location.pathname]);

  useEffect(() => {
    if (!loading && user && isAdmin) {
      navigate("/admin", { replace: true });
    }
  }, [loading, user, isAdmin, navigate]);

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

  // Close sidebar when navigating (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Prevent body scroll when sidebar is open on mobile
  useEffect(() => {
    if (sidebarOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [sidebarOpen]);

  if (loading) {
    return <LogoLoader fullPage />;
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
      {showCountryModal && (
        <CountrySelectModal
          onSelected={(country, currency) => {
            patchProfile({ country, currency });
            setShowCountryModal(false);
            refreshProfile().catch(() => undefined);
          }}
        />
      )}

      {/* Overlay mobile — full screen, tapping it closes the drawer */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden touch-none"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — full width on small phones, fixed 280px on tablets, static on desktop */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 flex flex-col
          w-[82vw] max-w-[300px] sm:w-72
          bg-card border-r border-border
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"}
          lg:translate-x-0 lg:static lg:z-auto lg:w-64 lg:shadow-none
        `}
      >
        {/* Logo + close button */}
        <div className="h-14 px-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <button onClick={() => navigate("/")} aria-label="BUZZ BOOSTER" className="flex items-center">
            <img src={logoImg} alt="BUZZ BOOSTER" className="h-8 w-auto rounded-md" />
          </button>
          <button
            className="lg:hidden p-1.5 rounded-md hover:bg-muted transition-colors"
            onClick={() => setSidebarOpen(false)}
            aria-label="Fermer le menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* User info */}
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <AvatarUpload
              avatarUrl={avatarUrl}
              username={profile?.username}
              email={user?.email}
              size={36}
              onUpdated={(url) => setAvatarUrl(url)}
            />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm truncate leading-tight">
                {profile?.username || user.email}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
            </div>
          </div>
          <div className="mt-2.5 bg-primary/10 rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Solde</span>
            <p className="font-bold text-primary text-sm">
              {formatBalance(Number(profile?.balance || 0), profile?.country)}
            </p>
          </div>
          <Button
            size="sm"
            className="w-full mt-2 h-8 text-xs"
            onClick={() => { navigate("/dashboard/deposit"); setSidebarOpen(false); }}
          >
            <Wallet size={13} className="mr-1.5" /> Recharger mon solde
          </Button>
        </div>

        {/* Navigation */}
        <nav className="p-2.5 space-y-0.5 flex-1 overflow-y-auto">
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
              <item.icon size={16} className="shrink-0" />
              <span className="truncate">{item.label}</span>
              {item.key === "support" && unreadSupport > 0 && (
                <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full min-w-5 h-5 px-1.5 inline-flex items-center justify-center shrink-0">
                  {unreadSupport}
                </span>
              )}
              {isActive(item.href) && !(item.key === "support" && unreadSupport > 0) && (
                <ChevronRight size={14} className="ml-auto shrink-0" />
              )}
            </button>
          ))}
        </nav>

        {/* Déconnexion */}
        <div className="p-3 border-t border-border flex-shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-center gap-2 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={signOut}
          >
            <LogOut size={15} /> Déconnexion
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-h-screen flex flex-col overflow-hidden min-w-0">

        {/* Header — compact on mobile */}
        <header className="bg-card border-b border-border h-14 px-3 sm:px-4 flex items-center gap-2 sm:gap-3 sticky top-0 z-30 flex-shrink-0">
          {/* Hamburger */}
          <button
            className="lg:hidden p-1.5 rounded-md hover:bg-muted transition-colors flex-shrink-0"
            onClick={() => setSidebarOpen(true)}
            aria-label="Ouvrir le menu"
          >
            <Menu size={22} />
          </button>

          {/* Avatar */}
          <AvatarUpload
            avatarUrl={avatarUrl}
            username={profile?.username}
            email={user?.email}
            size={34}
            onUpdated={(url) => setAvatarUrl(url)}
          />

          {/* Username */}
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm leading-tight truncate">
              {profile?.username || user.email?.split("@")[0]}
            </p>
            <p className="text-[11px] text-muted-foreground leading-tight hidden sm:block">
              {formatBalance(Number(profile?.balance || 0), profile?.country)}
            </p>
          </div>

          {/* Solde visible sur très petit écran (en compact) */}
          <span className="sm:hidden text-xs font-bold text-primary whitespace-nowrap flex-shrink-0">
            {formatBalance(Number(profile?.balance || 0), profile?.country)}
          </span>

          {/* Bouton Recharger — icône seule sur xs, texte sur sm+ */}
          <Button
            size="sm"
            className="flex-shrink-0 h-8 px-2.5 sm:px-3"
            onClick={() => navigate("/dashboard/deposit")}
          >
            <Wallet size={14} className="sm:mr-1.5" />
            <span className="hidden sm:inline text-xs">Recharger</span>
          </Button>
        </header>

        {/* Page content */}
        <div className="flex-1 p-3 sm:p-4 md:p-6 overflow-auto">
          {transitioning ? <LogoLoader /> : <Outlet />}
        </div>
      </main>

      {/* Bouton flottant Support */}
      <button
        onClick={() => navigate("/dashboard/support")}
        className="fixed bottom-4 right-4 z-50 w-12 h-12 rounded-full flex items-center justify-center shadow-xl hover:scale-110 active:scale-95 transition-transform"
        style={{ background: "hsl(190, 75%, 55%)" }}
        title="Contacter le support"
        aria-label="Support"
      >
        <MessageCircle className="text-white w-6 h-6" />
        {unreadSupport > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[20px] h-5 px-1 inline-flex items-center justify-center border-2 border-background">
            {unreadSupport}
          </span>
        )}
      </button>
    </div>
  );
};
