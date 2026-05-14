import logoImg from "@/assets/logo-buzzbooster.png";

interface LogoLoaderProps {
  fullPage?: boolean;
  size?: number;
}

/**
 * Loader branded BUZZ BOOSTER :
 * - Logo centré avec une légère animation de respiration
 * - Anneau rotatif en couleur primaire autour du logo
 * - Variante fullPage (min-h-screen) ou section (py-12)
 */
export function LogoLoader({ fullPage = false, size = 64 }: LogoLoaderProps) {
  const ring = size + 24;

  const inner = (
    <div className="flex flex-col items-center justify-center gap-5">
      <div className="relative flex items-center justify-center" style={{ width: ring, height: ring }}>
        {/* Piste fixe (fond de l'anneau) */}
        <div
          className="absolute rounded-full border-4 border-primary/15"
          style={{ width: ring, height: ring }}
        />
        {/* Anneau rotatif */}
        <div
          className="absolute rounded-full border-4 border-transparent border-t-primary animate-spin"
          style={{ width: ring, height: ring, animationDuration: "0.9s" }}
        />
        {/* Logo avec animation de respiration */}
        <img
          src={logoImg}
          alt="BUZZ BOOSTER"
          draggable={false}
          style={{
            width: size,
            height: size,
            objectFit: "contain",
            animation: "bb-breathe 1.8s ease-in-out infinite",
          }}
        />
      </div>

      <style>{`
        @keyframes bb-breathe {
          0%, 100% { transform: scale(1);   opacity: 1;    }
          50%       { transform: scale(1.07); opacity: 0.85; }
        }
      `}</style>
    </div>
  );

  if (fullPage) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        {inner}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-12">
      {inner}
    </div>
  );
}
