import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { Copy, Check, Gift, Share2 } from "lucide-react";
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

const thClass = "px-4 py-3 text-left text-xs font-bold text-gray-500 whitespace-nowrap";
const tdClass = "px-4 py-4 text-sm text-gray-800 whitespace-nowrap";

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
        <div className="h-8 w-56 bg-gray-200 rounded-lg animate-pulse" />
        <div className="h-28 bg-gray-100 rounded-2xl animate-pulse" />
        <div className="h-28 bg-gray-100 rounded-2xl animate-pulse" />
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
  const conversion = stats.visits > 0 ? (stats.signups / stats.visits) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* En-tête */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-black text-gray-800">Affiliation</h1>
          <span className="bg-gradient-to-r from-orange-500 to-red-500 text-white text-[10px] font-black uppercase tracking-wider rounded-full px-2.5 py-1 animate-pulse shadow-sm">
            Nouveau
          </span>
        </div>
        <p className="text-sm text-gray-500 mt-0.5">
          Invitez vos amis et gagnez {data.referrer_pct}% de leur premier dépôt
        </p>
      </div>

      {/* Tableau 1 : lien, code, commission, dépôt minimum */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px]">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className={thClass}>Lien de parrainage</th>
                <th className={thClass}>Code</th>
                <th className={thClass}>Taux de commission</th>
                <th className={thClass}>Dépôt minimum</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={tdClass}>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-700 truncate max-w-[300px]" title={link}>{link}</span>
                    <button
                      onClick={() => copy(link, "link")}
                      className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition flex-shrink-0"
                      aria-label="Copier le lien"
                    >
                      {copied === "link" ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                    </button>
                  </div>
                </td>
                <td className={tdClass}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-black text-orange-600 tracking-widest">{data.code}</span>
                    <button
                      onClick={() => copy(data.code, "code")}
                      className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition flex-shrink-0"
                      aria-label="Copier le code"
                    >
                      {copied === "code" ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                    </button>
                  </div>
                </td>
                <td className={tdClass}>
                  <span className="font-black">{data.referrer_pct}%</span>{" "}
                  <span className="text-xs text-gray-400">(+{data.referred_pct}% pour le filleul)</span>
                </td>
                <td className={`${tdClass} font-bold`}>{formatBalance(data.min_deposit_fcfa, country)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {typeof navigator.share === "function" && (
          <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50/50 flex justify-end">
            <button
              onClick={() => navigator.share({
                title: "BUZZ BOOSTER",
                text: "Inscris-toi sur BUZZ BOOSTER avec mon lien et reçois un bonus sur ton premier dépôt !",
                url: link,
              }).catch(() => {})}
              className="px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 transition flex items-center gap-1.5 text-xs font-semibold"
            >
              <Share2 size={13} /> Partager
            </button>
          </div>
        )}
      </div>

      {/* Tableau 2 : statistiques */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className={thClass}>Visites</th>
                <th className={thClass}>Inscriptions</th>
                <th className={thClass}>Filleuls ayant déposé</th>
                <th className={thClass}>Taux de conversion</th>
                <th className={thClass}>Premiers dépôts cumulés</th>
                <th className={thClass}>Total gagné</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={`${tdClass} font-bold`}>{stats.visits}</td>
                <td className={`${tdClass} font-bold`}>{stats.signups}</td>
                <td className={`${tdClass} font-bold`}>{stats.paid_referrals}</td>
                <td className={`${tdClass} font-bold`}>{conversion.toFixed(2)}%</td>
                <td className={`${tdClass} font-bold`}>{formatBalance(stats.first_deposits_total_fcfa, country)}</td>
                <td className={`${tdClass} font-black text-emerald-600`}>{formatBalance(stats.earned_fcfa, country)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Note explicative */}
      <p className="text-xs text-gray-400 leading-relaxed">
        Dès qu'un filleul effectue un premier dépôt d'au moins {formatBalance(data.min_deposit_fcfa, country)},
        vous recevez {data.referrer_pct}% du montant et lui {data.referred_pct}% — crédités automatiquement
        sur vos soldes.
      </p>
    </div>
  );
};

export default Affiliation;
