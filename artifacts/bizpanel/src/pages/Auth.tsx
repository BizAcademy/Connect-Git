import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Eye, EyeOff, User, Lock, Mail, CheckCircle2, Zap, Shield, Clock, Globe, ChevronDown } from "lucide-react";
import logoImg from "@/assets/logo-buzzbooster.png";
import defaultCommunityImg from "@assets/6044021293859933661_1778088768929.jpg";
import { useSiteContent } from "@/hooks/useSiteContent";
import { SIGNUP_COUNTRIES } from "@/lib/currency";
import { authedFetch } from "@/lib/authFetch";

const Auth = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { get } = useSiteContent();
  const loginImg = get("auth_login_image") || defaultCommunityImg;
  const signupImg = get("auth_signup_image") || defaultCommunityImg;
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  // Initial tab respects ?tab=signup so Inscription buttons land directly on the signup form.
  const initialTab = searchParams.get("tab") === "signup" ? "signup" : "login";
  const [tab, setTab] = useState<"login" | "signup">(initialTab);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [username, setUsername] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signupCountry, setSignupCountry] = useState("");
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
    if (!signupCountry) { toast.error("Veuillez sélectionner votre pays"); return; }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: signupEmail,
      password: signupPassword,
      // Pass country in metadata so any trigger/function has access to it
      options: { emailRedirectTo: window.location.origin, data: { username, country: signupCountry } },
    });
    if (error) { setLoading(false); toast.error(error.message); return; }

    // Always store country in localStorage as a guaranteed fallback.
    // This covers the email-confirmation flow where data.session is null
    // (the user must confirm before logging in). DashboardLayout reads
    // this key on first authenticated load and saves it via API if the
    // profile still has no country set.
    localStorage.setItem("bb_pending_country", signupCountry);

    // When session is available (email confirmation disabled), also save
    // immediately via API — retry up to 3× to handle the brief lag
    // between signUp and profile-row creation by the Supabase trigger.
    const session = data.session;
    if (session) {
      let saved = false;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
        try {
          const res = await authedFetch("/api/profile/country", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ country: signupCountry }),
          });
          if (res.ok) { saved = true; localStorage.removeItem("bb_pending_country"); }
        } catch { /* retry */ }
      }
    }

    setLoading(false);
    toast.success("Compte créé ! Bienvenue sur BUZZ BOOSTER 🎉");
    navigate("/dashboard");
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
            <img src={logoImg} alt="BUZZ BOOSTER" className="h-12 w-auto mx-auto rounded-md" />
            <p className="text-gray-500 text-sm mt-3">Récupération du mot de passe</p>
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
        <header className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-4 bg-white shadow-sm">
          <button onClick={() => navigate("/")} aria-label="BUZZ BOOSTER" className="flex items-center">
            <img src={logoImg} alt="BUZZ BOOSTER" className="h-9 sm:h-11 w-auto rounded-md" />
          </button>
          <div className="flex items-center gap-3 sm:gap-4">
            <button
              onClick={() => setTab("login")}
              className="text-xs sm:text-sm font-semibold text-gray-800 border-b-2 border-orange-500 pb-0.5"
            >
              Se connecter
            </button>
            <button
              onClick={() => setTab("signup")}
              className="text-xs sm:text-sm font-semibold text-gray-400 hover:text-gray-700 transition"
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
              {/* Bannière image visible sur mobile/tablette uniquement */}
              <div className="lg:hidden mb-6 flex justify-center">
                <div className="relative w-full max-w-xs">
                  <div
                    className="absolute -inset-2 rounded-2xl blur-xl opacity-50"
                    style={{ background: "radial-gradient(circle at 30% 30%, hsl(25, 100%, 60%) 0%, hsl(215, 85%, 55%) 80%, transparent 100%)" }}
                  />
                  <div className="relative rounded-2xl overflow-hidden shadow-lg bg-white">
                    <img src={loginImg} alt="Communauté BUZZ BOOSTER" className="w-full h-auto block" loading="eager" decoding="async" />
                  </div>
                </div>
              </div>

              <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 leading-tight mb-2">
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

            {/* Right — Illustration communauté */}
            <div className="hidden lg:flex items-center justify-center">
              <div className="relative w-full max-w-md">
                <div
                  className="absolute -inset-4 rounded-[2rem] blur-2xl opacity-50"
                  style={{
                    background:
                      "radial-gradient(circle at 30% 30%, hsl(25, 100%, 60%) 0%, hsl(215, 85%, 55%) 70%, transparent 100%)",
                  }}
                />
                <div className="relative rounded-3xl overflow-hidden shadow-2xl bg-white">
                  <img
                    src={loginImg}
                    alt="Communauté BUZZ BOOSTER"
                    className="w-full h-auto block"
                    loading="eager"
                    decoding="async"
                  />
                </div>
                <div className="absolute -top-3 -right-3 bg-white rounded-2xl shadow-xl px-3.5 py-2.5">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Utilisateurs</p>
                  <p className="text-lg font-black text-orange-500">10K+</p>
                  <p className="text-[10px] font-semibold text-green-500">actifs aujourd'hui</p>
                </div>
                <div className="absolute -bottom-3 -left-3 bg-white rounded-2xl shadow-xl px-3.5 py-2.5">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Commandes</p>
                  <p className="text-lg font-black text-blue-600">1M+</p>
                  <p className="text-[10px] font-semibold text-gray-500">livrées</p>
                </div>
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
      <header className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-4 bg-white shadow-sm">
        <button onClick={() => navigate("/")} aria-label="BUZZ BOOSTER" className="flex items-center">
          <img src={logoImg} alt="BUZZ BOOSTER" className="h-9 sm:h-11 w-auto rounded-md" />
        </button>
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={() => setTab("login")}
            className="text-xs sm:text-sm font-semibold text-gray-400 hover:text-gray-700 transition"
          >
            Se connecter
          </button>
          <button
            onClick={() => setTab("signup")}
            className="text-xs sm:text-sm font-semibold text-gray-800 border-b-2 border-orange-500 pb-0.5"
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
            {/* Bannière image visible sur mobile/tablette uniquement */}
            <div className="lg:hidden mb-6 flex justify-center">
              <div className="relative w-full max-w-xs">
                <div
                  className="absolute -inset-2 rounded-2xl blur-xl opacity-50"
                  style={{ background: "radial-gradient(circle at 70% 30%, hsl(215, 85%, 55%) 0%, hsl(25, 100%, 60%) 80%, transparent 100%)" }}
                />
                <div className="relative rounded-2xl overflow-hidden shadow-lg bg-white">
                  <img src={signupImg} alt="Rejoignez la communauté BUZZ BOOSTER" className="w-full h-auto block" loading="eager" decoding="async" />
                </div>
              </div>
            </div>

            {/* Badge */}
            <div className="inline-flex items-center gap-2 border border-orange-300 rounded-full px-4 py-1.5 mb-6 bg-orange-50">
              <span className="text-orange-500 text-xs">✦</span>
              <span className="text-orange-600 text-xs font-semibold tracking-wide">BUZZ BOOSTER — #1 en Afrique</span>
            </div>

            <h2 className="text-3xl sm:text-4xl font-extrabold leading-tight mb-2 text-gray-900">
              Boostez
            </h2>
            <h2 className="text-3xl sm:text-4xl font-extrabold leading-tight mb-5">
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

              {/* Pays */}
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={15} />
                <select
                  value={signupCountry}
                  onChange={e => setSignupCountry(e.target.value)}
                  required
                  className="w-full appearance-none pl-9 pr-10 py-3 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm cursor-pointer"
                >
                  <option value="">— Votre pays —</option>
                  {SIGNUP_COUNTRIES.map(c => (
                    <option key={c.code} value={c.code}>{c.name} ({c.currency})</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={15} />
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

          {/* Right — Illustration communauté */}
          <div className="hidden lg:flex items-center justify-center">
            <div className="relative w-full max-w-md">
              <div
                className="absolute -inset-4 rounded-[2rem] blur-2xl opacity-50"
                style={{
                  background:
                    "radial-gradient(circle at 70% 30%, hsl(215, 85%, 55%) 0%, hsl(25, 100%, 60%) 70%, transparent 100%)",
                }}
              />
              <div className="relative rounded-3xl overflow-hidden shadow-2xl bg-white">
                <img
                  src={signupImg}
                  alt="Rejoignez la communauté BUZZ BOOSTER"
                  className="w-full h-auto block"
                  loading="eager"
                  decoding="async"
                />
              </div>
              <div className="absolute -top-3 -right-3 bg-white rounded-2xl shadow-xl px-3.5 py-2.5">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Utilisateurs</p>
                <p className="text-lg font-black text-orange-500">10K+</p>
                <p className="text-[10px] font-semibold text-green-500">actifs aujourd'hui</p>
              </div>
              <div className="absolute -bottom-3 -left-3 bg-white rounded-2xl shadow-xl px-3.5 py-2.5">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Commandes</p>
                <p className="text-lg font-black text-blue-600">1M+</p>
                <p className="text-[10px] font-semibold text-gray-500">livrées</p>
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
