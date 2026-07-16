import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSiteContent } from "@/hooks/useSiteContent";
import defaultCommunityImg from "@assets/6044021293859933661_1778088768929.jpg";

// Liste fixe des marques affichées dans le slider de la landing.
// Les codes correspondent à ceux gérés dans le panneau admin (onglet "Logos accueil").
const LANDING_BRANDS: { code: string; label: string; bg: string; text: string }[] = [
  { code: "brand_orange", label: "Orange", bg: "#FF6600", text: "#fff" },
  { code: "brand_mtn",    label: "MTN",    bg: "#FFCB00", text: "#000" },
  { code: "brand_wave",   label: "Wave",   bg: "#1DC8D0", text: "#fff" },
  { code: "brand_moov",   label: "Moov",   bg: "#0066CC", text: "#fff" },
  { code: "brand_airtel", label: "Airtel", bg: "#E4002B", text: "#fff" },
  { code: "brand_mpesa",  label: "M-Pesa", bg: "#E60000", text: "#fff" },
];

const HeroSection = () => {
  const navigate = useNavigate();
  const { get } = useSiteContent();
  const communityImg = get("hero_community_image") || defaultCommunityImg;

  // Charge les logos opérateurs (admin-uploadable) pour le slider.
  // 1) Hydratation INSTANTANÉE depuis localStorage (cache navigateur persistant entre visites).
  // 2) Refresh asynchrone en arrière-plan pour récupérer les éventuels nouveaux logos admin.
  const LOGOS_CACHE_KEY = "buzzbooster:operator-logos:v1";
  const [logos, setLogos] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const cached = window.localStorage.getItem(LOGOS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
      }
    } catch {/* localStorage indisponible — pastilles couleur en fallback */}
    return {};
  });

  useEffect(() => {
    // Pas de cache: "no-store" — on profite du Cache-Control serveur (public, max-age=300)
    fetch("/api/payments/operator-logos")
      .then((r) => (r.ok ? r.json() : { logos: {} }))
      .then((d) => {
        const next = (d && d.logos) || {};
        setLogos(next);
        try { window.localStorage.setItem(LOGOS_CACHE_KEY, JSON.stringify(next)); } catch {/* quota plein, on ignore */}
      })
      .catch(() => {/* fallback silencieux : pastilles couleur */});
  }, []);

  // Duplication × 2 pour une boucle marquee fluide (translateX(-50%) = item de départ).
  const brandStrip = [...LANDING_BRANDS, ...LANDING_BRANDS];

  return (
    <section
      id="hero"
      className="relative md:min-h-screen flex items-center overflow-hidden pt-16"
      style={{ background: "hsl(315, 60%, 96%)" }}
    >
      <div className="container px-4 md:px-6 py-6 md:py-20">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-12 items-center">

          {/* Image gauche — centrage robuste mobile : margin auto + largeur explicite */}
          <div className="order-2 lg:order-1 w-full pt-4 pb-8 md:p-0">
            <div
              className="relative sm:max-w-sm md:max-w-md lg:max-w-lg"
              style={{
                display: "block",
                width: "280px",
                maxWidth: "92%",
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              <div className="relative rounded-2xl md:rounded-3xl overflow-hidden shadow-lg bg-white">
                <img
                  src={communityImg}
                  alt="BUZZ BOOSTER — Croissance réseaux sociaux en Afrique"
                  className="w-full h-auto block"
                  loading="eager"
                  decoding="async"
                />
              </div>

              {/* Mini carte stats flottante (coin haut-droit) — visible sur mobile aussi mais réduite */}
              <div className="absolute -top-2 -right-2 md:-top-4 md:-right-4 bg-white rounded-lg md:rounded-2xl shadow-xl px-2 md:px-3.5 py-1 md:py-2.5">
                <p className="text-[7px] md:text-[10px] font-bold text-gray-400 uppercase tracking-wide leading-tight">Croissance</p>
                <p className="text-xs md:text-lg font-black leading-tight" style={{ color: "hsl(25, 95%, 53%)" }}>+128.3k</p>
                <p className="text-[7px] md:text-[10px] font-semibold text-green-500 leading-tight">Abonnés ce mois</p>
              </div>

              {/* Stats mini sous l'illustration — compactée pour rester DANS la largeur de l'image sur mobile */}
              <div className="absolute -bottom-2 md:-bottom-4 left-1/2 -translate-x-1/2 bg-white rounded-lg md:rounded-2xl shadow-xl px-2 md:px-5 py-1 md:py-3 flex gap-2 md:gap-6 whitespace-nowrap">
                <div className="text-center">
                  <p className="text-[8px] md:text-xs text-gray-400 font-medium leading-tight">Suivis</p>
                  <p className="font-black text-[11px] md:text-base text-gray-800 leading-tight">263</p>
                </div>
                <div className="text-center border-l border-gray-100 pl-2 md:pl-6">
                  <p className="text-[8px] md:text-xs text-gray-400 font-medium leading-tight">Abonnés</p>
                  <p className="font-black text-[11px] md:text-base text-gray-800 leading-tight">256k</p>
                </div>
                <div className="text-center border-l border-gray-100 pl-2 md:pl-6">
                  <p className="text-[8px] md:text-xs text-gray-400 font-medium leading-tight">Likes</p>
                  <p className="font-black text-[11px] md:text-base text-gray-800 leading-tight">7.8M</p>
                </div>
              </div>
            </div>
          </div>

          {/* Texte droite */}
          <div className="order-1 lg:order-2">
            <h1 className="font-heading font-black leading-tight mb-2 md:mb-4" style={{ fontSize: "clamp(1.4rem, 5vw, 3.8rem)" }}>
              <span style={{ color: "hsl(25, 95%, 53%)" }}>Abonnés, likes et vues</span>
              <br />
              <span style={{ color: "hsl(220, 25%, 10%)" }}>pour vos réseaux sociaux</span>
              <br />
              <span className="text-foreground/60 font-extrabold" style={{ fontSize: "clamp(0.85rem, 3vw, 2rem)" }}>
                Livraison rapide · Paiement Mobile Money
              </span>
            </h1>

            <p className="text-muted-foreground text-xs md:text-lg mb-3 md:mb-6 leading-relaxed max-w-lg">
              Instagram, TikTok, Facebook, YouTube — commandez directement depuis votre téléphone, payez en Mobile Money, recevez vos résultats en quelques minutes.
            </p>

            <ul className="grid grid-cols-2 gap-x-2 gap-y-1.5 md:flex md:flex-col md:space-y-3 mb-3 md:mb-5">
              {[
                { emoji: "⚡", text: "Traitement en quelques minutes" },
                { emoji: "👍", text: "En ligne depuis 2023" },
                { emoji: "🔒", text: "Paiement 100 % sécurisé" },
              ].map((item, i) => (
                <li
                  key={i}
                  className="flex items-start gap-1.5 md:gap-3 text-[10px] md:text-sm font-medium text-foreground/80"
                >
                  <span className="text-xs md:text-lg shrink-0 leading-none mt-0.5">{item.emoji}</span>
                  <span className="leading-tight">{item.text}</span>
                </li>
              ))}
            </ul>

            {/* Slider logos opérateurs Mobile Money — défile gauche→droite en boucle */}
            <div className="mb-4 md:mb-8">
              <p className="text-[9px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 md:mb-2">
                Moyens de paiement acceptés
              </p>
              <div className="relative overflow-hidden">
                {/* Fondu sur les bords pour un effet "défilement infini" propre */}
                <div className="pointer-events-none absolute inset-y-0 left-0 w-6 md:w-10 z-10"
                  style={{ background: "linear-gradient(to right, hsl(315, 60%, 96%), transparent)" }} />
                <div className="pointer-events-none absolute inset-y-0 right-0 w-6 md:w-10 z-10"
                  style={{ background: "linear-gradient(to left, hsl(315, 60%, 96%), transparent)" }} />
                <div className="marquee-track flex gap-3 md:gap-5 w-max">
                  {brandStrip.map((b, i) => {
                    const customUrl = logos[b.code];
                    // 1ère occurrence = above-the-fold → chargement EAGER + priorité haute pour
                    // un affichage quasi-instantané. Les duplicates (i >= LANDING_BRANDS.length)
                    // gardent loading="lazy" puisqu'ils ne servent que la boucle marquee.
                    const isFirstOccurrence = i < LANDING_BRANDS.length;
                    return (
                      <div
                        key={`${b.code}-${i}`}
                        className="shrink-0 flex items-center justify-center bg-white rounded-xl md:rounded-2xl shadow-sm border border-border/40 overflow-hidden p-2"
                        style={{ width: 56, height: 56 }}
                        title={b.label}
                      >
                        {customUrl ? (
                          <img
                            src={customUrl}
                            alt={b.label}
                            style={{ width: "100%", height: "100%", objectFit: "contain" }}
                            loading={isFirstOccurrence ? "eager" : "lazy"}
                            decoding="async"
                            {...(isFirstOccurrence ? { fetchpriority: "high" as const } : {})}
                          />
                        ) : (
                          <span
                            className="w-full h-full flex items-center justify-center font-extrabold text-[10px] md:text-[11px] rounded-lg text-center leading-tight px-1"
                            style={{ background: b.bg, color: b.text }}
                          >
                            {b.label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-1 gap-2 md:gap-3 max-w-md md:max-w-xs">
              <button
                onClick={() => navigate("/auth?tab=signup")}
                className="w-full py-2.5 md:py-4 rounded-full text-white font-bold text-[10px] md:text-sm uppercase tracking-wider transition-opacity hover:opacity-90 shadow-md"
                style={{ background: "hsl(25, 95%, 53%)" }}
              >
                Créer mon compte
              </button>

              <button
                onClick={() => navigate("/auth")}
                className="w-full py-2.5 md:py-4 rounded-full font-bold text-[10px] md:text-sm uppercase tracking-wider border-2 transition-colors hover:bg-primary/5"
                style={{ borderColor: "hsl(25, 95%, 53%)", color: "hsl(25, 95%, 53%)" }}
              >
                Se connecter
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
