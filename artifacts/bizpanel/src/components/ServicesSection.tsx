import { motion } from "framer-motion";
import { Instagram, Youtube, Facebook } from "lucide-react";
import { useSiteContent } from "@/hooks/useSiteContent";

const TikTokIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
    <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.75a8.18 8.18 0 004.76 1.52V6.84a4.84 4.84 0 01-1-.15z" />
  </svg>
);

const platforms = [
  {
    name: "Instagram",
    icon: Instagram,
    iconKey: "services_icon_instagram",
    gradient: "linear-gradient(135deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)",
    services: ["Abonnés", "Likes", "Commentaires", "Vues Reels"],
    description: "Augmentez votre visibilité sur Instagram avec nos services premium.",
  },
  {
    name: "TikTok",
    icon: TikTokIcon,
    iconKey: "services_icon_tiktok",
    gradient: "linear-gradient(135deg, #000000 0%, #2d2d2d 100%)",
    services: ["Abonnés", "Likes", "Vues", "Partages"],
    description: "Devenez viral sur TikTok grâce à notre boost de croissance.",
  },
  {
    name: "Facebook",
    icon: Facebook,
    iconKey: "services_icon_facebook",
    gradient: "linear-gradient(135deg, #1877F2 0%, #0d5fd4 100%)",
    services: ["J'aime Page", "Likes Posts", "Commentaires", "Partages"],
    description: "Développez votre communauté Facebook rapidement.",
  },
  {
    name: "YouTube",
    icon: Youtube,
    iconKey: "services_icon_youtube",
    gradient: "linear-gradient(135deg, #FF0000 0%, #cc0000 100%)",
    services: ["Abonnés", "Vues", "Likes", "Commentaires"],
    description: "Boostez votre chaîne YouTube avec des résultats réels.",
  },
];

const ServicesSection = () => {
  const { get } = useSiteContent();
  const sectionTitle = get("services_title", "Nos services par plateforme");

  return (
    <section id="services" className="py-10 md:py-24" style={{ background: "hsl(220, 20%, 97%)" }}>
      <div className="container px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-6 md:mb-16"
        >
          <h2 className="font-heading font-black text-lg md:text-4xl mb-2 md:mb-4 text-foreground">
            {sectionTitle}
          </h2>
          <p className="text-muted-foreground text-xs md:text-lg max-w-2xl mx-auto">
            Des solutions de croissance pour toutes les grandes plateformes sociales.
          </p>
        </motion.div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-6">
          {platforms.map((platform, i) => {
            const customIcon = get(platform.iconKey);
            return (
              <motion.div
                key={platform.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="bg-white rounded-xl md:rounded-2xl p-3 md:p-6 shadow-sm hover:shadow-md transition-all hover:-translate-y-1 group"
              >
                <div
                  className="w-10 h-10 md:w-16 md:h-16 rounded-xl md:rounded-2xl flex items-center justify-center mx-auto mb-2 md:mb-4 text-white transition-transform group-hover:scale-110 overflow-hidden [&_svg]:w-5 [&_svg]:h-5 md:[&_svg]:w-8 md:[&_svg]:h-8"
                  style={{ background: platform.gradient }}
                >
                  {customIcon ? (
                    <img src={customIcon} alt={platform.name} className="w-full h-full object-cover" />
                  ) : (
                    <platform.icon />
                  )}
                </div>
                <h3 className="font-heading font-black text-sm md:text-xl text-center text-foreground mb-1 md:mb-2">
                  {platform.name}
                </h3>
                <p className="text-muted-foreground text-[10px] md:text-sm text-center mb-2 md:mb-4 leading-tight">{platform.description}</p>
                <div className="flex flex-wrap gap-1 md:gap-1.5 justify-center">
                  {platform.services.map((service) => (
                    <span
                      key={service}
                      className="px-1.5 md:px-2.5 py-0.5 md:py-1 rounded-full text-[9px] md:text-xs font-semibold"
                      style={{ background: "hsl(220, 15%, 92%)", color: "hsl(25, 95%, 45%)" }}
                    >
                      {service}
                    </span>
                  ))}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default ServicesSection;
