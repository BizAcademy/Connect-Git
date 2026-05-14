import { useRef, useState } from "react";
import { Camera, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { authedFetch } from "@/lib/authFetch";

interface AvatarUploadProps {
  avatarUrl?: string | null;
  username?: string | null;
  email?: string | null;
  size?: number;
  onUpdated: (newUrl: string | null) => void;
}

/** Redimensionne et compresse l'image côté client avant upload */
async function resizeImage(file: File, maxDim = 256, quality = 0.88): Promise<string> {
  if (file.size > 10 * 1024 * 1024) throw new Error("Image trop volumineuse (max 10 MB)");
  const bmp = await createImageBitmap(file);
  const ratio = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * ratio);
  const h = Math.round(bmp.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const isPng = file.type === "image/png";
  return canvas.toDataURL(isPng ? "image/png" : "image/jpeg", isPng ? undefined : quality);
}

function initials(username?: string | null, email?: string | null): string {
  const src = username || email || "?";
  return src.slice(0, 2).toUpperCase();
}

export function AvatarUpload({ avatarUrl, username, email, size = 40, onUpdated }: AvatarUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploading(true);
    try {
      const dataUrl = await resizeImage(file);
      const res = await authedFetch("/api/profile/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Erreur ${res.status}`);
      }
      const { avatar_url } = await res.json();
      onUpdated(avatar_url);
      toast.success("Photo de profil mise à jour !");
    } catch (err) {
      toast.error((err as Error).message || "Échec de l'upload");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!avatarUrl) return;
    setUploading(true);
    try {
      const res = await authedFetch("/api/profile/avatar", { method: "DELETE" });
      if (!res.ok) throw new Error("Impossible de supprimer");
      onUpdated(null);
      toast.success("Photo supprimée");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="relative flex-shrink-0 cursor-pointer"
      style={{ width: size, height: size }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => !uploading && inputRef.current?.click()}
      title="Changer la photo de profil"
    >
      {/* Avatar ou initiales */}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt="Avatar"
          className="w-full h-full rounded-full object-cover border-2 border-primary/30"
          style={{ width: size, height: size }}
        />
      ) : (
        <div
          className="w-full h-full rounded-full bg-primary/15 border-2 border-primary/30 flex items-center justify-center text-primary font-bold select-none"
          style={{ fontSize: size * 0.35 }}
        >
          {initials(username, email)}
        </div>
      )}

      {/* Overlay au survol */}
      {(hovered || uploading) && (
        <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
          {uploading ? (
            <Loader2 size={size * 0.4} className="text-white animate-spin" />
          ) : (
            <Camera size={size * 0.4} className="text-white" />
          )}
        </div>
      )}

      {/* Bouton supprimer (visible au survol si avatar présent) */}
      {hovered && !uploading && avatarUrl && (
        <button
          onClick={handleDelete}
          className="absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full p-0.5 shadow transition-colors"
          style={{ width: size * 0.38, height: size * 0.38 }}
          title="Supprimer la photo"
        >
          <Trash2 size={size * 0.22} className="m-auto" />
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  );
}
