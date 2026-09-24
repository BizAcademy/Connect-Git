import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authedFetch } from "@/lib/authFetch";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function CryptoDeposit() {
  const { profile, refreshProfile } = useAuth();
  const [searchParams] = useSearchParams();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const paymentId = searchParams.get("crypto");
  useEffect(() => {
    if (!paymentId) return;
    let live = true;
    const check = async () => {
      try {
        const res = await authedFetch(`/api/payments/crypto/${encodeURIComponent(paymentId)}`);
        const data = await res.json();
        if (!live) return;
        if (res.ok) {
          setStatus(data.status);
          if (data.status === "completed") void refreshProfile();
        } else setError(data.error || "Vérification indisponible");
      } catch { if (live) setError("Vérification indisponible"); }
    };
    void check();
    const timer = window.setInterval(check, 15000);
    return () => { live = false; window.clearInterval(timer); };
  }, [paymentId, refreshProfile]);
  const initiate = async () => {
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Création du paiement impossible");
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
        <Button onClick={initiate} disabled={loading}>{loading ? "Création en cours…" : "Continuer vers le paiement"}</Button>
      </CardContent></Card>
  </div>;
}