import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "@/lib/toast";
import { Eye, EyeOff, User, Lock, Mail, CheckCircle2, AlertCircle, Zap, Shield, Clock, Globe, ChevronDown, Gift } from "lucide-react";
import "./AuthVerification.css";
import logoImg from "@/assets/logo-buzzbooster.png";
import loginHeroImg from "@assets/auth-person.webp";
import signupHeroImg from "@assets/signup-person.webp";
import { useSiteContent } from "@/hooks/useSiteContent";
import { useAuth } from "@/hooks/useAuth";
import { prefetchImage } from "@/lib/imagePreload";

// Mise en cache anticipée (arrière-plan, priorité minimale) : les visuels sont
// déjà dans le cache du navigateur quand l'utilisateur arrive sur la page.
prefetchImage(loginHeroImg);
prefetchImage(signupHeroImg);
import { SIGNUP_COUNTRIES } from "@/lib/currency";
import { REF_CODE_RE, checkRefCode, getStoredRefCode, recordRefVisit, storeRefCode } from "@/lib/referral";

const Auth = () => {
  const navigate = useNavigate();
  const { refreshProfile } = useAuth();
  const [searchParams] = useSearchParams();
  const { get } = useSiteContent();
  const loginImg = get("auth_login_image") || loginHeroImg;
  const signupImg = get("auth_signup_image") || signupHeroImg;
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  // Initial tab respects ?tab=signup so Inscription buttons land directly on the signup form.
  // Un lien de parrainage (?ref=CODE) ouvre aussi directement l'inscription.
  const initialTab = searchParams.get("tab") === "signup" || searchParams.has("ref") ? "signup" : "login";
  const [tab, setTab] = useState<"login" | "signup">(initialTab);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [username, setUsername] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signupCountry, setSignupCountry] = useState("");
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [referralCode, setReferralCode] = useState("");
  // true = code appliqué via un lien de parrainage → champ gelé (non modifiable)
  const [refLocked, setRefLocked] = useState(false);

  // Applique le code parrain venu du lien (?ref=CODE) et le gèle pour 30 jours
  // (cookie + localStorage). Sans paramètre ?ref, restaure un éventuel code
  // gelé précédemment — il survit à la fermeture de l'onglet/du navigateur.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromUrl = (searchParams.get("ref") || "").trim().toUpperCase();
      if (fromUrl && REF_CODE_RE.test(fromUrl)) {
        const valid = await checkRefCode(fromUrl);
        if (cancelled) return;
        // valid === null (API injoignable) : on applique quand même — le
        // serveur revalidera le code au moment de l'inscription.
        if (valid !== false) {
          storeRefCode(fromUrl);
          setReferralCode(fromUrl);
          setRefLocked(true);
          if (valid === true) recordRefVisit(fromUrl);
          return;
        }
      }
      const stored = getStoredRefCode();
      if (stored && !cancelled) {
        setReferralCode(stored);
        setRefLocked(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [forgotEmail, setForgotEmail] = useState("");
  const [showForgot, setShowForgot] = useState(false);
  const [verifyEmail, setVerifyEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  // Retained in memory only until verification; never stored in browser storage.
  const [verificationPassword, setVerificationPassword] = useState("");
  const [showVerification, setShowVerification] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [verificationPhase, setVerificationPhase] = useState<"idle" | "checking" | "success" | "error">("idle");
  const [verificationError, setVerificationError] = useState("");
  const [verificationRetryable, setVerificationRetryable] = useState(false);
  // Prevent duplicate requests from the auto-submit effect, button and repeated renders.
  const submittedCodeRef = useRef<string | null>(null);
  const verifyingRef = useRef(false);

  const resetVerification = () => {
    setVerificationCode("");
    setVerificationError("");
    setVerificationRetryable(false);
    setVerificationPhase("idle");
    submittedCodeRef.current = null;
  };

  const startResendCountdown = () => {
    setResendSeconds(60);
    setResendAvailableAt(Date.now() + 60_000);
  };

  useEffect(() => {
    if (!resendAvailableAt) return;
    const update = () => setResendSeconds(Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [resendAvailableAt]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 403 && data.code === "EMAIL_VERIFICATION_REQUIRED") {
        setVerifyEmail(loginEmail.trim().toLowerCase());
        setVerificationPassword(loginPassword);
        setLoginPassword("");
        resetVerification();
        startResendCountdown();
        setShowVerification(true);
        return;
      }
      if (!response.ok) { toast.error(data.error || "Connexion impossible"); return; }
      await refreshProfile();
      toast.success("Connexion réussie !");
      navigate(data.user?.isAdmin ? "/admin" : "/dashboard");
    } catch {
      toast.error("Connexion temporairement indisponible");
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptPrivacy) { toast.error("Vous devez accepter la politique de confidentialité."); return; }
    if (signupPassword !== confirmPassword) { toast.error("Les mots de passe ne correspondent pas"); return; }
    if (signupPassword.length < 8 || new TextEncoder().encode(signupPassword).length > 72) {
      toast.error("Le mot de passe doit contenir au moins 8 caractères et 72 octets maximum"); return;
    }
    if (!username.trim()) { toast.error("Le nom d'utilisateur est requis"); return; }
    if (!signupCountry) { toast.error("Veuillez sélectionner votre pays"); return; }
    const refCode = referralCode.trim().toUpperCase();
    if (refCode && !REF_CODE_RE.test(refCode)) {
      toast.error("Code parrain invalide — vérifiez-le ou laissez le champ vide.");
      return;
    }
    setLoading(true);
    // Code saisi manuellement : on vérifie qu'il existe (les codes venus d'un
    // lien ont déjà été validés). API injoignable → on n'empêche pas l'inscription.
    if (refCode && !refLocked) {
      const valid = await checkRefCode(refCode);
      if (valid === false) {
        setLoading(false);
        toast.error("Ce code parrain n'existe pas — vérifiez-le ou laissez le champ vide.");
        return;
      }
    }
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: signupEmail, password: signupPassword, username, country: signupCountry, referralCode: refCode || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.error(data.error || "Inscription impossible"); return; }
      if (!data.verificationRequired) {
        toast.error("Confirmation indisponible. Réessayez plus tard.");
        return;
      }
      setVerifyEmail(signupEmail.trim().toLowerCase());
      setVerificationPassword(signupPassword);
      setSignupPassword("");
      setConfirmPassword("");
      resetVerification();
      setShowVerification(true);
      startResendCountdown();
      toast.success("Compte créé. Vérifiez votre boîte mail pour le code de confirmation.");
    } catch {
      toast.error("Inscription temporairement indisponible");
    } finally {
      setLoading(false);
    }
  };

  const verifyEmailCode = async (code: string) => {
    if (!/^\d{6}$/.test(code) || verifyingRef.current || submittedCodeRef.current === code || verificationPhase === "success") return;
    verifyingRef.current = true;
    submittedCodeRef.current = code;
    setVerificationError("");
    setVerificationRetryable(false);
    setVerificationPhase("checking");
    setLoading(true);
    const animationStartedAt = window.performance.now();
    const minimumMotionMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1000;
    const finishMotion = async () => {
      const remaining = minimumMotionMs - (window.performance.now() - animationStartedAt);
      if (remaining > 0) await new Promise<void>(resolve => window.setTimeout(resolve, remaining));
    };
    let emailConfirmed = false;
    try {
      const response = await fetch("/api/auth/verify-email", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verifyEmail, code }),
      });
      const data = await response.json().catch(() => ({}));
      await finishMotion();
      if (!response.ok) {
        const serverMessage = typeof data.error === "string" ? data.error : "";
        // The API deliberately gives the same 400 response for wrong and expired codes.
        const wrongCode = [400, 401, 422].includes(response.status);
        setVerificationPhase("error");
        setVerificationRetryable(!wrongCode);
        setVerificationError(wrongCode ? "Code OTP incorrect" : serverMessage || "Vérification indisponible. Réessayez.");
        return;
      }
      emailConfirmed = true;
      setVerificationPhase("success");
      // Keep the server-confirmed state visible before the existing auto-login.
      await new Promise<void>(resolve => window.setTimeout(resolve, 1400));
      const password = verificationPassword;
      setVerificationPassword("");
      if (!password) throw new Error("No password available for automatic sign-in");
      const loginResponse = await fetch("/api/auth/login", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verifyEmail, password }),
      });
      if (!loginResponse.ok) throw new Error("Automatic sign-in failed");
      const loginData = await loginResponse.json();
      await refreshProfile();
      setShowVerification(false);
      toast.success("Adresse e-mail confirmée. Connexion réussie !");
      navigate(loginData.user?.isAdmin ? "/admin" : "/dashboard");
    } catch {
      if (emailConfirmed) {
        setShowVerification(false);
        setTab("login");
        setLoginEmail(verifyEmail);
        setLoginPassword("");
        setVerificationPassword("");
        toast.error("Adresse confirmée, mais connexion automatique indisponible. Connectez-vous avec votre mot de passe.");
      } else {
        await finishMotion();
        setVerificationPhase("error");
        setVerificationRetryable(true);
        setVerificationError("Vérification temporairement indisponible. Réessayez.");
      }
    } finally {
      verifyingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    if (showVerification && verificationPhase === "idle" && /^\d{6}$/.test(verificationCode)) {
      void verifyEmailCode(verificationCode);
    }
    // The effect reacts to code entry only; verifyEmailCode's synchronous ref guard
    // prevents a second request when state changes or React re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verificationCode, verificationPhase, showVerification]);

  const handleVerifyEmail = (e: React.FormEvent) => {
    e.preventDefault();
    if (verificationCode.length !== 6) return;
    if (verificationPhase === "error" && verificationRetryable) submittedCodeRef.current = null;
    void verifyEmailCode(verificationCode);
  };

  const handleResendVerification = async () => {
    if (resendSeconds > 0) return;
    resetVerification();
    setResending(true);
    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verifyEmail }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(data.error || `Renvoi indisponible (erreur serveur ${response.status}).`);
        return;
      }
      startResendCountdown();
      toast.success(data.message || "Si le compte est en attente et que le délai d'une minute est écoulé, un code sera envoyé.");
    } catch {
      toast.error("Impossible de joindre le serveur pour renvoyer le code. Réessayez dans un instant.");
    } finally {
      setResending(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.error(data.error || "Service temporairement indisponible"); return; }
      navigate("/reset-password", { state: { email: forgotEmail.trim().toLowerCase() } });
    } catch {
      toast.error("Service temporairement indisponible");
    } finally {
      setLoading(false);
    }
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
          <p className="text-sm text-gray-500 mb-4">Saisissez votre adresse e-mail. Si un compte existe, un code de réinitialisation vous sera envoyé.</p>
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
              {loading ? "Envoi en cours…" : "Envoyer le code"}
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

  if (showVerification) {
    return (
      <main className="email-verification">
        <section className="email-verification__card" aria-labelledby="verification-title">
          <img src={logoImg} alt="BUZZ BOOSTER" className="email-verification__logo" />
          <div className="email-verification__icon" aria-hidden="true"><Shield size={27} strokeWidth={1.8} /></div>
          <p className="email-verification__eyebrow">Sécurité de votre compte</p>
          <h1 id="verification-title" className="email-verification__title">Confirmez votre e-mail</h1>
          <p className="email-verification__intro">
            Nous avons envoyé un code à <strong data-testid="text-verification-email">{verifyEmail}</strong>.<br />
            Saisissez-le ci-dessous. Il expire après 10 minutes.
          </p>
          <form onSubmit={handleVerifyEmail} className="email-verification__form">
            <label htmlFor="email-otp" className="email-verification__label">Code de confirmation à 6 chiffres</label>
            <div className="email-verification__stage" data-phase={verificationPhase}>
              <div className="email-verification__ring" aria-hidden="true" />
              <div className="email-verification__tiles" aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => {
                  const angle = index * Math.PI / 3 - Math.PI / 2;
                  return (
                    <span
                      key={index}
                      className="email-verification__tile"
                      data-active={verificationPhase === "idle" && index === verificationCode.length}
                      style={{
                        "--tile-index": index,
                        "--orbit-x": `${Math.cos(angle) * 76}px`,
                        "--orbit-y": `${Math.sin(angle) * 76}px`,
                      } as CSSProperties}
                    >{verificationCode[index] || ""}</span>
                  );
                })}
              </div>
              <input
                id="email-otp"
                data-testid="input-email-otp"
                className="email-verification__input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={verificationCode}
                onChange={e => {
                  const nextCode = e.target.value.replace(/\D/g, "").slice(0, 6);
                  if (nextCode !== verificationCode) {
                    submittedCodeRef.current = null;
                    setVerificationError("");
                    setVerificationRetryable(false);
                    setVerificationPhase("idle");
                    setVerificationCode(nextCode);
                  }
                }}
                disabled={verificationPhase === "checking" || verificationPhase === "success"}
                aria-describedby="verification-feedback"
                aria-invalid={verificationPhase === "error"}
                required
                autoFocus
              />
            </div>
            <div id="verification-feedback" className="email-verification__status" data-phase={verificationPhase} role="status" aria-live="polite" data-testid="status-verification">
              {verificationPhase === "checking" && "Vérification du code en cours…"}
              {verificationPhase === "success" && <><CheckCircle2 size={17} aria-hidden="true" /> Vérification réussie</>}
              {verificationPhase === "error" && <><AlertCircle size={17} aria-hidden="true" /> {verificationError}</>}
              {verificationPhase === "idle" && "Le code sera vérifié automatiquement."}
            </div>
            <button type="submit" data-testid="button-verify-email" disabled={verificationCode.length !== 6 || verificationPhase === "checking" || verificationPhase === "success" || (verificationPhase === "error" && !verificationRetryable)} className="email-verification__submit">
              {verificationPhase === "checking" ? "Vérification en cours…" : verificationPhase === "success" ? "Adresse confirmée" : verificationPhase === "error" && verificationRetryable ? "Réessayer la vérification" : "Confirmer mon adresse e-mail"}
            </button>
          </form>
          <div className="email-verification__divider" />
          <button type="button" onClick={handleResendVerification} disabled={resending || resendSeconds > 0 || verificationPhase === "checking" || verificationPhase === "success"} className="email-verification__resend" data-testid="button-resend-verification">
            {resending ? "Demande en cours…" : resendSeconds > 0
              ? `Renvoyer le code dans ${String(Math.floor(resendSeconds / 60)).padStart(2, "0")}:${String(resendSeconds % 60).padStart(2, "0")}`
              : "Je n'ai pas reçu le code — Renvoyer"}
          </button>
          <p className="email-verification__hint" role="status" data-testid="status-resend-cooldown">Un nouveau code peut être demandé une minute après le précédent.</p>
          <button type="button" disabled={verificationPhase === "checking" || verificationPhase === "success"} onClick={() => { setShowVerification(false); setVerificationPassword(""); resetVerification(); setTab("login"); setLoginEmail(verifyEmail); }} className="email-verification__back" data-testid="button-back-to-login">
            Retour à la connexion
          </button>
        </section>
      </main>
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
                    <img src={loginImg} alt="Communauté BUZZ BOOSTER" width={800} height={794} className="w-full h-auto block" loading="eager" decoding="async" />
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
                    width={800}
                    height={794}
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
                  <img src={signupImg} alt="Rejoignez la communauté BUZZ BOOSTER" width={800} height={931} className="w-full h-auto block" loading="eager" decoding="async" />
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

              {/* Code parrain */}
              <div className="relative">
                <Gift className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                <input
                  type="text"
                  value={referralCode}
                  onChange={e => { if (!refLocked) setReferralCode(e.target.value.toUpperCase()); }}
                  readOnly={refLocked}
                  placeholder="Code parrain (optionnel)"
                  className={`w-full pl-9 py-3 rounded-xl border text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 text-sm shadow-sm ${
                    refLocked
                      ? "pr-9 bg-orange-50 border-orange-300 cursor-default tracking-widest font-semibold"
                      : "pr-4 bg-white border-gray-300"
                  }`}
                />
                {refLocked && (
                  <Lock className="absolute right-3 top-1/2 -translate-y-1/2 text-orange-400" size={15} />
                )}
              </div>
              {refLocked && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600 -mt-1">
                  <CheckCircle2 size={12} />
                  Code parrain appliqué via votre lien d'invitation
                </p>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={signupPassword}
                    onChange={e => setSignupPassword(e.target.value)}
                    required
                     minLength={8}
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
                  width={800}
                  height={931}
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
