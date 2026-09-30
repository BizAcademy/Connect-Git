import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "@/lib/toast";
import logoImg from "@/assets/logo-buzzbooster.png";

const RESEND_COOLDOWN_SECONDS = 5 * 60;

const ResetPassword = () => {
  const navigate = useNavigate();
  const location = useLocation();
  // Fragments are never sent in HTTP requests. Keep legacy link tokens only in
  // component memory, then remove them from the address bar.
  const [legacyMode] = useState(() =>
    /^[A-Za-z0-9_-]{43}$/.test(new URLSearchParams(window.location.hash.slice(1)).get("token") || ""));
  const [token, setToken] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
  });
  const initialEmail = (location.state as { email?: string } | null)?.email || "";
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    !legacyMode && initialEmail
      ? "Si un compte existe pour cet e-mail, un code de réinitialisation vous a été envoyé."
      : "",
  );
  const [resendAvailableAt, setResendAvailableAt] = useState(
    !legacyMode && initialEmail ? Date.now() + RESEND_COOLDOWN_SECONDS * 1000 : 0,
  );
  const [resendSeconds, setResendSeconds] = useState(
    !legacyMode && initialEmail ? RESEND_COOLDOWN_SECONDS : 0,
  );

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }, []);

  useEffect(() => {
    if (!resendAvailableAt) return;
    const update = () => setResendSeconds(Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [resendAvailableAt]);

  const handleResendCode = async () => {
    if (resendSeconds > 0 || resending) return;
    setResending(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(data.error || "Service temporairement indisponible");
        return;
      }
      setStatusMessage("Si un compte existe pour cet e-mail, un code de réinitialisation vous sera envoyé.");
      setResendAvailableAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      setResendSeconds(RESEND_COOLDOWN_SECONDS);
    } catch {
      toast.error("Service temporairement indisponible");
    } finally {
      setResending(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error("Les mots de passe ne correspondent pas");
      return;
    }
    if (password.length < 8 || new TextEncoder().encode(password).length > 72) {
      toast.error("Le mot de passe doit contenir au moins 8 caractères et 72 octets maximum");
      return;
    }
    if (legacyMode) {
      if (!token) { toast.error("Lien invalide ou expiré. Demandez-en un nouveau."); return; }
    } else {
      if (!email.trim()) { toast.error("Saisissez votre adresse e-mail."); return; }
      if (!/^\d{6}$/.test(code)) { toast.error("Saisissez le code à 6 chiffres reçu par e-mail."); return; }
    }

    setLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(legacyMode ? { token, password } : { email: email.trim(), code, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.error(data.error || "Réinitialisation impossible"); return; }
      setToken("");
      setCode("");
      setPassword("");
      setConfirmPassword("");
      setSuccess(true);
      toast.success("Mot de passe mis à jour !");
    } catch {
      toast.error("Service temporairement indisponible");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f0f0f0] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-6 sm:p-8">
        <div className="text-center mb-6">
          <img src={logoImg} alt="BUZZ BOOSTER" className="h-12 w-auto mx-auto rounded-md" />
          <h1 className="text-xl font-bold text-gray-900 mt-5">Nouveau mot de passe</h1>
          {!legacyMode && !success && (
            <p className="text-gray-500 text-sm mt-2">
              Saisissez le code reçu par e-mail puis choisissez un nouveau mot de passe.
            </p>
          )}
        </div>
        {success ? (
          <div className="space-y-4 text-center">
            <p role="status" className="text-sm text-gray-600">Mot de passe mis à jour. Connectez-vous avec votre nouveau mot de passe.</p>
            <button onClick={() => navigate("/auth")} className="w-full py-3 rounded-xl bg-gray-900 text-white font-semibold text-sm hover:bg-gray-800 transition">
              Se connecter
            </button>
          </div>
        ) : legacyMode && !token ? (
          <div className="space-y-4 text-center">
            <p role="alert" className="text-sm text-gray-600">Lien invalide ou expiré. Demandez-en un nouveau depuis la page de connexion.</p>
            <button onClick={() => navigate("/auth")} className="w-full py-3 rounded-xl bg-gray-900 text-white font-semibold text-sm hover:bg-gray-800 transition">
              Retour à la connexion
            </button>
          </div>
        ) : (
          <>
            {!legacyMode && statusMessage && <p role="status" className="text-sm text-green-700 mb-4">{statusMessage}</p>}
            <form onSubmit={handleReset} className="space-y-4">
              {!legacyMode && (
                <>
                  <div>
                    <label htmlFor="reset-email" className="block text-sm font-medium text-gray-700 mb-2">Adresse e-mail</label>
                    <input
                      id="reset-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                      placeholder="votre@email.com"
                      className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </div>
                  <div>
                    <label htmlFor="reset-code" className="block text-sm font-medium text-gray-700 mb-2">Code de réinitialisation</label>
                    <input
                      id="reset-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={code}
                      onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      required
                      placeholder="000000"
                      className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white text-center text-2xl tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </div>
                </>
              )}
              <div>
                <label htmlFor="reset-password" className="block text-sm font-medium text-gray-700 mb-2">Nouveau mot de passe</label>
                <input
                  id="reset-password"
                  autoComplete="new-password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
                <p className="text-xs text-gray-500 mt-1">8 caractères minimum, 72 octets maximum.</p>
              </div>
              <div>
                <label htmlFor="confirm-reset-password" className="block text-sm font-medium text-gray-700 mb-2">Confirmer le mot de passe</label>
                <input
                  id="confirm-reset-password"
                  autoComplete="new-password"
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
              <button type="submit" disabled={loading} className="w-full py-3 rounded-xl bg-gray-900 text-white font-semibold text-sm hover:bg-gray-800 transition disabled:opacity-60">
                {loading ? "Mise à jour…" : "Mettre à jour le mot de passe"}
              </button>
            </form>
            {!legacyMode && (
              <>
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={resending || resendSeconds > 0 || !email.trim()}
                  className="w-full mt-4 py-2 text-sm font-medium text-orange-600 hover:underline disabled:opacity-60 disabled:no-underline"
                >
                  {resending ? "Demande en cours…" : resendSeconds > 0
                    ? `Renvoyer le code dans ${String(Math.floor(resendSeconds / 60)).padStart(2, "0")}:${String(resendSeconds % 60).padStart(2, "0")}`
                    : "Je n'ai pas reçu le code — Renvoyer"}
                </button>
                <p className="text-xs text-center text-gray-500 mt-1">Un nouveau code peut être demandé cinq minutes après le précédent. Seul le dernier demandé fonctionne.</p>
              </>
            )}
            <button type="button" onClick={() => navigate("/auth")} className="w-full mt-3 py-2 text-sm text-gray-500 hover:text-gray-700 transition">
              Retour à la connexion
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;