import { useState } from "react";
import { Globe, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { authedFetch } from "@/lib/authFetch";
import { SIGNUP_COUNTRIES } from "@/lib/currency";

interface CountrySelectModalProps {
  onSelected: (country: string, currency: string) => void;
}

export function CountrySelectModal({ onSelected }: CountrySelectModalProps) {
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await authedFetch("/api/profile/country", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: selected }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Erreur ${res.status}`);
      }
      const data = await res.json();
      toast.success("Pays mis à jour !");
      onSelected(data.country, data.currency);
    } catch (err) {
      toast.error((err as Error).message || "Impossible de sauvegarder le pays");
    } finally {
      setSaving(false);
    }
  };

  const info = SIGNUP_COUNTRIES.find((c) => c.code === selected);

  return (
    /* Backdrop non-fermable */
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center">
            <Globe size={28} className="text-orange-500" />
          </div>
        </div>

        <h2 className="text-lg font-bold text-gray-900 text-center mb-1">
          Choisissez votre pays
        </h2>
        <p className="text-sm text-gray-500 text-center mb-5 leading-snug">
          Pour afficher votre solde dans la bonne devise et convertir vos dépôts correctement.
        </p>

        {/* Select pays */}
        <div className="relative mb-4">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full appearance-none px-4 py-3 pr-10 rounded-xl border border-gray-300 bg-white text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-400 cursor-pointer"
          >
            <option value="">— Sélectionner un pays —</option>
            {SIGNUP_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.currency})
              </option>
            ))}
          </select>
          <ChevronDown
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          />
        </div>

        {/* Aperçu devise */}
        {info && (
          <div className="mb-4 bg-orange-50 border border-orange-200 rounded-lg px-4 py-2 text-sm text-orange-800 text-center">
            Devise : <span className="font-bold">{info.currency}</span>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={!selected || saving}
          className="w-full py-3 rounded-xl bg-gray-900 text-white font-semibold text-sm hover:bg-gray-800 transition disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving && <Loader2 size={15} className="animate-spin" />}
          Confirmer mon pays
        </button>

        <p className="mt-3 text-[11px] text-gray-400 text-center">
          Ce choix peut être modifié ultérieurement depuis votre profil.
        </p>
      </div>
    </div>
  );
}
