import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { fetchSmmServices, type SmmService } from "@/lib/smm";
import { Menu, X, ChevronDown, Instagram, Youtube, Facebook, MessageCircle, Music2, Send, Globe } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import logoImg from "@/assets/logo-buzzbooster.png";

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
  for (const p of PLATFORMS) {
    if (p.key !== "other" && p.match.test(text)) return p.key;
  }
  return "other";
}

// Pretty short label from messy SMM names: "Instagram Followers - [...]" → "Followers"
function shortLabel(name: string, platformLabel: string): string {
  let s = name.split(/[-\[(]/)[0].trim();
  s = s.replace(new RegExp(platformLabel, "i"), "").trim();
  return s || name.slice(0, 40);
}

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [services, setServices] = useState<SmmService[]>([]);
  const [loadingServices, setLoadingServices] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    setLoadingServices(true);
    fetchSmmServices()
      .then((data) => setServices(data))
      .catch((err) => console.error("SMM services error:", err))
      .finally(() => setLoadingServices(false));
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setServicesOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Group services by platform, keep first 6 per platform
  const servicesByPlatform = PLATFORMS.map((p) => ({
    ...p,
    items: services.filter((s) => detectPlatform(s.category, s.name) === p.key).slice(0, 6),
  })).filter((p) => p.items.length > 0);

  const handleServiceClick = (service: SmmService) => {
    setServicesOpen(false);
    setIsOpen(false);
    if (user) {
      navigate(`/dashboard/order?service=${service.service}`);
    } else {
      navigate("/auth");
    }
  };

  const navLinks = [
    { label: "Fonctionnalités", href: "#features" },
    { label: "Tarifs", href: "#pricing" },
    { label: "Contact", href: "#contact" },
  ];

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-md border-b border-border/30">
      <div className="container mx-auto flex items-center justify-between h-16 px-4 sm:px-6">
        <a href="#hero" aria-label="BUZZ BOOSTER" className="flex items-center select-none">
          <img src={logoImg} alt="BUZZ BOOSTER" className="h-10 sm:h-11 w-auto rounded-md" />
        </a>

        <div className="hidden md:flex items-center gap-8">
          {/* Services dropdown */}
          <div ref={dropdownRef} className="relative">
            <button
              onClick={() => setServicesOpen(!servicesOpen)}
              className="flex items-center gap-1 text-sm font-semibold text-foreground/70 hover:text-primary transition-colors"
            >
              Services <ChevronDown size={14} className={`transition-transform ${servicesOpen ? "rotate-180" : ""}`} />
            </button>

            <AnimatePresence>
              {servicesOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-full left-1/2 -translate-x-1/2 mt-3 bg-white rounded-2xl shadow-2xl border border-border/30 overflow-hidden"
                  style={{ width: "min(880px, 92vw)" }}
                >
                  {loadingServices ? (
                    <div className="p-8 text-center text-sm text-muted-foreground">
                      Chargement des services…
                    </div>
                  ) : servicesByPlatform.length === 0 ? (
                    <div className="p-8 text-center text-sm text-muted-foreground">
                      Aucun service disponible.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-border/20 max-h-[60vh] overflow-y-auto">
                      {servicesByPlatform.map((p) => (
                        <div key={p.key} className="p-4">
                          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/20">
                            <div
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-white shrink-0"
                              style={{ background: p.color }}
                            >
                              {p.icon}
                            </div>
                            <span className="font-heading font-bold text-sm text-foreground">{p.label}</span>
                          </div>
                          <ul className="space-y-1">
                            {p.items.map((s) => (
                              <li key={s.service}>
                                <button
                                  onClick={() => handleServiceClick(s)}
                                  className="w-full text-left px-2 py-1.5 rounded-md text-xs text-foreground/80 hover:bg-muted hover:text-primary transition-colors group"
                                >
                                  <div className="font-medium truncate">{shortLabel(s.name, p.label)}</div>
                                  <div className="text-[10px] text-muted-foreground group-hover:text-primary/70">
                                    {s.price_fcfa.toLocaleString()} FCFA / 1k
                                  </div>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="bg-muted/40 px-4 py-2.5 border-t border-border/20 text-center">
                    <button
                      onClick={() => { setServicesOpen(false); navigate(user ? "/dashboard/order" : "/auth"); }}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Voir tous les services →
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm font-semibold text-foreground/70 hover:text-primary transition-colors"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-3">
          {user ? (
            <button
              onClick={() => navigate("/dashboard")}
              className="px-6 py-2 rounded-full text-sm font-bold text-white transition-opacity hover:opacity-90"
              style={{ background: "hsl(25, 95%, 53%)" }}
            >
              Mon espace
            </button>
          ) : (
            <>
              <button
                onClick={() => navigate("/auth")}
                className="px-6 py-2 rounded-full text-sm font-bold border-2 transition-colors hover:bg-primary/5"
                style={{ borderColor: "hsl(25, 95%, 53%)", color: "hsl(25, 95%, 53%)" }}
              >
                Connexion
              </button>
              <button
                onClick={() => navigate("/auth?tab=signup")}
                className="px-6 py-2 rounded-full text-sm font-bold text-white transition-opacity hover:opacity-90"
                style={{ background: "hsl(25, 95%, 53%)" }}
              >
                Inscription
              </button>
            </>
          )}
        </div>

        <button className="md:hidden text-foreground" onClick={() => setIsOpen(!isOpen)}>
          {isOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden bg-background border-b border-border/40 overflow-hidden max-h-[80vh] overflow-y-auto"
          >
            <div className="flex flex-col gap-1 p-4">
              {/* Mobile Services accordion */}
              <button
                onClick={() => setServicesOpen(!servicesOpen)}
                className="flex items-center justify-between text-sm font-semibold text-foreground/70 py-2.5 border-b border-border/20"
              >
                Services
                <ChevronDown size={16} className={`transition-transform ${servicesOpen ? "rotate-180" : ""}`} />
              </button>
              <AnimatePresence>
                {servicesOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="pl-3 py-2 space-y-3 max-h-[50vh] overflow-y-auto">
                      {loadingServices ? (
                        <div className="text-xs text-muted-foreground py-2">Chargement…</div>
                      ) : (
                        servicesByPlatform.map((p) => (
                          <div key={p.key}>
                            <div className="flex items-center gap-2 mb-1.5">
                              <div
                                className="w-6 h-6 rounded-md flex items-center justify-center text-white"
                                style={{ background: p.color }}
                              >
                                {p.icon}
                              </div>
                              <span className="font-heading font-bold text-xs">{p.label}</span>
                            </div>
                            <ul className="space-y-0.5 pl-8">
                              {p.items.map((s) => (
                                <li key={s.service}>
                                  <button
                                    onClick={() => handleServiceClick(s)}
                                    className="w-full text-left text-xs py-1 text-foreground/70 hover:text-primary"
                                  >
                                    {shortLabel(s.name, p.label)} — <span className="text-muted-foreground">{s.price_fcfa.toLocaleString()} FCFA/1k</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-sm font-semibold text-foreground/70 hover:text-primary py-2.5 border-b border-border/20 last:border-0"
                  onClick={() => setIsOpen(false)}
                >
                  {link.label}
                </a>
              ))}
              <div className="flex gap-3 pt-3">
                {user ? (
                  <button
                    className="flex-1 py-2.5 rounded-full text-sm font-bold text-white"
                    style={{ background: "hsl(25, 95%, 53%)" }}
                    onClick={() => { navigate("/dashboard"); setIsOpen(false); }}
                  >
                    Mon espace
                  </button>
                ) : (
                  <>
                    <button
                      className="flex-1 py-2.5 rounded-full text-sm font-bold border-2"
                      style={{ borderColor: "hsl(25, 95%, 53%)", color: "hsl(25, 95%, 53%)" }}
                      onClick={() => { navigate("/auth"); setIsOpen(false); }}
                    >
                      Connexion
                    </button>
                    <button
                      className="flex-1 py-2.5 rounded-full text-sm font-bold text-white"
                      style={{ background: "hsl(25, 95%, 53%)" }}
                      onClick={() => { navigate("/auth?tab=signup"); setIsOpen(false); }}
                    >
                      Inscription
                    </button>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
};

export default Navbar;
