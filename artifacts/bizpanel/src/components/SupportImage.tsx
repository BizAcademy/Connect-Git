import { useEffect, useState } from "react";
import { fetchSupportImageUrl } from "@/lib/support";
import { Loader2, ImageOff } from "lucide-react";

export const SupportImage = ({ filename }: { filename: string }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchSupportImageUrl(filename)
      .then((u) => { if (!revoked) { objectUrl = u; setUrl(u); } })
      .catch(() => { if (!revoked) setError(true); });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
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
