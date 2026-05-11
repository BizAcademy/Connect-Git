import { motion } from "framer-motion";
import { Shield, Zap, Clock, Headphones, CreditCard, RefreshCw } from "lucide-react";

const features = [
  {
    icon: Zap,
    title: "Livraison rapide",
    description: "Vos commandes sont traitées et livrées en quelques minutes.",
    color: "#FFD600",
    bg: "#FFFDE7",
  },
  {
    icon: Shield,
    title: "100% sécurisé",
    description: "Vos données sont protégées avec un chiffrement de pointe.",
    color: "hsl(25, 95%, 53%)",
    bg: "hsl(25, 100%, 95%)",
  },
  {
    icon: Clock,
    title: "Disponible 24/7",
    description: "Notre plateforme fonctionne en continu, jour et nuit.",
    color: "#2196F3",
    bg: "#E3F2FD",
  },
  {
    icon: CreditCard,
    title: "Paiement facile",
    description: "Mobile Money et autres méthodes acceptées facilement.",
    color: "#4CAF50",
    bg: "#E8F5E9",
  },
  {
    icon: RefreshCw,
    title: "Garantie recharge",
    description: "Système de recharge garantie si les chiffres baissent.",
    color: "#FF5722",
    bg: "#FBE9E7",
  },
  {
    icon: Headphones,
    title: "Support réactif",
    description: "Notre équipe vous accompagne via WhatsApp et email.",
    color: "#9C27B0",
    bg: "#F3E5F5",
  },
];

const FeaturesSection = () => {
  return (
    <section id="features" className="py-10 md:py-24 bg-white">
      <div className="container px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-6 md:mb-16"
        >
          <h2 className="font-heading font-black text-lg md:text-4xl mb-2 md:mb-4 text-foreground">
            Pourquoi choisir{" "}
            <span style={{ color: "hsl(25, 95%, 53%)" }}>BUZZ BOOSTER</span> ?
          </h2>
          <p className="text-muted-foreground text-xs md:text-lg max-w-2xl mx-auto">
            Une plateforme conçue pour vous offrir les meilleurs résultats.
          </p>
        </motion.div>

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 md:gap-6">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="flex flex-col md:flex-row md:items-start gap-2 md:gap-4 p-3 md:p-6 rounded-xl md:rounded-2xl border border-border/40 hover:border-primary/30 hover:shadow-md transition-all bg-white group"
            >
              <div
                className="shrink-0 w-8 h-8 md:w-12 md:h-12 rounded-xl md:rounded-2xl flex items-center justify-center transition-transform group-hover:scale-110"
                style={{ background: feature.bg }}
              >
                <feature.icon size={14} className="md:!w-[22px] md:!h-[22px]" style={{ color: feature.color }} />
              </div>
              <div className="min-w-0">
                <h3 className="font-heading font-black text-xs md:text-lg mb-0.5 md:mb-1 text-foreground leading-tight">
                  {feature.title}
                </h3>
                <p className="text-muted-foreground text-[10px] md:text-sm leading-tight md:leading-relaxed">
                  {feature.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;
