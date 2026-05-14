import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextType {
  user: User | null;
  session: Session | null;
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
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<any | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const fetchProfile = async (userId: string) => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .single();
    setProfile(data);
    try {
      const { data: roleData } = await supabase.rpc("has_role" as any, { _user_id: userId, _role: "admin" });
      setIsAdmin(!!roleData);
    } catch {
      setIsAdmin(false);
    }
  };

  const refreshProfile = async () => {
    if (user) await fetchProfile(user.id);
  };

  const patchProfile = (patch: Record<string, unknown>) => {
    setProfile((prev: any) => (prev ? { ...prev, ...patch } : prev));
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          setTimeout(() => fetchProfile(session.user.id), 0);
        } else {
          setProfile(null);
          setIsAdmin(false);
        }
        setLoading(false);
      }
    );

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) fetchProfile(session.user.id);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setIsAdmin(false);
  };

  // Auto-déconnexion après 5 minutes d'inactivité
  useEffect(() => {
    if (!user) return;

    const INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes
    let timer: ReturnType<typeof setTimeout>;

    const handleTimeout = async () => {
      try {
        await signOut();
      } finally {
        if (typeof window !== "undefined") {
          try {
            const { toast } = await import("sonner");
            toast.info("Vous avez été déconnecté pour inactivité (5 min).");
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
