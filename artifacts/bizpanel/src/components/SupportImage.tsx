import { useEffect, useState } from "react";
import { fetchSupportImageUrl } from "@/lib/support";
import { Loader2, ImageOff } from "lucide-react";

export const SupportImage = ({ filename }: { filename: string }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Ne pas révoquer la blob URL — elle est mise en cache dans lib/support.ts
    // pour survivre aux remontages de composants (navigation aller-retour).
    fetchSupportImageUrl(filename)
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [filename]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-32 bg-muted rounded text-muted-foreground text-xs gap-1">
        <ImageOff size={14} /> Image expirée
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex items-center justify-center h-32 bg-muted/40 rounded">
        <Loader2 className="animate-spin opacity-50" size={20} />
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
      <img src={url} alt="" className="rounded max-h-72 w-auto object-contain" />
    </a>
  );
};
