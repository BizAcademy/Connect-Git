import { useId, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleDollarSign,
  Coins,
  Layers3,
  LockKeyhole,
  MousePointerClick,
  ShieldCheck,
  Smartphone,
  Wallet,
} from "lucide-react";
import buzzboosterLogo from "../assets/logo-buzzbooster.png";
import "../DepositMethodPicker.css";

type DepositMethod = "mobile" | "crypto";

type DepositMethodPickerProps = {
  onContinue: (method: DepositMethod) => void;
  onBack: () => void;
};

/** Choice-only step: payment details and transactions belong to the next screen. */
export default function DepositMethodPicker({
  onContinue,
  onBack,
}: DepositMethodPickerProps) {
  const [method, setMethod] = useState<DepositMethod>("mobile");
  const groupName = useId();

  return (
    <section className="bb-deposit" aria-labelledby="bb-deposit-title">
      <header className="bb-deposit__hero">
        <button
          type="button"
          className="bb-deposit__back"
          onClick={onBack}
          data-testid="button-back-deposit"
        >
          <ArrowLeft size={21} strokeWidth={2.3} aria-hidden="true" />
          Retour
        </button>
        <div className="bb-deposit__heading">
          <span className="bb-deposit__hero-icon" aria-hidden="true">
            <Wallet size={34} strokeWidth={1.9} />
          </span>
          <div>
            <h1 id="bb-deposit-title">Déposer des fonds</h1>
            <p className="bb-deposit__subtitle">Choisissez votre méthode de paiement</p>
          </div>
        </div>
        <div className="bb-deposit__hero-art" aria-hidden="true">
          <span className="bb-deposit__hero-coin bb-deposit__hero-coin--left">
            <CircleDollarSign size={20} strokeWidth={1.9} />
          </span>
          <span className="bb-deposit__hero-phone">
            <span className="bb-deposit__hero-phone-screen">
              <Wallet size={28} strokeWidth={1.8} />
            </span>
          </span>
          <span className="bb-deposit__hero-coin bb-deposit__hero-coin--right">
            <CircleDollarSign size={16} strokeWidth={1.9} />
          </span>
          <ArrowUpRight className="bb-deposit__hero-rise" size={37} strokeWidth={4} />
        </div>
      </header>

      <div className="bb-deposit__body">
        <div className="bb-deposit__intro">
          <span className="bb-deposit__intro-icon" aria-hidden="true">
            <Wallet size={25} strokeWidth={2} />
          </span>
          <span className="bb-deposit__intro-rule" aria-hidden="true" />
          <p>Pour effectuer votre dépôt, sélectionnez le moyen par lequel vous souhaitez déposer.</p>
          <span className="bb-deposit__click-art" aria-hidden="true">
            <MousePointerClick size={32} strokeWidth={2.1} />
          </span>
        </div>

        <h2 className="bb-deposit__section-title" id="bb-deposit-method-heading">
          <Layers3 size={22} strokeWidth={2.3} aria-hidden="true" />
          Méthode de paiement
        </h2>

        <fieldset className="bb-deposit__options" aria-labelledby="bb-deposit-method-heading">
          <label className="bb-deposit__option" data-testid="option-deposit-mobile">
            <input
              className="bb-deposit__radio"
              type="radio"
              name={groupName}
              value="mobile"
              checked={method === "mobile"}
              onChange={() => setMethod("mobile")}
              data-testid="radio-deposit-mobile"
            />
            <div className="bb-deposit__card bb-deposit__card--mobile">
              <span className="bb-deposit__recommended">
                <Check size={12} strokeWidth={3} aria-hidden="true" />
                Recommandé
              </span>
              <span className="bb-deposit__check" aria-hidden="true">
                <Check size={17} strokeWidth={3} />
              </span>
              <div className="bb-deposit__card-content">
                <span className="bb-deposit__method-icon" aria-hidden="true">
                  <Smartphone size={32} strokeWidth={1.8} />
                </span>
                <div className="bb-deposit__method-copy">
                  <h3>Mobile Money</h3>
                  <p>MTN&nbsp; · &nbsp;Orange&nbsp; · &nbsp;Airtel</p>
                  <span className="bb-deposit__brands" aria-hidden="true">
                    <span className="bb-deposit__brand bb-deposit__brand--mtn">MTN</span>
                    <span className="bb-deposit__brand bb-deposit__brand--orange">orange</span>
                    <span className="bb-deposit__brand bb-deposit__brand--airtel">airtel</span>
                  </span>
                </div>
              </div>
            </div>
          </label>

          <label className="bb-deposit__option" data-testid="option-deposit-crypto">
            <input
              className="bb-deposit__radio"
              type="radio"
              name={groupName}
              value="crypto"
              checked={method === "crypto"}
              onChange={() => setMethod("crypto")}
              data-testid="radio-deposit-crypto"
            />
            <div className="bb-deposit__card bb-deposit__card--crypto">
              <span className="bb-deposit__check" aria-hidden="true">
                <Check size={17} strokeWidth={3} />
              </span>
              <div className="bb-deposit__card-content">
                <span className="bb-deposit__method-icon bb-deposit__method-icon--crypto" aria-hidden="true">
                  <Coins size={33} strokeWidth={1.8} />
                </span>
                <div className="bb-deposit__method-copy">
                  <h3>Cryptomonnaie</h3>
                  <p>USDC&nbsp; · &nbsp;USDT</p>
                </div>
              </div>
            </div>
          </label>
        </fieldset>

        <aside className="bb-deposit__security" aria-label="Information de sécurité">
          <span className="bb-deposit__security-icon" aria-hidden="true">
            <ShieldCheck size={26} strokeWidth={2} />
          </span>
          <div className="bb-deposit__security-copy">
            <strong>Paiement sécurisé par buzzbooster</strong>
            <p>Vos informations sont protégées à chaque étape.</p>
          </div>
          <img
            className="bb-deposit__brandmark"
            src={buzzboosterLogo}
            alt="BUZZ BOOSTER"
            width={102}
            height={47}
          />
        </aside>

        <button
          type="button"
          className="bb-deposit__continue"
          onClick={() => onContinue(method)}
          data-testid="button-continue-deposit"
        >
          CONTINUER
          <ArrowRight size={23} strokeWidth={2.2} aria-hidden="true" />
        </button>
        <p className="bb-deposit__fineprint">
          <LockKeyhole size={13} strokeWidth={2.3} aria-hidden="true" />
          Paiement sécurisé · Vos informations sont protégées
        </p>
      </div>
    </section>
  );
}