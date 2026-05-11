import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { getAuthHeaders, authedFetch } from "@/lib/authFetch";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Wallet, Smartphone, Shield, Zap, Gift, ArrowLeft, Loader2, CheckCircle2, XCircle,
} from "lucide-react";

const AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];
const BONUS_THRESHOLD = 5000;
const BONUS_AMOUNT = 200;
const POLL_INTERVAL_MS = 15_000; // AfribaPay sandbox limits to 6 req/min → poll every 15s
const POLL_DURATION_MS = 300_000; // 5 min max wait

interface Operator {
  code: string;
  name: string;
  otp_required: boolean;
  currency?: string;
}
interface Country {
  code: string;
  name: string;
  prefix?: string;
  currency?: string;
  operators: Operator[];
}

const authHeaders = getAuthHeaders;
const fetch = authedFetch;

type Step = "country" | "operator" | "phone" | "otp" | "amount" | "confirm" | "wait" | "success" | "failed";

export default function Deposit() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [countries, setCountries] = useState<Country[]>([]);
  const [loadingCountries, setLoadingCountries] = useState(true);
  const [countriesError, setCountriesError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("country");
  const [country, setCountry] = useState<Country | null>(null);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);

  const [amount, setAmount] = useState(0);
  const [custom, setCustom] = useState("");
  const finalAmount = custom ? Number(custom) : amount;
  const isEligible = Number.isFinite(finalAmount) && finalAmount >= BONUS_THRESHOLD;
  const bonus = isEligible ? BONUS_AMOUNT : 0;

  const [submitting, setSubmitting] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [waitMessage, setWaitMessage] = useState<string>("");
  const [pollingExpired, setPollingExpired] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [failedReason, setFailedReason] = useState<string>("");
  const [creditedSummary, setCreditedSummary] = useState<{ amount: number; bonus: number } | null>(null);

  const pollTimerRef = useRef<number | null>(null);
  const pollStartRef = useRef<number>(0);

  // --- Load countries -----------------------------------------------------
  // Pulls the live list of countries+operators from AfribaPay (proxied by our
  // API). When `force=true`, asks the server to bypass its 60 s cache so a
  // freshly recovered operator reappears immediately.
  const loadCountries = useCallback(async (force = false) => {
    setLoadingCountries(true);
    setCountriesError(null);
    try {
      const url = force ? "/api/payments/countries?refresh=1" : "/api/payments/countries";
      const r = await fetch(url, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setCountriesError(data?.error || "Impossible de charger la liste des pays");
      } else {
        setCountries((data.countries || []) as Country[]);
      }
    } catch (e: any) {
      setCountriesError(e?.message || "Erreur réseau");
    } finally {
      setLoadingCountries(false);
    }
  }, []);

  // Initial load + auto-refresh when the tab regains focus (so operators
  // that come back online while the user was elsewhere reappear).
  useEffect(() => {
    loadCountries(false);
    const onFocus = () => loadCountries(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadCountries]);

  const sortedCountries = useMemo(
    () => [...countries].sort((a, b) => a.name.localeCompare(b.name, "fr")),
    [countries],
  );

  // --- Polling ------------------------------------------------------------
  useEffect(() => {
    if (step !== "wait" || !orderId) return;
    pollStartRef.current = Date.now();
    setPollingExpired(false);

    const tick = async () => {
      if (Date.now() - pollStartRef.current >= POLL_DURATION_MS) {
        setPollingExpired(true);
        return;
      }
      try {
        const headers = await authHeaders();
        const r = await fetch(`/api/payments/status/${encodeURIComponent(orderId)}`, { headers });
        const data = await r.json();
        if (r.ok && data?.status === "completed") {
          setCreditedSummary({
            amount: Number(data.amount_credited || finalAmount),
            bonus: Number(data.bonus_credited || 0),
          });
          if (refreshProfile) await refreshProfile().catch(() => undefined);
          setStep("success");
          const credited = Number(data.amount_credited || finalAmount);
          const bonusGot = Number(data.bonus_credited || 0);
          toast.success(
            bonusGot > 0
              ? `Dépôt de ${credited.toLocaleString()} FCFA confirmé (+${bonusGot.toLocaleString()} FCFA bonus) !`
              : `Dépôt de ${credited.toLocaleString()} FCFA confirmé !`,
          );
          window.setTimeout(() => navigate("/dashboard"), 1500);
          return;
        }
        if (r.ok && (data?.status === "failed" || data?.status === "rejected")) {
          setFailedReason("Paiement refusé ou annulé.");
          setStep("failed");
          return;
        }
      } catch {
        // ignore transient network errors during polling
      }
      pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    };
  }, [step, orderId, finalAmount, refreshProfile, navigate]);

  const checkStatusManually = async () => {
    if (!orderId) return;
    setVerifying(true);
    try {
      const headers = await authHeaders();
      const r = await fetch(`/api/payments/status/${encodeURIComponent(orderId)}`, { headers });
      const data = await r.json();
      if (r.ok && data?.status === "completed") {
        setCreditedSummary({
          amount: Number(data.amount_credited || finalAmount),
          bonus: Number(data.bonus_credited || 0),
        });
        if (refreshProfile) await refreshProfile().catch(() => undefined);
        setStep("success");
        const credited = Number(data.amount_credited || finalAmount);
        const bonusGot = Number(data.bonus_credited || 0);
        toast.success(
          bonusGot > 0
            ? `Dépôt de ${credited.toLocaleString()} FCFA confirmé (+${bonusGot.toLocaleString()} FCFA bonus) !`
            : `Dépôt de ${credited.toLocaleString()} FCFA confirmé !`,
        );
        window.setTimeout(() => navigate("/dashboard"), 1500);
      } else if (r.ok && (data?.status === "failed" || data?.status === "rejected")) {
        setFailedReason("Paiement refusé ou annulé.");
        setStep("failed");
      } else {
        toast.info("Paiement encore en attente. Vérifiez votre téléphone.");
      }
    } catch (e: any) {
      toast.error(e?.message || "Erreur de vérification");
    } finally {
      setVerifying(false);
    }
  };

  const requestOtp = async () => {
    if (!country || !operator) return;
    setOtpLoading(true);
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
      const r = await fetch("/api/payments/otp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          country: country.code,
          operator: operator.code,
          phone_number: phone,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data?.error || "Impossible d'envoyer le code");
        return;
      }
      setOtpRequested(true);
      toast.success("Code envoyé. Vérifiez vos SMS.");
    } catch (e: any) {
      toast.error(e?.message || "Erreur réseau");
    } finally {
      setOtpLoading(false);
    }
  };

  const initiate = async () => {
    if (!user || !country || !operator) return;
    if (finalAmount < 500) { toast.error("Montant minimum : 500 FCFA"); return; }
    setSubmitting(true);
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
      const r = await fetch("/api/payments/initiate", {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: finalAmount,
          country: country.code,
          operator: operator.code,
          phone_number: phone,
          otp_code: operator.otp_required ? otp : undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data?.error || "Erreur lors du paiement");
        return;
      }
      setOrderId(data.order_id);
      setWaitMessage(data.message || "Confirmez la transaction sur votre téléphone.");
      setStep("wait");
    } catch (e: any) {
      toast.error(e?.message || "Erreur réseau");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStep("country");
    setCountry(null); setOperator(null); setPhone(""); setOtp(""); setOtpRequested(false);
    setAmount(0); setCustom("");
    setOrderId(null); setWaitMessage(""); setPollingExpired(false);
    setFailedReason(""); setCreditedSummary(null);
    // Force-refresh: a paiement raté est souvent dû à un opérateur tombé.
    // On rafraîchit la liste pour que l'utilisateur voie l'état réel.
    void loadCountries(true);
  };

  // --- Stepper UI helpers --------------------------------------------------
  const stepIndex: Record<Step, number> = {
    country: 1, operator: 2, phone: 3, otp: 3, amount: 4, confirm: 5,
    wait: 6, success: 6, failed: 6,
  };
  const totalSteps = 6;

  const canBack = ["operator", "phone", "otp", "amount", "confirm"].includes(step);
  const goBack = () => {
    if (step === "operator") setStep("country");
    else if (step === "phone") setStep("operator");
    else if (step === "otp") setStep("phone");
    else if (step === "amount") setStep(operator?.otp_required ? "otp" : "phone");
    else if (step === "confirm") setStep("amount");
  };

  // --- Render --------------------------------------------------------------
  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold font-heading">Recharger mon solde</h2>
          <p className="text-sm text-muted-foreground">Paiement Mobile Money sécurisé</p>
        </div>
        {canBack && (
          <Button variant="ghost" size="sm" onClick={goBack}>
            <ArrowLeft size={14} className="mr-1" /> Retour
          </Button>
        )}
      </div>

      <Card className="bg-blue-600 text-white border-blue-600">
        <CardContent className="p-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center">
            <Wallet size={22} />
          </div>
          <div>
            <p className="text-sm opacity-80">Solde actuel</p>
            <p className="text-3xl font-bold">{Number(profile?.balance || 0).toLocaleString()} FCFA</p>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border-2 border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-amber-400 text-white flex items-center justify-center shrink-0">
          <Gift size={18} />
        </div>
        <div className="text-sm">
          <p className="font-bold text-amber-900 dark:text-amber-100">
            Bonus : +{BONUS_AMOUNT.toLocaleString()} FCFA offerts dès {BONUS_THRESHOLD.toLocaleString()} FCFA déposés !
          </p>
          <p className="text-amber-800 dark:text-amber-200/90 mt-0.5">
            Crédité automatiquement avec votre dépôt confirmé.
          </p>
        </div>
      </div>

      {/* Stepper indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Étape {stepIndex[step]} / {totalSteps}</span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(stepIndex[step] / totalSteps) * 100}%` }}
          />
        </div>
      </div>

      {/* Step 1 — Country */}
      {step === "country" && (
        <Card>
          <CardHeader><CardTitle className="text-base">Choisir un pays</CardTitle></CardHeader>
          <CardContent>
            {loadingCountries ? (
              <div className="flex justify-center py-8"><Loader2 className="animate-spin" /></div>
            ) : countriesError ? (
              <p className="text-sm text-destructive">{countriesError}</p>
            ) : sortedCountries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun pays disponible.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {sortedCountries.map((c) => (
                  <button
                    key={c.code}
                    onClick={() => { setCountry(c); setOperator(null); setStep("operator"); }}
                    className="text-left p-3 rounded-lg border hover:border-primary transition-colors"
                  >
                    <p className="font-semibold text-sm">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.code}{c.prefix ? ` · ${c.prefix}` : ""}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2 — Operator */}
      {step === "operator" && country && (
        <Card>
          <CardHeader><CardTitle className="text-base">Opérateur ({country.name})</CardTitle></CardHeader>
          <CardContent>
            {country.operators.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun opérateur disponible pour ce pays.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {country.operators.map((op) => (
                  <button
                    key={op.code}
                    onClick={() => { setOperator(op); setOtp(""); setOtpRequested(false); setStep("phone"); }}
                    className="text-left p-3 rounded-lg border hover:border-primary transition-colors"
                  >
                    <p className="font-semibold text-sm">{op.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {op.code}{op.otp_required ? " · OTP requis" : ""}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3 — Phone */}
      {step === "phone" && country && operator && (
        <Card>
          <CardHeader><CardTitle className="text-base">Numéro de téléphone</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="phone">Numéro {country.prefix ? `(${country.prefix})` : ""}</Label>
            <Input
              id="phone"
              type="tel"
              placeholder={country.prefix ? `${country.prefix} XX XX XX XX` : "Ex : 07 12 34 56 78"}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Le numéro associé à votre compte mobile money chez {operator.name}.
            </p>
            <Button
              className="w-full"
              disabled={phone.replace(/\D/g, "").length < 6}
              onClick={() => setStep(operator.otp_required ? "otp" : "amount")}
            >
              Continuer
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 3bis — OTP */}
      {step === "otp" && country && operator && (
        <Card>
          <CardHeader><CardTitle className="text-base">Code de vérification</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Votre opérateur ({operator.name}) exige un code OTP. Demandez-le, puis saisissez-le ci-dessous.
            </p>
            <Button variant="outline" onClick={requestOtp} disabled={otpLoading} className="w-full">
              {otpLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}
              {otpRequested ? "Renvoyer le code" : "Recevoir le code"}
            </Button>
            <Label htmlFor="otp">Code reçu</Label>
            <Input
              id="otp"
              inputMode="numeric"
              placeholder="Ex : 123456"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            />
            <Button
              className="w-full"
              disabled={otp.length < 4}
              onClick={() => setStep("amount")}
            >
              Continuer
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 4 — Amount */}
      {step === "amount" && (
        <Card>
          <CardHeader><CardTitle className="text-base">Montant</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {AMOUNTS.map(a => (
                <button
                  key={a}
                  onClick={() => { setAmount(a); setCustom(""); }}
                  className={`py-3 rounded-lg border text-sm font-semibold transition-colors ${
                    amount === a && !custom ? "bg-primary text-primary-foreground border-primary" : "border-border hover:border-primary"
                  }`}
                >
                  {a.toLocaleString()} F
                </button>
              ))}
            </div>
            <div>
              <Label htmlFor="custom">Ou entrez un montant personnalisé</Label>
              <Input
                id="custom"
                type="number"
                placeholder="Ex : 15 000"
                value={custom}
                onChange={e => { setCustom(e.target.value); setAmount(0); }}
                className="mt-1"
              />
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Gift size={13} className={isEligible ? "text-amber-500" : "text-muted-foreground/60"} />
                Bonus dépôt
              </span>
              {isEligible ? (
                <span className="font-bold text-amber-600">+{bonus.toLocaleString()} FCFA</span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  dès {BONUS_THRESHOLD.toLocaleString()} FCFA
                </span>
              )}
            </div>
            <Button
              className="w-full"
              disabled={finalAmount < 500}
              onClick={() => setStep("confirm")}
            >
              Continuer
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 5 — Confirm */}
      {step === "confirm" && country && operator && (
        <Card>
          <CardHeader><CardTitle className="text-base">Récapitulatif</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Pays</span><span className="font-medium">{country.name}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Opérateur</span><span className="font-medium">{operator.name}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Téléphone</span><span className="font-medium">{phone}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Montant</span><span className="font-bold">{finalAmount.toLocaleString()} FCFA</span></div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bonus</span>
              <span className={isEligible ? "font-bold text-amber-600" : "text-xs text-muted-foreground"}>
                {isEligible ? `+${bonus.toLocaleString()} FCFA` : `dès ${BONUS_THRESHOLD.toLocaleString()} FCFA`}
              </span>
            </div>
            <div className="border-t pt-3 flex justify-between">
              <span className="font-medium">Nouveau solde estimé</span>
              <span className="font-bold text-primary">
                {(Number(profile?.balance || 0) + finalAmount + bonus).toLocaleString()} FCFA
              </span>
            </div>
            <Button className="w-full h-12" onClick={initiate} disabled={submitting}>
              <Smartphone size={16} className="mr-2" />
              {submitting ? "Envoi..." : `Confirmer ${finalAmount.toLocaleString()} FCFA`}
            </Button>
            <div className="flex items-center gap-4 justify-center text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Shield size={12} /> Sécurisé</span>
              <span className="flex items-center gap-1"><Zap size={12} /> Crédit instantané</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 6 — Wait */}
      {step === "wait" && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center gap-4">
            <Loader2 size={42} className="animate-spin text-primary" />
            <p className="font-semibold">{waitMessage || "Confirmez la transaction sur votre téléphone."}</p>
            <p className="text-sm text-muted-foreground">
              Composez le code USSD ou validez la notification mobile money pour finaliser le paiement.
            </p>
            {pollingExpired && (
              <div className="space-y-2 w-full max-w-xs">
                <p className="text-xs text-muted-foreground">
                  Le délai d'attente automatique est écoulé. Vous pouvez vérifier manuellement.
                </p>
                <Button onClick={checkStatusManually} disabled={verifying} className="w-full">
                  {verifying ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}
                  Vérifier mon statut
                </Button>
                <Button variant="ghost" size="sm" onClick={reset} className="w-full">
                  Annuler et recommencer
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 6 — Success */}
      {step === "success" && creditedSummary && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center gap-4">
            <CheckCircle2 size={48} className="text-green-600" />
            <p className="font-bold text-lg">Dépôt confirmé !</p>
            <p className="text-sm text-muted-foreground">
              {creditedSummary.amount.toLocaleString()} FCFA crédités
              {creditedSummary.bonus > 0 ? ` + ${creditedSummary.bonus.toLocaleString()} FCFA de bonus` : ""}.
            </p>
            <div className="flex gap-2 w-full max-w-xs">
              <Button onClick={() => navigate("/dashboard")} className="flex-1">Tableau de bord</Button>
              <Button variant="outline" onClick={reset} className="flex-1">Nouveau dépôt</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 6 — Failed */}
      {step === "failed" && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center gap-4">
            <XCircle size={48} className="text-destructive" />
            <p className="font-bold text-lg">Paiement échoué</p>
            <p className="text-sm text-muted-foreground">{failedReason || "La transaction n'a pas pu être complétée."}</p>
            <Button onClick={reset} className="w-full max-w-xs">Réessayer</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
