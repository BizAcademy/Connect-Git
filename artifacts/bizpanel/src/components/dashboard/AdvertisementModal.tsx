import { useEffect, useState } from "react";
import { X, Megaphone, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export type Advertisement = {
  active: boolean;
  title: string;
  segments: Array<{ text: string; color: string }>;
  image: string;
  contactLabel: string;
  contactUrl: string;
  updatedAt: string | null;
};

export function AdvertisementModal({ advertisement }: { advertisement: Advertisement }) {
  const [seconds, setSeconds] = useState(5);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, 5 - Math.floor((Date.now() - started) / 1000));
      setSeconds(remaining);
      if (remaining === 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [advertisement.updatedAt]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Annonce">
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-orange-100 bg-orange-50 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-500 text-white">
            <Megaphone size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">Annonce</p>
            {advertisement.title && <h2 className="truncate text-lg font-bold text-gray-900">{advertisement.title}</h2>}
          </div>
          <button
            type="button"
            disabled={seconds > 0}
            onClick={() => setOpen(false)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={seconds > 0 ? `Fermeture disponible dans ${seconds} secondes` : "Fermer l'annonce"}
          >
            {seconds > 0 ? <span className="text-xs font-bold">{seconds}s</span> : <X size={19} />}
          </button>
        </div>
        {advertisement.image && (
          <img src={advertisement.image} alt="" className="max-h-72 w-full object-cover" />
        )}
        <div className="space-y-5 p-5">
          {advertisement.segments.length > 0 && (
            <p className="whitespace-pre-wrap text-[15px] leading-7">
              {advertisement.segments.map((segment, index) => (
                <span key={index} style={{ color: segment.color }}>{segment.text}{index < advertisement.segments.length - 1 ? " " : ""}</span>
              ))}
            </p>
          )}
          {advertisement.contactLabel && advertisement.contactUrl && (
            <Button asChild className="w-full">
              <a href={advertisement.contactUrl} target={advertisement.contactUrl.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
                {advertisement.contactLabel}<ExternalLink size={14} className="ml-2" />
              </a>
            </Button>
          )}
          {seconds > 0 && <p className="text-center text-xs text-gray-400">Vous pourrez fermer cette annonce dans {seconds} seconde{seconds > 1 ? "s" : ""}.</p>}
        </div>
      </div>
    </div>
  );
}