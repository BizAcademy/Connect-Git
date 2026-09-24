import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authedFetch } from "@/lib/authFetch";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const missingApiMessage = "Le dépôt crypto n'est pas encore disponible sur le serveur Plesk. Le backend et la migration doivent être mis à jour avant tout paiement.";

async function cryptoResponse(res: Response): Promise<{ error?: string; available?: boolean; status?: string; payment_url?: string }> {
  if (!res.headers.get("content-type")?.includes("application/json")) {
    throw new Error(res.status === 404 ? missingApiMessage : "Le serveur de paiement a renvoyé une réponse inattendue. Aucun paiement n'a été lancé.");
  }
  return res.json();
}

export default function CryptoDeposit() {
  const { profile, refreshProfile } = useAuth();
  const [searchParams] = useSearchParams();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [availability, setAvailability] = useState<"checking" | "ready" | "unavailable">("checking");
  useEffect(() => {
    let live = true;
    void authedFetch("/api/payments/crypto/availability").then(async res => {
      const data = await cryptoResponse(res);
      if (!res.ok || !data.available) throw new Error(data.error || "Le dépôt crypto est momentanément indisponible.");
      if (live) setAvailability("ready");
    }).catch(err => {
      if (!live) return;
      setAvailability("unavailable");
      setError(err instanceof Error ? err.message : "Le dépôt crypto est indisponible.");
    });
    return () => { live = false; };
  }, []);
  const paymentId = searchParams.get("crypto");
  useEffect(() => {
    if (!paymentId || availability !== "ready") return;
    let live = true;
    const check = async () => {
      try {
        const res = await authedFetch(`/api/payments/crypto/${encodeURIComponent(paymentId)}`);
        const data = await cryptoResponse(res);
        if (!live) return;
        if (res.ok) {
          if (!data.status) throw new Error("Statut du paiement manquant");
          setStatus(data.status);
          if (data.status === "completed") void refreshProfile();
        } else setError(data.error || "Vérification indisponible");
      } catch { if (live) setError("Vérification indisponible"); }
    };
    void check();
    const timer = window.setInterval(check, 15000);
    return () => { live = false; window.clearInterval(timer); };
  }, [paymentId, refreshProfile, availability]);
  const initiate = async () => {
    if (availability !== "ready") return;
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(amount) || Number(amount) < 1) {
      setError("Saisissez un montant valide en USD (minimum 1 USD).");
      return;
    }
    setLoading(true); setError("");
    try {
      const res = await authedFetch("/api/payments/crypto", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      const data = await cryptoResponse(res);
      if (!res.ok) throw new Error(data.error || "Création du paiement impossible");
      if (!data.payment_url || !data.payment_url.startsWith("https://")) throw new Error("Lien de paiement invalide. Aucun paiement n'a été lancé.");
      window.location.assign(data.payment_url);
    } catch (err) { setError(err instanceof Error ? err.message : "Erreur réseau"); setLoading(false); }
  };
  return <div className="space-y-4">
    <Card><CardContent className="p-5">
      <p className="text-sm text-muted-foreground">Solde USD</p>
      <p className="text-2xl font-bold">{Number(profile?.balance_usd || 0).toFixed(2)} USD</p>
    </CardContent></Card>
    {paymentId && <Card><CardContent className="p-5 space-y-2">
      <p className="font-semibold">Paiement crypto : {status === "completed" ? "Crédité sur votre solde USD" : status === "irregular" ? "Écart de montant : examen nécessaire, aucun crédit automatique" : status === "expired" ? "Expiré" : status === "failed" || status === "canceled" ? "Échoué ou annulé" : "En attente de confirmation"}</p>
      <p className="text-sm text-muted-foreground">La confirmation est vérifiée auprès d’IziChange Pay. Ne payez pas deux fois en attendant la validation.</p>
    </CardContent></Card>}
    <Card><CardHeader><CardTitle className="text-base">Dépôt crypto via IziChange Pay</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <label htmlFor="crypto-amount" className="text-sm font-medium">Montant à créditer (USD)</label>
        <Input id="crypto-amount" type="number" min="1" max="1000000" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Ex. 10.00" />
        <p className="text-xs text-muted-foreground">Vous serez redirigé vers la page sécurisée IziChange Pay. Les paiements incomplets ou irréguliers ne sont pas crédités automatiquement.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button onClick={initiate} disabled={loading || availability !== "ready"}>{loading ? "Création en cours…" : availability === "checking" ? "Vérification du service…" : "Continuer vers le paiement"}</Button>
      </CardContent></Card>
  </div>;
}