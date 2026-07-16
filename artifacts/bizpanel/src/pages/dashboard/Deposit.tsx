import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { getAuthHeaders, authedFetch } from "@/lib/authFetch";
import { formatBalance, getCurrencyInfo, toFcfa } from "@/lib/currency";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Wallet, Smartphone, Shield, Zap, Gift, ArrowLeft, Loader2,
  CheckCircle2, XCircle, ExternalLink, Info,
} from "lucide-react";

const AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];
const BONUS_THRESHOLD = 5000;
const BONUS_AMOUNT = 200;
const POLL_INTERVAL_MS = 15_000;
const POLL_DURATION_MS = 300_000;
const PROCESSING_FEE_RATE = 0.02; // 2% fee charged on top of the deposit amount

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

// ---------------------------------------------------------------------------
// Helpers — flags, logos, USSD codes, Wave detection
// ---------------------------------------------------------------------------

/** ISO 3166-1 alpha-2 → flag emoji */
function getFlagEmoji(code: string): string {
  const upper = code.toUpperCase().slice(0, 2);
  if (upper.length < 2) return "🌍";
  const [a, b] = upper.split("");
  return String.fromCodePoint(
    (a?.charCodeAt(0) ?? 65) + 127397,
    (b?.charCodeAt(0) ?? 65) + 127397,
  );
}

/** Detect Wave operator by code (wave-sn, wave-ci, wave_sn, …) */
function isWaveOperator(code: string): boolean {
  return /wave/i.test(code);
}

/** Detect operator brand from code */
type OperatorBrand = "mtn" | "orange" | "wave" | "moov" | "airtel" | "free" | "tmoney" | "other";
function getOperatorBrand(code: string): OperatorBrand {
  const c = code.toLowerCase();
  if (c.includes("mtn")) return "mtn";
  if (c.includes("orange")) return "orange";
  if (c.includes("wave")) return "wave";
  if (c.includes("moov")) return "moov";
  if (c.includes("airtel")) return "airtel";
  if (c.includes("free")) return "free";
  if (c.includes("tmoney") || c.includes("t-money")) return "tmoney";
  return "other";
}

const BRAND_STYLES: Record<OperatorBrand, { bg: string; text: string; label: string }> = {
  mtn:    { bg: "#FFCB00", text: "#000",    label: "MTN" },
  orange: { bg: "#FF6600", text: "#fff",    label: "Orange" },
  wave:   { bg: "#1DC8D0", text: "#fff",    label: "Wave" },
  moov:   { bg: "#0066CC", text: "#fff",    label: "Moov" },
  airtel: { bg: "#E4002B", text: "#fff",    label: "Airtel" },
  free:   { bg: "#0033AA", text: "#fff",    label: "Free" },
  tmoney: { bg: "#7B1FA2", text: "#fff",    label: "T-Money" },
  other:  { bg: "#475569", text: "#fff",    label: "" },
};

/** Operator logo card — shows custom image if available, else brand fallback */
function OperatorLogo({
  code, name, size = 56, logoUrl,
}: { code: string; name: string; size?: number; logoUrl?: string | null }) {
  const brand = getOperatorBrand(code);
  const { bg, text, label } = BRAND_STYLES[brand];
  const display = label || name.split(" ")[0] || code;
  const radius = Math.round(size * 0.2);

  // Custom logo image set by admin
  if (logoUrl) {
    return (
      <div
        style={{ width: size, height: size, borderRadius: radius, background: "#f1f5f9", overflow: "hidden" }}
        className="flex items-center justify-center shrink-0 border border-border"
      >
        <img
          src={logoUrl}
          alt={name}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
          onError={(e) => {
            // If image fails to load, hide it — parent will show fallback via CSS
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
    );
  }

  // Wave fallback
  if (brand === "wave") {
    return (
      <div
        style={{ width: size, height: size, background: bg, borderRadius: radius }}
        className="flex flex-col items-center justify-center shrink-0"
      >
        <svg width={size * 0.6} height={size * 0.35} viewBox="0 0 36 14" fill="none">
          <path d="M2 12 Q9 2 18 7 Q27 12 34 2" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none"/>
        </svg>
        <span style={{ color: text, fontSize: size * 0.18, fontWeight: 800, lineHeight: 1, marginTop: 2 }}>
          wave
        </span>
      </div>
    );
  }

  // MTN fallback
  if (brand === "mtn") {
    return (
      <div
        style={{ width: size, height: size, background: bg, borderRadius: radius }}
        className="flex flex-col items-center justify-center shrink-0 gap-0.5"
      >
        <span style={{ color: "#000", fontSize: size * 0.26, fontWeight: 900, lineHeight: 1 }}>MTN</span>
        <div style={{ width: "70%", height: 3, background: "#000", borderRadius: 2 }} />
      </div>
    );
  }

  // Generic fallback
  return (
    <div
      style={{ width: size, height: size, background: bg, borderRadius: radius }}
      className="flex items-center justify-center shrink-0"
    >
      <span
        style={{
          color: text,
          fontSize: display.length <= 4 ? size * 0.26 : size * 0.19,
          fontWeight: 800,
          letterSpacing: "-0.5px",
          textAlign: "center",
          lineHeight: 1.1,
          padding: "0 4px",
        }}
      >
        {display}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// USSD codes — operator-country map (based on AfribaPay documentation)
// Format: MONTANT is replaced at runtime by the actual amount
// ---------------------------------------------------------------------------
const USSD_MAP: Record<string, Partial<Record<OperatorBrand, string>>> = {
  CI: { orange: "*144*4*6*MONTANT#", moov: "#155#", mtn: "*133*1*1*MONTANT#" },
  SN: { orange: "#144*391*MONTANT#", free: "*555*MONTANT#" },
  CM: { orange: "#150*1*1*MONTANT#", mtn: "*126#" },
  BF: { orange: "*144*4*6*MONTANT#", moov: "*555*1*1*MONTANT#" },
  ML: { orange: "*144*4*6*MONTANT#", moov: "#145#" },
  TG: { moov: "*155#", tmoney: "*145*MONTANT#" },
  BJ: { mtn: "*880*MONTANT#", moov: "#122#" },
  NE: { airtel: "*904#", moov: "*555#", orange: "*144*4*6*MONTANT#" },
  GH: { mtn: "*170#" },
  MR: { other: "*444*MONTANT#" },
  GW: { orange: "*144*4*6*MONTANT#" },
  GM: { other: "*222#" },
  CF: { orange: "#150*1*1*MONTANT#" },
  CG: { mtn: "*126#", airtel: "*555*MONTANT#" },
  GA: { airtel: "*150*MONTANT#" },
  TD: { airtel: "*150*MONTANT#", moov: "*555*1*1*MONTANT#" },
};

function getUssdCode(countryCode: string, operatorCode: string, amount: number): string | null {
  const brand = getOperatorBrand(operatorCode);
  const countryMap = USSD_MAP[countryCode.toUpperCase()];
  if (!countryMap) return null;
  const template = countryMap[brand] ?? countryMap["other" as OperatorBrand];
  if (!template) return null;
  return template.replace("MONTANT", String(amount));
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Deposit() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [countries, setCountries] = useState<Country[]>([]);
  const [loadingCountries, setLoadingCountries] = useState(true);
  const [countriesError, setCountriesError] = useState<string | null>(null);

  // Operator logos fetched from admin-configured settings
  const [operatorLogos, setOperatorLogos] = useState<Record<string, string>>({});
  useEffect(() => {
    fetch("/api/payments/operator-logos", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d?.logos) setOperatorLogos(d.logos as Record<string, string>); })
      .catch(() => {/* non-blocking */});
  }, []);

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
  const finalAmountFcfa = toFcfa(finalAmount, profile?.country);
  const isEligible = Number.isFinite(finalAmountFcfa) && finalAmountFcfa >= BONUS_THRESHOLD;
  const bonus = isEligible ? BONUS_AMOUNT : 0;
  const { symbol: currSymbol, fcfaPerUnit } = getCurrencyInfo(profile?.country);
  const thresholdLocal = fcfaPerUnit === 1 ? BONUS_THRESHOLD : Math.ceil(BONUS_THRESHOLD / fcfaPerUnit);

  // 2% processing fee — added ON TOP of the amount the user wants credited
  const feeAmount = finalAmount > 0 ? Math.ceil(finalAmount * PROCESSING_FEE_RATE) : 0;
  const chargeAmount = finalAmount + feeAmount;

  const [submitting, setSubmitting] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [waitMessage, setWaitMessage] = useState<string>("");
  const [waveRedirectUrl, setWaveRedirectUrl] = useState<string | null>(null);
  const [pollingExpired, setPollingExpired] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [failedReason, setFailedReason] = useState<string>("");
  const [creditedSummary, setCreditedSummary] = useState<{ amount: number; bonus: number } | null>(null);

  const pollTimerRef = useRef<number | null>(null);
  const pollStartRef = useRef<number>(0);

  // --- Load countries -------------------------------------------------------
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

  // --- Polling --------------------------------------------------------------
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
              ? `Dépôt de ${formatBalance(credited, profile?.country)} confirmé (+${formatBalance(bonusGot, profile?.country)} bonus) !`
              : `Dépôt de ${formatBalance(credited, profile?.country)} confirmé !`,
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
            ? `Dépôt de ${formatBalance(credited, profile?.country)} confirmé (+${formatBalance(bonusGot, profile?.country)} bonus) !`
            : `Dépôt de ${formatBalance(credited, profile?.country)} confirmé !`,
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
      toast.success("Demande envoyée. Composez le code USSD pour recevoir votre OTP.");
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
      setWaveRedirectUrl(data.wave_redirect_url || null);
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
    setOrderId(null); setWaitMessage(""); setPollingExpired(false); setWaveRedirectUrl(null);
    setFailedReason(""); setCreditedSummary(null);
    void loadCountries(true);
  };

  // --- Stepper helpers ------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
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

      {/* Balance card */}
      <Card className="bg-blue-600 text-white border-blue-600">
        <CardContent className="p-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center">
            <Wallet size={22} />
          </div>
          <div>
            <p className="text-sm opacity-80">Solde actuel</p>
            <p className="text-3xl font-bold">{formatBalance(Number(profile?.balance || 0), profile?.country)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Bonus banner */}
      <div className="rounded-lg border-2 border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-amber-400 text-white flex items-center justify-center shrink-0">
          <Gift size={18} />
        </div>
        <div className="text-sm">
          <p className="font-bold text-amber-900 dark:text-amber-100">
            Bonus : +{BONUS_AMOUNT.toLocaleString()} {currSymbol} offerts dès {thresholdLocal.toLocaleString()} {currSymbol} déposés !
          </p>
          <p className="text-amber-800 dark:text-amber-200/90 mt-0.5">
            Crédité automatiquement avec votre dépôt confirmé.
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Étape {stepIndex[step]} / {totalSteps}</span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(stepIndex[step] / totalSteps) * 100}%` }}
          />
        </div>
      </div>

      {/* ── Step 1 — Country ── */}
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
                    className="flex items-center gap-3 text-left p-3 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 transition-all"
                  >
                    <span className="text-3xl leading-none select-none">{getFlagEmoji(c.code)}</span>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm leading-tight truncate">{c.name}</p>
                      <p className="text-xs text-muted-foreground">{c.prefix || c.code}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Step 2 — Operator ── */}
      {step === "operator" && country && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <span className="text-2xl">{getFlagEmoji(country.code)}</span>
              Moyen de paiement — {country.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {country.operators.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun opérateur disponible pour ce pays.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {country.operators.map((op) => (
                  <button
                    key={op.code}
                    onClick={() => { setOperator(op); setOtp(""); setOtpRequested(false); setStep("phone"); }}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 transition-all group"
                  >
                    <OperatorLogo code={op.code} name={op.name} size={56} logoUrl={operatorLogos[op.code]} />
                    <div className="text-center">
                      <p className="font-semibold text-sm leading-tight">{op.name}</p>
                      {op.otp_required && (
                        <span className="text-xs text-amber-600 font-medium">OTP requis</span>
                      )}
                      {isWaveOperator(op.code) && (
                        <span className="text-xs text-cyan-600 font-medium">Paiement app</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Step 3 — Phone ── */}
      {step === "phone" && country && operator && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-3">
              <OperatorLogo code={operator.code} name={operator.name} size={36} logoUrl={operatorLogos[operator.code]} />
              Numéro de téléphone
            </CardTitle>
          </CardHeader>
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
              Le numéro associé à votre compte Mobile Money chez {operator.name}.
            </p>
            {isWaveOperator(operator.code) && (
              <div className="rounded-lg bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 p-3 flex items-start gap-2 text-sm">
                <Info size={15} className="text-cyan-600 mt-0.5 shrink-0" />
                <p className="text-cyan-800 dark:text-cyan-200">
                  Vous serez redirigé vers l'application <strong>Wave</strong> pour confirmer le paiement.
                </p>
              </div>
            )}
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

      {/* ── Step 3bis — OTP ── */}
      {step === "otp" && country && operator && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-3">
              <OperatorLogo code={operator.code} name={operator.name} size={36} logoUrl={operatorLogos[operator.code]} />
              Code de vérification OTP
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Votre opérateur ({operator.name}) exige un code OTP pour sécuriser le paiement.
            </p>

            {/* USSD instruction block — shown before requesting OTP */}
            {(() => {
              const ussd = getUssdCode(country.code, operator.code, finalAmount || 0);
              return ussd ? (
                <div className="rounded-xl border-2 border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-amber-800 dark:text-amber-100 font-semibold text-sm">
                    <Smartphone size={16} />
                    Comment obtenir votre code OTP
                  </div>
                  <p className="text-sm text-amber-900 dark:text-amber-100">
                    Veuillez composer le code suivant sur votre téléphone :
                  </p>
                  <div className="rounded-lg bg-amber-200 dark:bg-amber-800 px-4 py-3 text-center">
                    <code className="text-lg font-mono font-bold tracking-widest text-amber-900 dark:text-amber-50">
                      {ussd}
                    </code>
                  </div>
                  <p className="text-xs text-amber-800 dark:text-amber-200 text-center">
                    Suivez les instructions pour recevoir votre code OTP par SMS.
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-muted bg-muted/40 p-4 flex items-start gap-2 text-sm text-muted-foreground">
                  <Info size={15} className="mt-0.5 shrink-0" />
                  <p>
                    Cliquez sur « Recevoir le code » ci-dessous — un SMS avec votre code OTP
                    vous sera envoyé par {operator.name}.
                  </p>
                </div>
              );
            })()}

            <Button variant="outline" onClick={requestOtp} disabled={otpLoading} className="w-full">
              {otpLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}
              {otpRequested ? "Renvoyer le code OTP" : "Recevoir le code OTP"}
            </Button>

            <div className="space-y-1.5">
              <Label htmlFor="otp">Code OTP reçu par SMS</Label>
              <Input
                id="otp"
                inputMode="numeric"
                placeholder="Ex : 123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              />
            </div>

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

      {/* ── Step 4 — Amount ── */}
      {step === "amount" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-3">
              {operator && <OperatorLogo code={operator.code} name={operator.name} size={30} logoUrl={operatorLogos[operator.code]} />}
              Montant à recharger
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {AMOUNTS.map(a => (
                <button
                  key={a}
                  onClick={() => { setAmount(a); setCustom(""); }}
                  className={`py-3 rounded-xl border-2 text-sm font-semibold transition-all ${
                    amount === a && !custom
                      ? "bg-primary text-primary-foreground border-primary shadow-md"
                      : "border-border hover:border-primary hover:bg-primary/5"
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
                <span className="font-bold text-amber-600">+{bonus.toLocaleString()} {currSymbol}</span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  dès {thresholdLocal.toLocaleString()} {currSymbol}
                </span>
              )}
            </div>
            <Button className="w-full" disabled={finalAmount < 500} onClick={() => setStep("confirm")}>
              Continuer
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Step 5 — Confirm ── */}
      {step === "confirm" && country && operator && (
        <Card>
          <CardHeader><CardTitle className="text-base">Récapitulatif</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            {/* Operator + Country summary */}
            <div className="flex items-center gap-4 p-4 rounded-xl bg-muted/40 border">
              <OperatorLogo code={operator.code} name={operator.name} size={52} logoUrl={operatorLogos[operator.code]} />
              <div>
                <p className="font-bold text-base">{operator.name}</p>
                <p className="text-muted-foreground flex items-center gap-1.5">
                  <span className="text-xl">{getFlagEmoji(country.code)}</span>
                  {country.name} · {phone}
                </p>
              </div>
            </div>

            <div className="space-y-2 divide-y">
              <div className="flex justify-between py-1.5">
                <span className="text-muted-foreground">Montant</span>
                <span className="font-bold">{chargeAmount.toLocaleString()} {currSymbol}</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-muted-foreground">Bonus crédité</span>
                <span className={isEligible ? "font-bold text-amber-600" : "text-xs text-muted-foreground"}>
                  {isEligible ? `+${bonus.toLocaleString()} ${currSymbol}` : `dès ${thresholdLocal.toLocaleString()} ${currSymbol}`}
                </span>
              </div>
            </div>

            {isWaveOperator(operator.code) && (
              <div className="rounded-lg bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 p-3 flex items-start gap-2 text-sm">
                <Info size={15} className="text-cyan-600 mt-0.5 shrink-0" />
                <p className="text-cyan-800 dark:text-cyan-200">
                  Après confirmation, vous serez redirigé vers l'application <strong>Wave</strong> pour valider le paiement.
                </p>
              </div>
            )}

            <Button className="w-full h-12" onClick={initiate} disabled={submitting}>
              {submitting
                ? <><Loader2 size={16} className="mr-2 animate-spin" /> Envoi en cours…</>
                : <><Smartphone size={16} className="mr-2" /> Payer {chargeAmount.toLocaleString()} {currSymbol}</>
              }
            </Button>
            <div className="flex items-center gap-4 justify-center text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Shield size={12} /> Sécurisé</span>
              <span className="flex items-center gap-1"><Zap size={12} /> Crédit instantané</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 6 — Wait ── */}
      {step === "wait" && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center gap-5">
            <Loader2 size={48} className="animate-spin text-primary" />
            <div className="space-y-1">
              <p className="font-semibold text-base">{waitMessage || "En attente de confirmation…"}</p>
              {operator && (
                <p className="text-sm text-muted-foreground">
                  Vérifiez votre téléphone {operator.name}.
                </p>
              )}
            </div>

            {/* Wave redirect button */}
            {waveRedirectUrl && (
              <div className="w-full max-w-xs space-y-2">
                <div className="rounded-xl bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-300 p-4 space-y-3">
                  <div className="flex justify-center">
                    <OperatorLogo code="wave" name="Wave" size={52} logoUrl={operator ? operatorLogos[operator.code] : undefined} />
                  </div>
                  <p className="text-sm text-cyan-800 dark:text-cyan-200 font-medium">
                    Ouvrez l'application Wave pour confirmer votre paiement.
                  </p>
                  <Button
                    className="w-full"
                    style={{ background: "#1DC8D0" }}
                    onClick={() => window.open(waveRedirectUrl, "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink size={16} className="mr-2" />
                    Ouvrir Wave
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Après validation dans Wave, le dépôt sera crédité automatiquement.
                </p>
              </div>
            )}

            {/* USSD reminder for OTP operators */}
            {!waveRedirectUrl && operator && country && (() => {
              const ussd = getUssdCode(country.code, operator.code, finalAmount);
              return ussd ? (
                <div className="w-full max-w-xs rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2 text-sm">
                  <p className="font-semibold text-amber-800 dark:text-amber-100 flex items-center gap-1.5">
                    <Smartphone size={14} /> Code USSD à composer
                  </p>
                  <div className="rounded-lg bg-amber-200 dark:bg-amber-800 px-3 py-2 text-center">
                    <code className="font-mono font-bold tracking-widest text-amber-900 dark:text-amber-50">
                      {ussd}
                    </code>
                  </div>
                  <p className="text-xs text-amber-700 dark:text-amber-300 text-center">
                    Ou validez la notification sur votre téléphone.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Validez la notification mobile money sur votre téléphone.
                </p>
              );
            })()}

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

      {/* ── Step 6 — Success ── */}
      {step === "success" && creditedSummary && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center gap-4">
            <CheckCircle2 size={52} className="text-green-600" />
            <div>
              <p className="font-bold text-lg">Dépôt confirmé !</p>
              <p className="text-sm text-muted-foreground mt-1">
                {creditedSummary.amount.toLocaleString()} FCFA crédités
                {creditedSummary.bonus > 0 ? ` + ${creditedSummary.bonus.toLocaleString()} FCFA de bonus` : ""}.
              </p>
            </div>
            <div className="flex gap-2 w-full max-w-xs">
              <Button onClick={() => navigate("/dashboard")} className="flex-1">Tableau de bord</Button>
              <Button variant="outline" onClick={reset} className="flex-1">Nouveau dépôt</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 6 — Failed ── */}
      {step === "failed" && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center gap-4">
            <XCircle size={52} className="text-destructive" />
            <div>
              <p className="font-bold text-lg">Paiement échoué</p>
              <p className="text-sm text-muted-foreground mt-1">
                {failedReason || "La transaction n'a pas pu être complétée."}
              </p>
            </div>
            <Button onClick={reset} className="w-full max-w-xs">Réessayer</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
