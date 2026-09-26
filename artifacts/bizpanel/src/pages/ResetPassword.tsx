import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/lib/toast";

const ResetPassword = () => {
  const navigate = useNavigate();
  // Fragments are never sent in HTTP requests. Keep the secret only in component
  // memory after mounting; never put it in query strings or browser navigation.
  const [token, setToken] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
  });
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

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
    if (!token) { toast.error("Lien invalide ou expiré. Demandez-en un nouveau."); return; }
    setLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.error(data.error || "Réinitialisation impossible"); return; }
      setToken("");
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
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="font-heading text-2xl">Nouveau mot de passe</CardTitle>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="space-y-4 text-center">
              <p role="status">Mot de passe mis à jour. Connectez-vous avec votre nouveau mot de passe.</p>
              <Button onClick={() => navigate("/auth")} className="w-full">Se connecter</Button>
            </div>
          ) : !token ? (
            <div className="space-y-4 text-center">
              <p role="alert">Lien invalide ou expiré. Demandez-en un nouveau depuis la page de connexion.</p>
              <Button onClick={() => navigate("/auth")} className="w-full">Retour à la connexion</Button>
            </div>
          ) : (
          <form onSubmit={handleReset} className="space-y-4">
            <div>
              <Label htmlFor="reset-password">Nouveau mot de passe</Label>
              <Input id="reset-password" autoComplete="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </div>
            <div>
              <Label htmlFor="confirm-reset-password">Confirmer</Label>
              <Input id="confirm-reset-password" autoComplete="new-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Mise à jour..." : "Mettre à jour le mot de passe"}
            </Button>
          </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ResetPassword;
