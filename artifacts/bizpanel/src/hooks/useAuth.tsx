import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { authedFetch } from "@/lib/authFetch";

export interface AuthUser { id: string; email: string; }
export interface AuthSession { user: AuthUser; }

interface AuthContextType {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  profile: any | null;
  isAdmin: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Optimistically patch one or more profile fields without a server round-trip. */
  patchProfile: (patch: Record<string, unknown>) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  profile: null,
  isAdmin: false,
  signOut: async () => {},
  refreshProfile: async () => {},
  patchProfile: () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<any | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const fetchProfile = async () => {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) {
      setUser(null); setSession(null); setProfile(null); setIsAdmin(false);
      return;
    }
    const data = await res.json();
    const currentUser = data.user as AuthUser & { profile: unknown; isAdmin: boolean };
    setUser({ id: currentUser.id, email: currentUser.email });
    setSession({ user: { id: currentUser.id, email: currentUser.email } });
    setProfile(currentUser.profile);
    setIsAdmin(currentUser.isAdmin);
  };

  const refreshProfile = async () => {
    await fetchProfile();
  };

  const patchProfile = (patch: Record<string, unknown>) => {
    setProfile((prev: any) => (prev ? { ...prev, ...patch } : prev));
  };

  useEffect(() => {
    fetchProfile().finally(() => setLoading(false));
  }, []);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
    setSession(null);
    setProfile(null);
    setIsAdmin(false);
  };

  // Auto-déconnexion après 60 minutes d'inactivité
  useEffect(() => {
    if (!user) return;

    const INACTIVITY_MS = 60 * 60 * 1000; // 60 minutes
    let timer: ReturnType<typeof setTimeout>;

    const handleTimeout = async () => {
      try {
        await signOut();
      } finally {
        if (typeof window !== "undefined") {
          try {
            const { toast } = await import("@/lib/toast");
            toast.info("Vous avez été déconnecté pour inactivité (60 min).");
          } catch {}
          window.location.href = "/auth";
        }
      }
    };

    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(handleTimeout, INACTIVITY_MS);
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();

    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, session, loading, profile, isAdmin, signOut, refreshProfile, patchProfile }}>
      {children}
    </AuthContext.Provider>
  );
};
