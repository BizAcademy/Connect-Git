import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Check, Eye, UserPlus, Wallet, TrendingUp, Gift, Share2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { authedFetch } from "@/lib/authFetch";
import { formatBalance } from "@/lib/currency";

interface ReferralData {
  code: string;
  referrer_pct: number;
  referred_pct: number;
  min_deposit_fcfa: number;
  stats: {
    visits: number;
    signups: number;
    paid_referrals: number;
    first_deposits_total_fcfa: number;
    earned_fcfa: number;
  };
}

const Affiliation = () => {
  const { profile } = useAuth();
  const [data, setData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authedFetch("/api/referrals/me");
      const body = await r.json().catch(() => null) as ReferralData | { error?: string } | null;
      if (!r.ok || !body || !("code" in body)) {
        setError((body && "error" in body && body.error) || "Impossible de charger vos informations d'affiliation");
        return;
      }
      setData(body);
    } catch {
      setError("Connexion impossible — réessayez");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const link = data ? `${window.location.origin}/auth?ref=${data.code}` : "";

  const copy = async (text: string, which: "link" | "code") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      toast.success(which === "link" ? "Lien copié !" : "Code copié !");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error("Copie impossible — sélectionnez et copiez manuellement");
    }
  };

  const country = profile?.country;

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-gray-200 rounded-lg animate-pulse" />
        <div className="h-28 bg-gray-200 rounded-2xl animate-pulse" />
        <div className="h-40 bg-gray-100 rounded-2xl animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
        <Gift size={32} className="mx-auto text-gray-300 mb-3" />
        <p className="text-sm text-gray-600 mb-4">{error || "Données indisponibles"}</p>
        <button
          onClick={load}
          className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 transition"
        >
          Réessayer
        </button>
      </div>
    );
  }

  const { stats } = data;

  return (
    <div className="space-y-5">
      {/* En-tête */}
      <div>
        <h1 className="text-2xl font-black text-gray-800">Affiliation</h1>
        <p className="text-sm text-gray-500">Invitez vos amis et gagnez de l'argent sur leur premier dépôt</p>
      </div>

      {/* Bandeau commission */}
      <div className="rounded-2xl bg-gradient-to-r from-orange-500 to-blue-600 text-white p-5 sm:p-6 shadow-lg">
        <div className="flex items-start gap-4">
          <div className="hidden sm:flex w-12 h-12 rounded-2xl bg-white/20 items-center justify-center flex-shrink-0">
            <Gift size={22} />
          </div>
          <div>
            <p className="text-lg sm:text-xl font-black leading-snug">
              Gagnez {data.referrer_pct}% du premier dépôt de chaque filleul
            </p>
            <p className="text-sm text-white/90 mt-1">
              Votre filleul reçoit aussi un bonus de {data.referred_pct}% •
              Dépôt minimum requis : <span className="font-bold">{formatBalance(data.min_deposit_fcfa, country)}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Lien + code */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        <div>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Votre lien de parrainage</p>
          <div className="flex gap-2">
            <input
              readOnly
              value={link}
              onFocus={e => e.target.select()}
              className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <button
              onClick={() => copy(link, "link")}
              className="px-3.5 py-2.5 rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition flex items-center gap-1.5 text-sm font-semibold flex-shrink-0"
            >
              {copied === "link" ? <Check size={15} /> : <Copy size={15} />}
              <span className="hidden sm:inline">Copier</span>
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
          <div className="flex items-center gap-3">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Votre code</p>
            <span className="font-mono text-lg font-black text-orange-600 bg-orange-50 border border-orange-200 rounded-lg px-3 py-1 tracking-widest">
              {data.code}
            </span>
            <button
              onClick={() => copy(data.code, "code")}
              className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition"
              aria-label="Copier le code"
            >
              {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          {typeof navigator.share === "function" && (
            <button
              onClick={() => navigator.share({ title: "BUZZ BOOSTER", text: `Inscris-toi sur BUZZ BOOSTER avec mon lien et reçois un bonus sur ton premier dépôt !`, url: link }).catch(() => {})}
              className="sm:ml-auto px-3.5 py-2 rounded-xl border border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 transition flex items-center justify-center gap-1.5 text-sm font-semibold"
            >
              <Share2 size={14} /> Partager
            </button>
          )}
        </div>
      </div>

      {/* Statistiques */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Visites du lien", value: String(stats.visits), icon: Eye, color: "text-blue-600", bg: "bg-blue-50" },
          { label: "Inscriptions", value: String(stats.signups), icon: UserPlus, color: "text-amber-600", bg: "bg-amber-50" },
          { label: "Premiers dépôts cumulés", value: formatBalance(stats.first_deposits_total_fcfa, country), icon: Wallet, color: "text-violet-600", bg: "bg-violet-50" },
          { label: "Total gagné", value: formatBalance(stats.earned_fcfa, country), icon: TrendingUp, color: "text-emerald-600", bg: "bg-emerald-50" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2">
            <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center`}>
              <Icon size={16} className={color} />
            </div>
            <p className="text-lg font-black text-gray-800 leading-tight break-words">{value}</p>
            <p className="text-[11px] text-gray-400 font-medium leading-tight">{label}</p>
          </div>
        ))}
      </div>

      {/* Comment ça marche */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <p className="text-sm font-bold text-gray-800 mb-3">Comment ça marche ?</p>
        <ol className="space-y-2.5">
          {[
            "Partagez votre lien (ou votre code) avec vos amis.",
            "Votre ami s'inscrit — le code parrain est appliqué automatiquement via le lien.",
            `Dès son premier dépôt d'au moins ${formatBalance(data.min_deposit_fcfa, country)}, vous recevez ${data.referrer_pct}% du montant et lui ${data.referred_pct}% — crédités directement sur vos soldes.`,
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm text-gray-600">
              <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-600 text-xs font-black flex items-center justify-center flex-shrink-0 mt-0.5">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};

export default Affiliation;
