import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";

const plans = [
  {
    name: "Starter",
    price: "5 000",
    currency: "FCFA",
    description: "Idéal pour débuter",
    features: [
      "Accès à tous les services",
      "Support par email",
      "Tableau de bord basique",
      "Livraison standard",
    ],
    popular: false,
  },
  {
    name: "Pro",
    price: "20 000",
    currency: "FCFA",
    description: "Le plus populaire",
    features: [
      "Tout dans Starter",
      "Support prioritaire WhatsApp",
      "Livraison express",
      "Bonus de 10% sur recharges",
      "Programme d'affiliation",
    ],
    popular: true,
  },
  {
    name: "Business",
    price: "50 000",
    currency: "FCFA",
    description: "Pour les professionnels",
    features: [
      "Tout dans Pro",
      "Gestionnaire dédié",
      "API personnalisée",
      "Bonus de 20% sur recharges",
      "Tarifs grossiste",
    ],
    popular: false,
  },
];

const PricingSection = () => {
  const navigate = useNavigate();

  return (
    <section id="pricing" className="py-10 md:py-24" style={{ background: "hsl(220, 20%, 97%)" }}>
      <div className="container px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-6 md:mb-16"
        >
          <h2 className="font-heading font-black text-lg md:text-4xl mb-2 md:mb-4 text-foreground">
            Choisissez votre{" "}
            <span style={{ color: "hsl(25, 95%, 53%)" }}>formule</span>
          </h2>
          <p className="text-muted-foreground text-xs md:text-lg max-w-2xl mx-auto">
            Rechargez votre compte et commencez à booster vos réseaux sociaux dès aujourd'hui.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8 max-w-5xl mx-auto">
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className={`relative bg-white rounded-2xl md:rounded-3xl p-4 md:p-8 ${
                plan.popular
                  ? "shadow-2xl md:scale-105 ring-2"
                  : "shadow-sm border border-border/40"
              }`}
              style={plan.popular ? { ringColor: "hsl(25, 95%, 53%)" } : {}}
            >
              {plan.popular && (
                <div
                  className="absolute -top-3 md:-top-4 left-1/2 -translate-x-1/2 px-3 md:px-5 py-1 md:py-1.5 rounded-full text-[10px] md:text-xs font-black uppercase tracking-wide text-white shadow-md"
                  style={{ background: "hsl(25, 95%, 53%)" }}
                >
                  Populaire
                </div>
              )}

              <div className="mb-3 md:mb-6">
                <h3 className="font-heading font-black text-base md:text-xl text-foreground mb-0.5 md:mb-1">{plan.name}</h3>
                <p className="text-muted-foreground text-xs md:text-sm">{plan.description}</p>
                <div className="mt-2 md:mt-4">
                  <span className="font-heading font-black text-2xl md:text-4xl text-foreground">{plan.price}</span>
                  <span className="text-muted-foreground ml-1 text-xs md:text-base font-semibold">{plan.currency}</span>
                </div>
              </div>

              <ul className="space-y-1.5 md:space-y-3 mb-4 md:mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 md:gap-2.5 text-xs md:text-sm text-foreground/80">
                    <div
                      className="w-4 h-4 md:w-5 md:h-5 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: "hsl(220, 15%, 92%)" }}
                    >
                      <Check size={9} className="md:!w-[11px] md:!h-[11px]" style={{ color: "hsl(25, 95%, 53%)" }} strokeWidth={3} />
                    </div>
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => navigate("/auth")}
                className="w-full py-2.5 md:py-3.5 rounded-full font-bold text-xs md:text-sm uppercase tracking-wide transition-opacity hover:opacity-90"
                style={
                  plan.popular
                    ? { background: "hsl(25, 95%, 53%)", color: "white" }
                    : { background: "hsl(220, 15%, 92%)", color: "hsl(25, 95%, 45%)" }
                }
              >
                Commencer
              </button>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default PricingSection;
