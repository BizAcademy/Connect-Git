import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Eye, EyeOff, User, Lock, Mail, CheckCircle2, Zap, Shield, Clock } from "lucide-react";

const Auth = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [tab, setTab] = useState<"login" | "signup">("login");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [username, setUsername] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);

  const [forgotEmail, setForgotEmail] = useState("");
  const [showForgot, setShowForgot] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPassword });
    if (error) { setLoading(false); toast.error(error.message); return; }
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: data.user.id, _role: "admin" });
    setLoading(false);
    toast.success("Connexion réussie !");
    navigate(isAdmin ? "/admin" : "/dashboard");
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptPrivacy) { toast.error("Vous devez accepter la politique de confidentialité."); return; }
    if (signupPassword !== confirmPassword) { toast.error("Les mots de passe ne correspondent pas"); return; }
    if (signupPassword.length < 6) { toast.error("Le mot de passe doit contenir au moins 6 caractères"); return; }
    if (!username.trim()) { toast.error("Le nom d'utilisateur est requis"); return; }
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email: signupEmail,
      password: signupPassword,
      options: { emailRedirectTo: window.location.origin, data: { username } },
    });
    setLoading(false);
    if (error) { toast.error(error.message); }
    else { toast.success("Compte créé ! Bienvenue sur BUZZ BOOSTER 🎉"); navigate("/dashboard"); }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail, { redirectTo: `${window.location.origin}/reset-password` });
    setLoading(false);
    if (error) { toast.error(error.message); }
    else { toast.success("Email de récupération envoyé !"); setShowForgot(false); }
  };

  // ─── FORGOT PASSWORD ────────────────────────────────────────────────────────
  if (showForgot) {
    return (
      <div className="min-h-screen bg-[#f0f0f0] flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold">
              <span className="text-orange-500">BUZZ</span>{" "}
              <span className="text-blue-600">BOOSTER</span>
            </h1>
            <p className="text-gray-500 text-sm mt-1">Récupération du mot de passe</p>
          </div>
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input
                type="email"
                value={forgotEmail}
                onChange={e => setForgotEmail(e.target.value)}
                required
                placeholder="votre@email.com"
                className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-gray-900 text-white font-semibold text-sm hover:bg-gray-800 transition disabled:opacity-60"
            >
              {loading ? "Envoi en cours…" : "Envoyer le lien"}
            </button>
            <button
              type="button"
              onClick={() => setShowForgot(false)}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition"
            >
              ← Retour à la connexion
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ─── LOGIN (Peakerr-inspired) ────────────────────────────────────────────────
  if (tab === "login") {
    return (
      <div className="min-h-screen bg-[#ebebeb] flex flex-col">
        {/* Topbar */}
        <header className="flex items-center justify-between px-8 py-4 bg-white shadow-sm">
          <span className="text-xl font-bold tracking-tight">
            <span className="text-orange-500">BUZZ</span>{" "}
            <span className="text-blue-600">BOOSTER</span>
          </span>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setTab("login")}
              className="text-sm font-semibold text-gray-800 border-b-2 border-orange-500 pb-0.5"
            >
              Se connecter
            </button>
            <button
              onClick={() => setTab("signup")}
              className="text-sm font-semibold text-gray-400 hover:text-gray-700 transition"
            >
              S'inscrire
            </button>
          </div>
        </header>

        {/* Hero */}
        <div className="flex flex-1 items-center">
          <div className="max-w-6xl mx-auto w-full px-6 py-12 grid lg:grid-cols-2 gap-12 items-center">

            {/* Left — Text + Form */}
            <div>
              <h2 className="text-4xl font-extrabold text-gray-900 leading-tight mb-2">
                Plateforme SMM
              </h2>
              <p className="text-lg font-semibold text-gray-700 mb-4">
                N°1 la plus rapide & la moins chère pour l'Afrique francophone
              </p>
              <p className="text-gray-500 text-sm mb-6 leading-relaxed">
                BUZZ BOOSTER est la meilleure plateforme SMM pour booster votre présence sociale.
                Obtenez des abonnés Instagram, TikTok, Facebook et YouTube — sans carte bancaire.
                Service rapide, sécurisé et sans mot de passe.
              </p>

              <div className="flex flex-wrap gap-3 mb-8">
                {[
                  { icon: <CheckCircle2 size={14} />, label: "Politique de remboursement 100%" },
                  { icon: <Zap size={14} />, label: "Livraison instantanée" },
                  { icon: <Shield size={14} />, label: "Paiement sécurisé" },
                ].map((item) => (
                  <span key={item.label} className="flex items-center gap-1.5 text-xs bg-white border border-gray-200 rounded-full px-3 py-1.5 text-gray-600 shadow-sm">
                    <span className="text-orange-500">{item.icon}</span>
                    {item.label}
                  </span>
                ))}
              </div>

              {/* Login form */}
              <form onSubmit={handleLogin} className="space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <input
                    type="email"
                    value={loginEmail}
                    onChange={e => setLoginEmail(e.target.value)}
                    required
                    placeholder="Email"
                    className="px-4 py-3 rounded-xl border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm"
                  />
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={loginPassword}
                      onChange={e => setLoginPassword(e.target.value)}
                      required
                      placeholder="Mot de passe"
                      className="w-full px-4 py-3 pr-10 rounded-xl border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm"
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <label className="flex items-center gap-2 text-gray-500 cursor-pointer select-none">
                    <input type="checkbox" className="accent-orange-500" />
                    Se souvenir de moi
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowForgot(true)}
                    className="text-orange-500 hover:underline font-medium"
                  >
                    Mot de passe oublié ?
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-xl bg-gray-900 text-white font-semibold text-sm hover:bg-gray-800 transition disabled:opacity-60 shadow"
                >
                  {loading ? "Connexion en cours…" : "Se connecter"}
                </button>
              </form>

              <p className="mt-4 text-sm text-gray-500">
                Nouveau ici ?{" "}
                <button
                  type="button"
                  onClick={() => setTab("signup")}
                  className="text-orange-500 font-semibold hover:underline"
                >
                  S'inscrire
                </button>
              </p>
            </div>

            {/* Right — Illustration */}
            <div className="hidden lg:flex items-center justify-center">
              <div className="relative w-80 h-80">
                {/* Central circle */}
                <div className="absolute inset-0 rounded-full bg-white/60 backdrop-blur-sm border border-gray-200 shadow-xl flex items-center justify-center">
                  <div className="text-center">
                    <div className="text-5xl mb-2">🚀</div>
                    <p className="font-bold text-gray-800 text-lg">BUZZ BOOSTER</p>
                    <p className="text-xs text-gray-500 mt-1">SMM Panel Afrique</p>
                  </div>
                </div>
                {/* Floating social icons */}
                {[
                  { emoji: "📸", top: "0%", left: "50%", label: "Instagram" },
                  { emoji: "🎵", top: "25%", left: "92%", label: "TikTok" },
                  { emoji: "▶️", top: "70%", left: "80%", label: "YouTube" },
                  { emoji: "📘", top: "80%", left: "28%", label: "Facebook" },
                  { emoji: "✈️", top: "30%", left: "2%", label: "Telegram" },
                  { emoji: "🐦", top: "5%", left: "18%", label: "Twitter" },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="absolute -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white shadow-md border border-gray-100 flex items-center justify-center text-xl"
                    style={{ top: item.top, left: item.left }}
                    title={item.label}
                  >
                    {item.emoji}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── SIGNUP (palette claire identique à la page de connexion) ─────────────
  return (
    <div className="min-h-screen bg-[#ebebeb] flex flex-col">
      {/* Topbar */}
      <header className="flex items-center justify-between px-8 py-4 bg-white shadow-sm">
        <span className="text-xl font-bold tracking-tight">
          <span className="text-orange-500">BUZZ</span>{" "}
          <span className="text-blue-600">BOOSTER</span>
        </span>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setTab("login")}
            className="text-sm font-semibold text-gray-400 hover:text-gray-700 transition"
          >
            Se connecter
          </button>
          <button
            onClick={() => setTab("signup")}
            className="text-sm font-semibold text-gray-800 border-b-2 border-orange-500 pb-0.5"
          >
            S'inscrire
          </button>
        </div>
      </header>

      {/* Hero */}
      <div className="flex flex-1 items-center">
        <div className="max-w-6xl mx-auto w-full px-6 py-12 grid lg:grid-cols-2 gap-12 items-center">

          {/* Left — Text + Form */}
          <div>
            {/* Badge */}
            <div className="inline-flex items-center gap-2 border border-orange-300 rounded-full px-4 py-1.5 mb-6 bg-orange-50">
              <span className="text-orange-500 text-xs">✦</span>
              <span className="text-orange-600 text-xs font-semibold tracking-wide">BUZZ BOOSTER — #1 en Afrique</span>
            </div>

            <h2 className="text-4xl font-extrabold leading-tight mb-2 text-gray-900">
              Boostez
            </h2>
            <h2 className="text-4xl font-extrabold leading-tight mb-5">
              <span className="bg-gradient-to-r from-orange-500 to-blue-600 bg-clip-text text-transparent">
                Votre Présence
              </span>
            </h2>

            <p className="text-gray-500 text-sm mb-3 leading-relaxed">
              Vous souhaitez développer votre présence sur les réseaux sociaux ?
              Rejoignez BUZZ BOOSTER, la plateforme SMM de confiance avec plus de
              5 ans d'expérience. Nous boostons vos abonnés, likes et vues efficacement.
            </p>

            <div className="flex items-center gap-2 mb-8 text-sm text-gray-500">
              <Clock size={14} className="text-orange-500" />
              <span>Des milliers de commandes traitées avec succès</span>
            </div>

            {/* Signup form */}
            <form onSubmit={handleSignup} className="space-y-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    required
                    placeholder="Nom d'utilisateur"
                    className="w-full pl-9 pr-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm"
                  />
                </div>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                  <input
                    type="email"
                    value={signupEmail}
                    onChange={e => setSignupEmail(e.target.value)}
                    required
                    placeholder="Email"
                    className="w-full pl-9 pr-4 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={signupPassword}
                    onChange={e => setSignupPassword(e.target.value)}
                    required
                    minLength={6}
                    placeholder="Mot de passe"
                    className="w-full pl-9 pr-10 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    required
                    placeholder="Confirmer"
                    className="w-full pl-9 pr-10 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer select-none mt-1">
                <input
                  type="checkbox"
                  checked={acceptPrivacy}
                  onChange={e => setAcceptPrivacy(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-orange-500 cursor-pointer"
                />
                <span className="text-xs text-gray-500 leading-snug">
                  J'accepte la{" "}
                  <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-orange-500 underline hover:text-orange-600">
                    politique de confidentialité
                  </a>{" "}
                  de BUZZ BOOSTER.
                </span>
              </label>

              <button
                type="submit"
                disabled={loading || !acceptPrivacy}
                className="w-full py-3 rounded-xl bg-gray-900 text-white font-semibold text-sm hover:bg-gray-800 transition disabled:opacity-60 shadow"
              >
                {loading ? "Création du compte…" : "Créer mon compte"}
              </button>
            </form>

            <p className="mt-4 text-sm text-gray-500">
              Déjà inscrit ?{" "}
              <button
                type="button"
                onClick={() => setTab("login")}
                className="text-orange-500 font-semibold hover:underline"
              >
                Se connecter
              </button>
            </p>
          </div>

          {/* Right — Illustration claire (style page de connexion) */}
          <div className="hidden lg:flex items-center justify-center">
            <div className="relative w-80 h-96">
              {/* Center card */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-56 rounded-2xl border border-gray-200 bg-white/80 backdrop-blur-sm p-6 text-center shadow-xl">
                  <div className="text-5xl mb-3">⚡</div>
                  <p className="text-gray-800 font-bold text-base mb-1">Rejoignez-nous</p>
                  <p className="text-gray-500 text-xs leading-relaxed">
                    La communauté SMM la plus active d'Afrique francophone
                  </p>
                  <div className="mt-4 flex justify-center gap-3 text-lg">
                    <span title="Instagram">📸</span>
                    <span title="TikTok">🎵</span>
                    <span title="YouTube">▶️</span>
                    <span title="Facebook">📘</span>
                  </div>
                </div>
              </div>

              {/* Floating stat cards */}
              <div className="absolute -top-2 -right-4 bg-white border border-gray-200 rounded-xl px-3 py-2 text-xs shadow-md">
                <p className="font-bold text-orange-500 text-lg">10K+</p>
                <p className="text-gray-500">Utilisateurs actifs</p>
              </div>
              <div className="absolute -bottom-2 -left-4 bg-white border border-gray-200 rounded-xl px-3 py-2 text-xs shadow-md">
                <p className="font-bold text-blue-600 text-lg">1M+</p>
                <p className="text-gray-500">Commandes livrées</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom social bar */}
      <div className="border-t border-gray-200 bg-white py-3">
        <div className="flex items-center justify-center gap-6 text-xs text-gray-500">
          {["Facebook", "Instagram", "Twitter (X)", "YouTube", "TikTok", "Telegram"].map((s) => (
            <span key={s} className="hover:text-gray-700 cursor-pointer transition">{s}</span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Auth;
