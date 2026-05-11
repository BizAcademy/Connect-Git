import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useSiteContent } from "@/hooks/useSiteContent";
import defaultCommunityImg from "@assets/6044021293859933661_1778088768929.jpg";

const HeroSection = () => {
  const navigate = useNavigate();
  const { get } = useSiteContent();
  const communityImg = get("hero_community_image") || defaultCommunityImg;

  return (
    <section
      id="hero"
      className="relative md:min-h-screen flex items-center overflow-hidden pt-16"
      style={{ background: "hsl(315, 60%, 96%)" }}
    >
      {/* Blob décorations */}
      <div
        className="absolute bottom-16 left-[-60px] w-48 h-48 rounded-full opacity-40"
        style={{ background: "hsl(215, 85%, 80%)" }}
      />
      <div
        className="absolute top-20 right-[-40px] w-36 h-36 rounded-full opacity-30"
        style={{ background: "hsl(25, 100%, 80%)" }}
      />
      <div
        className="absolute bottom-32 right-8 w-28 h-28 rounded-full opacity-25"
        style={{ background: "hsl(152, 60%, 75%)" }}
      />

      <div className="container px-4 md:px-6 py-6 md:py-20">
        <div className="grid lg:grid-cols-2 gap-6 md:gap-12 items-center">

          {/* Illustration gauche — image communauté */}
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7 }}
            className="relative flex justify-center order-2 lg:order-1"
          >
            <div className="relative w-full max-w-[280px] sm:max-w-sm md:max-w-md lg:max-w-lg">
              {/* Halo de fond derrière l'image */}
              <div
                className="absolute -inset-3 md:-inset-6 rounded-[2rem] blur-2xl opacity-60"
                style={{
                  background:
                    "radial-gradient(circle at 30% 30%, hsl(25, 100%, 60%) 0%, hsl(215, 85%, 55%) 70%, transparent 100%)",
                }}
              />
              {/* Image principale */}
              <div className="relative rounded-2xl md:rounded-3xl overflow-hidden shadow-2xl bg-white">
                <img
                  src={communityImg}
                  alt="Communauté BUZZ BOOSTER — Boostez votre présence sur les réseaux sociaux"
                  className="w-full h-auto block"
                  loading="eager"
                  decoding="async"
                />
              </div>

              {/* Mini carte stats flottante (coin haut-droit) */}
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6 }}
                className="hidden sm:block absolute -top-3 -right-3 md:-top-4 md:-right-4 bg-white rounded-xl md:rounded-2xl shadow-xl px-2.5 md:px-3.5 py-1.5 md:py-2.5"
              >
                <p className="text-[8px] md:text-[10px] font-bold text-gray-400 uppercase tracking-wide">Croissance</p>
                <p className="text-sm md:text-lg font-black" style={{ color: "hsl(25, 95%, 53%)" }}>+128.3k</p>
                <p className="text-[8px] md:text-[10px] font-semibold text-green-500">Abonnés ce mois</p>
              </motion.div>
            </div>

            {/* Stats mini sous l'illustration */}
            <div className="absolute -bottom-3 md:-bottom-4 left-1/2 -translate-x-1/2 bg-white rounded-xl md:rounded-2xl shadow-xl px-2.5 md:px-5 py-1.5 md:py-3 flex gap-3 md:gap-6 whitespace-nowrap">
              <div className="text-center">
                <p className="text-[9px] md:text-xs text-gray-400 font-medium">Suivis</p>
                <p className="font-black text-xs md:text-base text-gray-800">263</p>
              </div>
              <div className="text-center border-l border-gray-100 pl-3 md:pl-6">
                <p className="text-[9px] md:text-xs text-gray-400 font-medium">Abonnés</p>
                <p className="font-black text-xs md:text-base text-gray-800">256k</p>
              </div>
              <div className="text-center border-l border-gray-100 pl-3 md:pl-6">
                <p className="text-[9px] md:text-xs text-gray-400 font-medium">Likes</p>
                <p className="font-black text-xs md:text-base text-gray-800">7.8M</p>
              </div>
            </div>
          </motion.div>

          {/* Texte droite */}
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 0.1 }}
            className="order-1 lg:order-2"
          >
            <h1 className="font-heading font-black leading-tight mb-2 md:mb-4" style={{ fontSize: "clamp(1.4rem, 5vw, 3.8rem)" }}>
              <span style={{ color: "hsl(25, 95%, 53%)" }}>BOOSTEZ </span>
              <span style={{ color: "hsl(220, 25%, 10%)" }}>VOTRE</span>
              <br />
              <span style={{ color: "hsl(220, 25%, 10%)" }}>PRÉSENCE SOCIALE</span>
              <br />
              <span className="text-foreground/60 font-extrabold" style={{ fontSize: "clamp(0.85rem, 3vw, 2rem)" }}>
                Rapide, Sécurisé &amp; Fiable
              </span>
            </h1>

            <p className="text-muted-foreground text-xs md:text-lg mb-3 md:mb-6 leading-relaxed max-w-lg italic">
              Nous aidons les créateurs, entreprises et particuliers à booster leur engagement instantanément avec des outils conçus pour la croissance.
            </p>

            {/* Liste des avantages : 2 colonnes (2x2) sur mobile, vertical sur desktop */}
            <ul className="grid grid-cols-2 gap-x-2 gap-y-1.5 md:flex md:flex-col md:space-y-3 mb-4 md:mb-8">
              {[
                { emoji: "⚡", text: "Abonnés, Likes et plus — Instantanément" },
                { emoji: "🌍", text: "500 000+ Utilisateurs dans le monde" },
                { emoji: "👍", text: "Fiable depuis 2023" },
                { emoji: "🔒", text: "Paiement sécurisé Mobile Money" },
              ].map((item, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + i * 0.1 }}
                  className="flex items-start gap-1.5 md:gap-3 text-[10px] md:text-sm font-medium text-foreground/80"
                >
                  <span className="text-xs md:text-lg shrink-0 leading-none mt-0.5">{item.emoji}</span>
                  <span className="leading-tight">{item.text}</span>
                </motion.li>
              ))}
            </ul>

            <div className="grid grid-cols-2 md:grid-cols-1 gap-2 md:gap-3 max-w-md md:max-w-xs">
              <button
                onClick={() => navigate("/auth?tab=signup")}
                className="w-full py-2.5 md:py-4 rounded-full text-white font-bold text-[10px] md:text-sm uppercase tracking-wider transition-opacity hover:opacity-90 shadow-lg"
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
          </motion.div>
        </div>

        {/* Stats bar */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="mt-8 md:mt-24 flex justify-center"
        >
          <div className="bg-white rounded-2xl md:rounded-3xl shadow-xl flex divide-x divide-border/40 overflow-hidden">
            {[
              { value: "30 000 000+", label: "Commandes" },
              { value: "500 000+", label: "Utilisateurs" },
            ].map((stat, i) => (
              <div key={i} className="px-5 md:px-12 py-2.5 md:py-5 text-center">
                <p className="font-heading font-black text-base md:text-2xl text-foreground">{stat.value}</p>
                <p className="text-[10px] md:text-sm font-semibold text-muted-foreground mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default HeroSection;
