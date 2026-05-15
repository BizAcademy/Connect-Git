import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams, useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchSmmServices,
  placeSmmOrder,
  fetchSmmProviders,
  getLocalPricePerK,
  type SmmService,
  type SmmProviderPublic,
} from "@/lib/smm";
import { getCurrencyInfo } from "@/lib/currency";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShoppingCart, Instagram, Youtube, Facebook, MessageCircle, Music2, Send, Globe, Search, ChevronDown, Check, Folder } from "lucide-react";

const TikTokIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
    <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.75a8.18 8.18 0 004.76 1.52V6.84a4.84 4.84 0 01-1-.15z" />
  </svg>
);

const PLATFORMS: Array<{ key: string; label: string; match: RegExp; icon: React.ReactNode; color: string }> = [
  { key: "instagram", label: "Instagram", match: /instagram/i, icon: <Instagram size={16} />, color: "linear-gradient(135deg,#f09433,#dc2743,#bc1888)" },
  { key: "tiktok", label: "TikTok", match: /tiktok|tik tok/i, icon: <TikTokIcon />, color: "#000000" },
  { key: "youtube", label: "YouTube", match: /youtube|yt /i, icon: <Youtube size={16} />, color: "#FF0000" },
  { key: "facebook", label: "Facebook", match: /facebook|fb /i, icon: <Facebook size={16} />, color: "#1877F2" },
  { key: "telegram", label: "Telegram", match: /telegram/i, icon: <Send size={16} />, color: "#2AABEE" },
  { key: "whatsapp", label: "WhatsApp", match: /whatsapp|whats app/i, icon: <MessageCircle size={16} />, color: "#25D366" },
  { key: "spotify", label: "Spotify", match: /spotify/i, icon: <Music2 size={16} />, color: "#1DB954" },
  { key: "other", label: "Autres", match: /.*/, icon: <Globe size={16} />, color: "#6B7280" },
];

function detectPlatform(category: string, name: string): string {
  const text = `${category} ${name}`;
  for (const p of PLATFORMS) if (p.key !== "other" && p.match.test(text)) return p.key;
  return "other";
}

// ── Contextual link hint based on platform + service keywords ──────────────
const PLATFORM_DOMAINS: Record<string, string> = {
  instagram: "www.instagram.com",
  tiktok: "www.tiktok.com",
  youtube: "www.youtube.com",
  facebook: "www.facebook.com",
  telegram: "t.me",
  whatsapp: "wa.me",
  spotify: "open.spotify.com",
  other: "...",
};

function getLinkHint(service: SmmService | null, platform: string): { label: string; placeholder: string } {
  const domain = PLATFORM_DOMAINS[platform] || "...";
  const pLabel = (PLATFORMS.find((p) => p.key === platform)?.label) || "";

  if (!service) {
    return {
      label: `URL de votre compte ou publication ${pLabel}`,
      placeholder: `https://${domain}/...`,
    };
  }

  const text = `${service.name} ${service.category}`.toLowerCase();

  const isFollower = /follow|abonn|subscriber|fan|membre|member/.test(text);
  const isView = /view|vue|watch|play|stream|impre|impression/.test(text);
  const isReel = /reel/.test(text);
  const isStory = /story|stories|storie/.test(text);
  const isShort = /short/.test(text);
  const isLive = /live/.test(text);
  const isLike = /like|j'aime|j'aime/.test(text);
  const isComment = /comment/.test(text);
  const isShare = /share|partage/.test(text);
  const isPost = isLike || isComment || isShare || /post|photo|publication|image/.test(text);
  const isVideo = isView || isReel || isShort || /video|vid/.test(text);

  if (isFollower) {
    const examples: Record<string, string> = {
      instagram: `https://www.instagram.com/votre_compte`,
      tiktok: `https://www.tiktok.com/@votre_compte`,
      youtube: `https://www.youtube.com/@votre_chaine`,
      facebook: `https://www.facebook.com/votre_page`,
      telegram: `https://t.me/votre_canal`,
      spotify: `https://open.spotify.com/artist/XXXX`,
    };
    return {
      label: `URL de votre compte / page ${pLabel}`,
      placeholder: examples[platform] || `https://${domain}/votre_compte`,
    };
  }

  if (isStory) {
    return {
      label: `URL de votre Story ${pLabel}`,
      placeholder: platform === "instagram"
        ? `https://www.instagram.com/stories/votre_compte/`
        : `https://${domain}/...`,
    };
  }

  if (isReel) {
    return {
      label: `URL de votre Reel ${pLabel}`,
      placeholder: platform === "instagram"
        ? `https://www.instagram.com/reel/XXXXXXXXXX/`
        : platform === "tiktok"
        ? `https://www.tiktok.com/@compte/video/1234567890`
        : `https://${domain}/...`,
    };
  }

  if (isShort) {
    return {
      label: `URL de votre Short YouTube`,
      placeholder: `https://www.youtube.com/shorts/XXXXXXXXXX`,
    };
  }

  if (isLive) {
    return {
      label: `URL de votre Live ${pLabel}`,
      placeholder: platform === "youtube"
        ? `https://www.youtube.com/watch?v=XXXXXXXXXX`
        : `https://${domain}/...`,
    };
  }

  if (isVideo) {
    const examples: Record<string, string> = {
      youtube: `https://www.youtube.com/watch?v=XXXXXXXXXX`,
      tiktok: `https://www.tiktok.com/@compte/video/1234567890`,
      instagram: `https://www.instagram.com/reel/XXXXXXXXXX/`,
      facebook: `https://www.facebook.com/watch?v=1234567890`,
    };
    return {
      label: `URL de votre vidéo ${pLabel}`,
      placeholder: examples[platform] || `https://${domain}/...`,
    };
  }

  if (isPost) {
    const examples: Record<string, string> = {
      instagram: `https://www.instagram.com/p/XXXXXXXXXX/`,
      facebook: `https://www.facebook.com/photo?fbid=1234567890`,
      tiktok: `https://www.tiktok.com/@compte/video/1234567890`,
    };
    return {
      label: `URL de votre publication ${pLabel}`,
      placeholder: examples[platform] || `https://${domain}/...`,
    };
  }

  // Generic fallback
  return {
    label: `URL de votre compte ou publication ${pLabel}`,
    placeholder: `https://${domain}/...`,
  };
}

function shortLabel(name: string, platformLabel: string): string {
  let s = name.split(/[-\[(]/)[0].trim();
  s = s.replace(new RegExp(platformLabel, "i"), "").trim();
  return s || name.slice(0, 60);
}

export default function NewOrder() {
  const { user, profile, refreshProfile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const { providerId: providerIdParam } = useParams<{ providerId?: string }>();
  const navigate = useNavigate();
  const providerId: 1 | 3 | 4 | 5 = (() => {
    const n = Number(providerIdParam);
    return n === 3 || n === 4 || n === 5 ? n : 1;
  })();
  const [providerInfo, setProviderInfo] = useState<SmmProviderPublic | null>(null);
  const [services, setServices] = useState<SmmService[]>([]);
  const [loadingServices, setLoadingServices] = useState(true);
  const [activePlatform, setActivePlatform] = useState<string>("instagram");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [categorySearch, setCategorySearch] = useState("");
  const [search, setSearch] = useState("");
  const [selectedService, setSelectedService] = useState<SmmService | null>(null);
  const [link, setLink] = useState("");
  const [quantity, setQuantity] = useState("");
  const [loading, setLoading] = useState(false);

  // Load provider header info (title + tagline) — also enforces that the
  // provider is currently enabled. If not, bounce back to the picker.
  useEffect(() => {
    let cancelled = false;
    fetchSmmProviders()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((p) => p.provider_id === providerId) || null;
        if (!found) {
          toast.error("Fournisseur indisponible.");
          navigate("/dashboard/order", { replace: true });
          return;
        }
        setProviderInfo(found);
      })
      .catch(() => { /* silent — header just stays empty */ });
    return () => { cancelled = true; };
  }, [providerId, navigate]);

  // Load SMM services for the selected provider
  useEffect(() => {
    setLoadingServices(true);
    setSelectedService(null);
    setActiveCategory(null);
    fetchSmmServices(providerId)
      .then((data) => setServices(data))
      .catch((err) => toast.error(`Erreur chargement services: ${err.message}`))
      .finally(() => setLoadingServices(false));
  }, [providerId]);

  // Pre-select service from ?service=ID — also resolve platform & category.
  useEffect(() => {
    const sid = searchParams.get("service");
    if (!sid || services.length === 0) return;
    const svc = services.find((s) => String(s.service) === String(sid));
    if (svc) {
      setSelectedService(svc);
      setActivePlatform(detectPlatform(svc.category, svc.name));
      setActiveCategory(svc.category);
      setQuantity(String(svc.min));
    }
  }, [searchParams, services]);

  const platformsWithCounts = useMemo(() => {
    return PLATFORMS.map((p) => ({
      ...p,
      count: services.filter((s) => detectPlatform(s.category, s.name) === p.key).length,
    })).filter((p) => p.count > 0);
  }, [services]);

  // Categories available for the active platform, derived from the services
  // catalogue the provider actually exposes.
  const categoriesWithCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of services) {
      if (detectPlatform(s.category, s.name) !== activePlatform) continue;
      counts.set(s.category, (counts.get(s.category) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, "fr"));
  }, [services, activePlatform]);

  // Auto-select first category whenever the platform changes (categories list updates).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (categoriesWithCounts.length === 0) {
      setActiveCategory(null);
      return;
    }
    const valid = categoriesWithCounts.map((c) => c.category);
    if (!activeCategory || !valid.includes(activeCategory)) {
      setActiveCategory(categoriesWithCounts[0]!.category);
    }
    // intentionally omitting `activeCategory` to avoid re-triggering on its own change
  }, [categoriesWithCounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return categoriesWithCounts;
    return categoriesWithCounts.filter((c) => c.category.toLowerCase().includes(q));
  }, [categoriesWithCounts, categorySearch]);

  const visibleServices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return services
      .filter((s) => detectPlatform(s.category, s.name) === activePlatform)
      .filter((s) => !activeCategory || s.category === activeCategory)
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q));
  }, [services, activePlatform, activeCategory, search]);

  // Auto-select the first service whenever the category (or platform) changes,
  // but only when there's no URL-based pre-selection active.
  const autoServiceRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchParams.get("service")) return; // URL preset takes priority
    if (visibleServices.length > 0) {
      const first = visibleServices[0]!;
      const key = `${activePlatform}|${activeCategory}|${first.service}`;
      if (autoServiceRef.current !== key) {
        autoServiceRef.current = key;
        setSelectedService(first);
        setQuantity(String(first.min));
      }
    } else {
      autoServiceRef.current = null;
      setSelectedService(null);
    }
  }, [activeCategory, activePlatform]); // eslint-disable-line react-hooks/exhaustive-deps

  const [servicesOpen, setServicesOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  const linkHint = useMemo(
    () => getLinkHint(selectedService, activePlatform),
    [selectedService, activePlatform],
  );

  const qty = Number(quantity) || 0;
  const minQ = selectedService ? Number(selectedService.min) : 0;
  const maxQ = selectedService ? Number(selectedService.max) : 0;
  const currencyInfo = getCurrencyInfo(profile?.country);
  const pricePerK = selectedService
    ? getLocalPricePerK(selectedService, currencyInfo.currency, currencyInfo.fcfaPerUnit)
    : 0;
  // localTotal: amount displayed to user in their local currency
  const localTotal = selectedService ? Math.ceil((qty / 1000) * pricePerK) : 0;
  // price: FCFA equivalent used for balance check (balance is always stored in FCFA)
  const price = Math.round(localTotal * currencyInfo.fcfaPerUnit);
  const balance = Number(profile?.balance || 0);

  const platformLabel =
    PLATFORMS.find((p) => p.key === (selectedService ? detectPlatform(selectedService.category, selectedService.name) : ""))?.label || "";

  const showCategoryCard = !loadingServices && categoriesWithCounts.length > 1;
  const stepCategoryNum = 2;
  const stepServiceNum = showCategoryCard ? 3 : 2;
  const stepDetailsNum = showCategoryCard ? 4 : 3;

  const handleOrder = async () => {
    if (!user || !selectedService) return;
    if (!link.trim()) { toast.error("Entrez le lien de votre compte/post"); return; }
    if (qty < minQ) { toast.error(`Minimum ${minQ.toLocaleString()} pour ce service`); return; }
    if (qty > maxQ) { toast.error(`Maximum ${maxQ.toLocaleString()} pour ce service`); return; }
    if (price > balance) { toast.error("Solde insuffisant. Rechargez votre compte."); return; }

    setLoading(true);
    try {
      // Place order — the server handles billing (balance check + debit) atomically
      const result = await placeSmmOrder({
        service: selectedService.service,
        link: link.trim(),
        quantity: qty,
        provider: providerId,
      });

      if (result.error || !result.order) {
        // Cas spécial : solde du fournisseur insuffisant — message vert orienté
        // utilisateur plutôt qu'une erreur rouge technique.
        if (result.provider_unavailable) {
          toast.success(
            result.error || "SERVICE MOMENTANÉMENT INDISPONIBLE VEILLEZ CHANGER DE FOURNISSEURS",
            { duration: 6000 },
          );
          setLoading(false);
          return;
        }
        throw new Error(result.error || "Le fournisseur n'a pas accepté la commande");
      }

      const providerOrderId = result.order;

      // The server now inserts the order row server-side (service role key).
      // No client-side insert needed — eliminates "invisible order" bugs caused
      // by expired JWT sessions or network drops after the provider accepted.
      if (!result.local_order_id) {
        // Insert succeeded at provider + balance was debited, but the local
        // record may be missing. Warn the user to contact support if the order
        // doesn't appear, but don't block — the admin can recover it.
        console.warn("Server did not return local_order_id for order", providerOrderId);
      }
      toast.success(
        `Commande #${providerOrderId} envoyée ! ${localTotal.toLocaleString()} ${currencyInfo.symbol} débités.`,
      );

      await refreshProfile();
      setLink("");
      setQuantity("");
      setSelectedService(null);
      setSearchParams({});
    } catch (e: any) {
      toast.error(e.message || "Erreur lors de la commande");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold font-heading truncate">
            {providerInfo?.header_title || "Nouvelle commande"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {providerInfo?.header_text || "Services en temps réel — propulsés par notre fournisseur partenaire."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate("/dashboard/order")}
          className="shrink-0 px-5 py-2 rounded-full bg-green-600 text-white text-xs font-semibold shadow-sm hover:bg-green-700 active:bg-green-800 transition-colors"
        >
          Changer de fournisseur
        </button>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Solde disponible</span>
          <span className="font-bold text-primary text-lg">{balance.toLocaleString()} FCFA</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-bold italic text-primary">1. Choisissez une plateforme</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingServices ? (
            <div className="flex justify-center py-6">
              <div className="animate-spin h-6 w-6 border-4 border-primary border-t-transparent rounded-full" />
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {platformsWithCounts.map((p) => (
                <button
                  key={p.key}
                  onClick={() => {
                    setActivePlatform(p.key);
                    setActiveCategory(null);
                    setCategorySearch("");
                    setSelectedService(null);
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                    activePlatform === p.key
                      ? "border-primary bg-primary/10 text-foreground font-semibold"
                      : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  <span
                    className="w-6 h-6 rounded-md flex items-center justify-center text-white"
                    style={{ background: p.color }}
                  >
                    {p.icon}
                  </span>
                  <span>{p.label}</span>
                  <span className="text-[10px] text-muted-foreground">({p.count})</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {showCategoryCard && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-bold italic text-primary">{stepCategoryNum}. Choisissez une catégorie</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Bouton menu déroulant */}
            <button
              type="button"
              onClick={() => setCategoriesOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-background hover:border-primary/50 transition-colors"
            >
              <div className="flex-1 min-w-0 text-left flex items-center gap-2">
                <Folder size={16} className="text-muted-foreground shrink-0" />
                {activeCategory ? (
                  <span className="font-medium text-sm truncate">{activeCategory}</span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Choisir une catégorie ({categoriesWithCounts.length} disponibles)
                  </span>
                )}
              </div>
              <ChevronDown
                size={18}
                className={`text-muted-foreground shrink-0 transition-transform ${categoriesOpen ? "rotate-180" : ""}`}
              />
            </button>

            {/* Contenu déroulant */}
            {categoriesOpen && (
              <div className="space-y-3 border border-border rounded-lg p-3 bg-muted/20">
                {categoriesWithCounts.length > 8 && (
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
                    <Input
                      value={categorySearch}
                      onChange={(e) => setCategorySearch(e.target.value)}
                      placeholder="Rechercher une catégorie…"
                      className="pl-9 bg-background"
                    />
                  </div>
                )}
                <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1">
                  {visibleCategories.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">Aucune catégorie trouvée.</p>
                  ) : (
                    visibleCategories.map((c) => {
                      const isActive = activeCategory === c.category;
                      return (
                        <button
                          key={c.category}
                          onClick={() => {
                            setActiveCategory(c.category);
                            setSelectedService(null);
                            setSearch("");
                            setCategoriesOpen(false);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border bg-background text-sm text-left transition-colors ${
                            isActive
                              ? "border-primary bg-primary/10 text-foreground font-semibold"
                              : "border-border hover:border-primary/50 hover:bg-muted/50"
                          }`}
                        >
                          <Folder size={14} className="text-muted-foreground shrink-0" />
                          <span className="truncate flex-1">{c.category}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">({c.count})</span>
                          {isActive && <Check size={14} className="text-primary shrink-0" />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!loadingServices && (activeCategory || !showCategoryCard) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-bold italic text-primary">{stepServiceNum}. Sélectionnez un service</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Bouton menu déroulant */}
            <button
              type="button"
              onClick={() => setServicesOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-background hover:border-primary/50 transition-colors"
            >
              <div className="flex-1 min-w-0 text-left">
                {selectedService ? (
                  <>
                    <div className="font-medium text-sm">
                      {selectedService.name}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {selectedService.category} · {getLocalPricePerK(selectedService, currencyInfo.currency, currencyInfo.fcfaPerUnit).toLocaleString()} {currencyInfo.symbol} / 1000
                    </p>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Choisir un service ({visibleServices.length} disponibles)
                  </span>
                )}
              </div>
              <ChevronDown
                size={18}
                className={`text-muted-foreground shrink-0 transition-transform ${servicesOpen ? "rotate-180" : ""}`}
              />
            </button>

            {/* Contenu déroulant */}
            {servicesOpen && (
              <div className="space-y-3 border border-border rounded-lg p-3 bg-muted/20">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Rechercher un service…"
                    className="pl-9 bg-background"
                  />
                </div>
                <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                  {visibleServices.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">Aucun service trouvé.</p>
                  ) : (
                    visibleServices.map((s) => {
                      const isSelected = selectedService?.service === s.service;
                      return (
                        <button
                          key={s.service}
                          onClick={() => {
                            setSelectedService(s);
                            setQuantity(String(s.min));
                            setServicesOpen(false);
                          }}
                          className={`w-full text-left p-3 rounded-lg border bg-background text-sm transition-colors ${
                            isSelected
                              ? "border-primary bg-primary/10"
                              : "border-border hover:border-primary/50 hover:bg-muted/50"
                          }`}
                        >
                          <div className="flex justify-between items-start gap-3 mb-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start gap-1.5 flex-wrap">
                                {s.featured && (
                                  <span className="inline-flex items-center gap-0.5 shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-300">
                                    ⚡ Rapide
                                  </span>
                                )}
                                <span className="font-semibold text-sm break-words">{s.name}</span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1 break-words">
                                {s.category}
                              </p>
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              <span className="text-sm font-bold text-primary whitespace-nowrap">
                                {getLocalPricePerK(s, currencyInfo.currency, currencyInfo.fcfaPerUnit).toLocaleString()} {currencyInfo.symbol} / 1k
                              </span>
                              {isSelected && (
                                <span className="inline-flex items-center gap-1 text-[10px] text-primary font-semibold">
                                  <Check size={12} /> Sélectionné
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-[11px]">
                            <div className="bg-muted/50 rounded p-1.5">
                              <div className="text-muted-foreground">ID</div>
                              <div className="font-medium">#{s.service}</div>
                            </div>
                            <div className="bg-muted/50 rounded p-1.5">
                              <div className="text-muted-foreground">Min</div>
                              <div className="font-medium">{Number(s.min).toLocaleString()}</div>
                            </div>
                            <div className="bg-muted/50 rounded p-1.5">
                              <div className="text-muted-foreground">Max</div>
                              <div className="font-medium">{Number(s.max).toLocaleString()}</div>
                            </div>
                          </div>
                          {(s as any).type && (
                            <div className="mt-2 text-[11px]">
                              <span className="text-muted-foreground">Type : </span>
                              <span className="font-medium">{(s as any).type}</span>
                            </div>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {selectedService && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{stepDetailsNum}. Détails de la commande</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="link">{linkHint.label}</Label>
              <Input
                id="link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder={linkHint.placeholder}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="qty">
                Quantité (min {minQ.toLocaleString()} — max {maxQ.toLocaleString()})
              </Label>
              <Input
                id="qty"
                type="number"
                min={minQ}
                max={maxQ}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="mt-1"
              />
            </div>

            <div className="bg-muted/50 rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Service</span>
                <span className="font-medium text-right truncate max-w-[60%]">
                  {shortLabel(selectedService.name, platformLabel)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Quantité</span>
                <span className="font-medium">{qty.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Prix unitaire</span>
                <span className="font-medium">{pricePerK.toLocaleString()} {currencyInfo.symbol} / 1000</span>
              </div>
              <div className="flex justify-between border-t pt-2 mt-2">
                <span className="text-muted-foreground font-medium">Total à payer</span>
                <span className="font-bold text-primary text-base">{localTotal.toLocaleString()} {currencyInfo.symbol}</span>
              </div>
              {price > balance && (
                <p className="text-xs text-destructive">
                  Solde insuffisant (solde actuel : {Math.round(balance / currencyInfo.fcfaPerUnit).toLocaleString()} {currencyInfo.symbol})
                </p>
              )}
            </div>

            <Button
              className="w-full h-11"
              onClick={handleOrder}
              disabled={loading || !link || qty < minQ || qty > maxQ || price > balance}
            >
              <ShoppingCart size={16} className="mr-2" />
              {loading ? "Traitement…" : `Commander — ${localTotal.toLocaleString()} ${currencyInfo.symbol}`}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
