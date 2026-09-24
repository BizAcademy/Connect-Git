import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authedFetch } from "@/lib/authFetch";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const missingApiMessage = "Le dépôt crypto n'est pas encore disponible sur le serveur Plesk. Le backend et la migration doivent être mis à jour avant tout paiement.";
const depositFeeBps = 150;
const formatUsd = (minor: number) => `${(minor / 100).toFixed(2)} USD`;

async function cryptoResponse(res: Response): Promise<{ error?: string; available?: boolean; deposit_fee_bps?: number; status?: string; payment_url?: string; amount_minor?: number; fee_minor?: number; charge_minor?: number }> {
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
  const validAmount = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(amount);
  const amountMinor = validAmount ? Math.round(Number(amount) * 100) : null;
  const feeMinor = amountMinor == null ? null : Math.round(amountMinor * depositFeeBps / 10_000);
  const chargeMinor = amountMinor == null || feeMinor == null ? null : amountMinor + feeMinor;
  useEffect(() => {
    let live = true;
    void authedFetch("/api/payments/crypto/availability").then(async res => {
      const data = await cryptoResponse(res);
      if (!res.ok || !data.available) throw new Error(data.error || "Le dépôt crypto est momentanément indisponible.");
      if (data.deposit_fee_bps !== depositFeeBps) throw new Error("Le serveur n'applique pas encore les frais de dépôt de 1,5 %. Aucun paiement ne sera lancé.");
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
    if (amountMinor == null || amountMinor < 100 || amountMinor > 100_000_000 || feeMinor == null || chargeMinor == null) {
      setError("Saisissez un montant valide en USD (minimum 1 USD).");
      return;
    }
    setLoading(true); setError("");
    try {
      const res = await authedFetch("/api/payments/crypto", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, deposit_fee_bps: depositFeeBps, charge_minor: chargeMinor }),
      });
      const data = await cryptoResponse(res);
      if (!res.ok) throw new Error(data.error || "Création du paiement impossible");
      if (data.amount_minor !== amountMinor || data.fee_minor !== feeMinor || data.charge_minor !== chargeMinor) {
        throw new Error("Le montant du paiement ne correspond pas au récapitulatif. Ne payez pas ce lien.");
      }
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
        {availability === "ready" && amountMinor != null && amountMinor >= 100 && amountMinor <= 100_000_000 && feeMinor != null && chargeMinor != null && (
          <div className="rounded-md border p-3 text-sm space-y-1">
            <div className="flex justify-between gap-3"><span>Montant crédité</span><span>{formatUsd(amountMinor)}</span></div>
            <div className="flex justify-between gap-3"><span>Frais de dépôt (1,5 %)</span><span>{formatUsd(feeMinor)}</span></div>
            <div className="flex justify-between gap-3 font-semibold"><span>Total à payer</span><span>{formatUsd(chargeMinor)}</span></div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Vous paierez le montant total affiché sur la page sécurisée IziChange Pay. Seul le montant du dépôt sera crédité après confirmation ; les paiements incomplets ou irréguliers ne sont pas crédités automatiquement.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button onClick={initiate} disabled={loading || availability !== "ready"}>{loading ? "Création en cours…" : availability === "checking" ? "Vérification du service…" : "Continuer vers le paiement"}</Button>
      </CardContent></Card>
  </div>;
}