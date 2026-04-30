import { Instagram, Youtube, Facebook, MessageCircle } from "lucide-react";
import { useSiteContent } from "@/hooks/useSiteContent";

const FooterSection = () => {
  const { get } = useSiteContent();

  const whatsapp = get("footer_whatsapp", "+XXX XXX XXX");
  const email = get("footer_email", "support@buzzbooster.com");
  const tagline = get("footer_tagline", "La plateforme leader de croissance sur les réseaux sociaux en Afrique francophone.");
  const logoImage = get("footer_logo_image");
  const waLink = whatsapp.replace(/\s+/g, "").replace("+", "");

  return (
    <footer id="contact" style={{ background: "hsl(270,25%,12%)" }} className="py-8 md:py-16 relative">
      <div className="container px-4 md:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5 md:gap-10">
          <div className="col-span-2 md:col-span-2">
            <div className="mb-2 md:mb-4">
              {logoImage ? (
                <img src={logoImage} alt="BUZZ BOOSTER" className="h-7 md:h-10 object-contain" />
              ) : (
                <div className="flex flex-col leading-none">
                  <span className="font-heading text-base md:text-2xl font-black tracking-widest uppercase" style={{ color: "hsl(25, 95%, 53%)" }}>
                    ≡BUZZ
                  </span>
                  <span className="font-heading text-base md:text-2xl font-black tracking-widest uppercase" style={{ color: "hsl(215, 85%, 55%)" }}>
                    BOOST
                  </span>
                </div>
              )}
            </div>
            <p className="text-[11px] md:text-sm leading-relaxed mb-3 md:mb-5" style={{ color: "hsl(300,15%,65%)" }}>
              {tagline}
            </p>
            <div className="flex gap-2 md:gap-3">
              {[Instagram, Facebook, Youtube].map((Icon, i) => (
                <a
                  key={i}
                  href="#"
                  className="w-7 h-7 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center transition-colors hover:opacity-80"
                  style={{ background: "hsl(270,20%,20%)", color: "hsl(300,15%,65%)" }}
                >
                  <Icon size={14} className="md:!w-[18px] md:!h-[18px]" />
                </a>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-heading font-black mb-2 md:mb-5 text-white text-[11px] md:text-sm uppercase tracking-wider">
              Liens rapides
            </h4>
            <ul className="space-y-1.5 md:space-y-2.5 text-[11px] md:text-sm" style={{ color: "hsl(300,15%,60%)" }}>
              {[
                { label: "Accueil", href: "#hero" },
                { label: "Services", href: "#services" },
                { label: "Tarifs", href: "#pricing" },
                { label: "Fonctionnalités", href: "#features" },
                { label: "Contact", href: "#contact" },
              ].map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="hover:text-primary transition-colors">{link.label}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-heading font-black mb-2 md:mb-5 text-white text-[11px] md:text-sm uppercase tracking-wider">
              Support
            </h4>
            <ul className="space-y-1.5 md:space-y-3 text-[11px] md:text-sm" style={{ color: "hsl(300,15%,60%)" }}>
              <li className="flex items-start gap-1.5 md:gap-2">
                <MessageCircle size={12} className="shrink-0 mt-0.5 md:!w-[16px] md:!h-[16px]" style={{ color: "hsl(152, 60%, 55%)" }} />
                <span className="break-all">WhatsApp : {whatsapp}</span>
              </li>
              <li className="flex items-start gap-1.5 md:gap-2">
                <span className="shrink-0 text-xs md:text-base">✉️</span>
                <span className="break-all">{email}</span>
              </li>
            </ul>
          </div>
        </div>

        <div
          className="mt-6 md:mt-14 pt-4 md:pt-8 text-center text-[11px] md:text-sm"
          style={{ borderTop: "1px solid hsl(270,20%,20%)", color: "hsl(300,15%,45%)" }}
        >
          © {new Date().getFullYear()} BUZZ BOOSTER. Tous droits réservés.
        </div>
      </div>

    </footer>
  );
};

export default FooterSection;
