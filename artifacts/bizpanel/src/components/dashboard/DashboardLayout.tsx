import { useEffect, useRef, useState, useCallback } from "react";
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
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [showCountryModal, setShowCountryModal] = useState(false);

  // Sync avatar
  useEffect(() => {
    setAvatarUrl(profile?.avatar_url ?? null);
  }, [profile?.avatar_url]);

  // Redirect unauthenticated users — MUST be in useEffect, never in render body
  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth", { replace: true });
    }
  }, [loading, user, navigate]);

  // Redirect admins to admin panel
  useEffect(() => {
    if (!loading && user && isAdmin) {
      navigate("/admin", { replace: true });
    }
  }, [loading, user, isAdmin, navigate]);

  // Country save / modal logic
  // - New users: bb_pending_country set at signup → try API → patchProfile + refreshProfile → clear localStorage
  // - Old users (no country, no localStorage): show modal once
  // - We never show the modal if bb_pending_country is present (it will be saved)
  const countrySaveAttempted = useRef(false);
  useEffect(() => {
    if (loading || !profile) return;
    if (profile.country) {
      // Country confirmed in DB — clean up any leftover localStorage flag
      localStorage.removeItem("bb_pending_country");
      return;
    }
    if (countrySaveAttempted.current) return;
    countrySaveAttempted.current = true;

    const pending = localStorage.getItem("bb_pending_country");
    if (pending) {
      // New user: try to save country via API (retry up to 4× with backoff)
      (async () => {
        let saved = false;
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
          try {
            const res = await authedFetch("/api/profile/country", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ country: pending }),
            });
            if (res.ok) {
              const data = await res.json().catch(() => ({}));
              patchProfile({ country: data.country || pending, currency: data.currency });
              localStorage.removeItem("bb_pending_country");
              refreshProfile().catch(() => undefined);
              saved = true;
            }
          } catch { /* retry */ }
        }
        if (!saved) {
          // After all retries, show modal as last resort
          setShowCountryModal(true);
        }
      })();
    } else {
      // Old user without country: show modal
      setShowCountryModal(true);
    }
  }, [loading, profile]);

  // Close sidebar on navigation
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  // Block body scroll when sidebar is open on mobile
  useEffect(() => {
    if (sidebarOpen) {
      document.body.style.overflow = "hidden";
      document.body.style.touchAction = "none";
    } else {
      document.body.style.overflow = "";
      document.body.style.touchAction = "";
    }
    return () => {
      document.body.style.overflow = "";
      document.body.style.touchAction = "";
    };
  }, [sidebarOpen]);

  // Unread support count
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
    const id = setInterval(refresh, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user, isAdmin, location.pathname]);

  const isActive = useCallback(
    (href: string) =>
      href === "/dashboard"
        ? location.pathname === "/dashboard"
        : location.pathname.startsWith(href),
    [location.pathname],
  );

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Sidebar nav content — shared between mobile drawer and desktop panel
  const SidebarContent = (
    <>
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
              {profile?.username || user?.email}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">{user?.email}</p>
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
          onClick={() => { navigate("/dashboard/deposit"); closeSidebar(); }}
        >
          <Wallet size={13} className="mr-1.5" /> Recharger mon solde
        </Button>
      </div>

      {/* Nav items */}
      <nav className="p-2 space-y-0.5 flex-1 overflow-y-auto">
        {menuItems.map((item) => (
          <button
            key={item.href}
            onClick={() => { navigate(item.href); closeSidebar(); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
              isActive(item.href)
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <item.icon size={16} className="shrink-0" />
            <span className="truncate text-left flex-1">{item.label}</span>
            {item.key === "support" && unreadSupport > 0 ? (
              <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full min-w-5 h-5 px-1.5 inline-flex items-center justify-center shrink-0">
                {unreadSupport}
              </span>
            ) : isActive(item.href) ? (
              <ChevronRight size={14} className="ml-auto shrink-0 opacity-60" />
            ) : null}
          </button>
        ))}
      </nav>

      {/* Sign out */}
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
    </>
  );

  if (loading) return <LogoLoader fullPage />;
  // Don't render anything while redirecting (useEffect handles it)
  if (!user) return null;

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

      {/* ── MOBILE DRAWER ────────────────────────────────────────────────────
          A full-screen fixed container acts as the backdrop.
          Tapping anywhere OUTSIDE the panel closes it.
          stopPropagation on the panel prevents accidental closes.
      ───────────────────────────────────────────────────────────────────── */}
      <div
        className={`fixed inset-0 z-50 lg:hidden transition-opacity duration-200 ${
          sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden={!sidebarOpen}
        onMouseDown={closeSidebar}
        onTouchStart={closeSidebar}
      >
        {/* Semi-transparent backdrop */}
        <div className="absolute inset-0 bg-black/60" />

        {/* Sidebar panel — stop event so tapping panel doesn't close drawer */}
        <aside
          className={`absolute left-0 top-0 h-full w-[min(300px,82vw)] bg-card shadow-2xl flex flex-col transform transition-transform duration-200 ease-out ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {/* Logo + close */}
          <div className="h-14 px-4 border-b border-border flex items-center justify-between flex-shrink-0">
            <button onClick={() => navigate("/")} className="flex items-center" aria-label="Accueil">
              <img src={logoImg} alt="BUZZ BOOSTER" className="h-8 w-auto rounded-md" />
            </button>
            <button
              className="w-9 h-9 rounded-md flex items-center justify-center hover:bg-muted transition-colors"
              onClick={closeSidebar}
              aria-label="Fermer le menu"
            >
              <X size={20} />
            </button>
          </div>
          {SidebarContent}
        </aside>
      </div>

      {/* ── DESKTOP SIDEBAR (always visible on lg+) ──────────────────────── */}
      <aside className="hidden lg:flex lg:w-64 flex-col flex-shrink-0 bg-card border-r border-border">
        <div className="h-14 px-4 border-b border-border flex items-center flex-shrink-0">
          <button onClick={() => navigate("/")} className="flex items-center" aria-label="Accueil">
            <img src={logoImg} alt="BUZZ BOOSTER" className="h-8 w-auto rounded-md" />
          </button>
        </div>
        {SidebarContent}
      </aside>

      {/* ── MAIN CONTENT ─────────────────────────────────────────────────── */}
      <main className="flex-1 min-h-screen flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <header className="bg-card border-b border-border h-14 px-3 sm:px-4 flex items-center gap-2 sticky top-0 z-30 flex-shrink-0">
          {/* Hamburger (mobile only) */}
          <button
            className="lg:hidden w-9 h-9 rounded-md flex items-center justify-center hover:bg-muted transition-colors flex-shrink-0"
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

          {/* Username + balance */}
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm leading-tight truncate">
              {profile?.username || user?.email?.split("@")[0]}
            </p>
            <p className="text-[11px] text-muted-foreground hidden sm:block leading-tight">
              {formatBalance(Number(profile?.balance || 0), profile?.country)}
            </p>
          </div>

          {/* Solde compact (xs only) */}
          <span className="sm:hidden text-xs font-bold text-primary whitespace-nowrap flex-shrink-0">
            {formatBalance(Number(profile?.balance || 0), profile?.country)}
          </span>

          {/* Recharge button */}
          <Button
            size="sm"
            className="flex-shrink-0 h-8 px-2 sm:px-3"
            onClick={() => navigate("/dashboard/deposit")}
          >
            <Wallet size={14} className="sm:mr-1.5 shrink-0" />
            <span className="hidden sm:inline text-xs">Recharger</span>
          </Button>
        </header>

        {/* Page outlet */}
        <div className="flex-1 p-3 sm:p-4 md:p-6 overflow-auto">
          <Outlet />
        </div>
      </main>

      {/* Floating support button */}
      <button
        onClick={() => navigate("/dashboard/support")}
        className="fixed bottom-4 right-4 z-40 w-12 h-12 rounded-full flex items-center justify-center shadow-xl hover:scale-110 active:scale-95 transition-transform"
        style={{ background: "hsl(190, 75%, 55%)" }}
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
