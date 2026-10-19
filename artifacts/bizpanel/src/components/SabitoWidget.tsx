import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { syncSabitoWidget } from "@/lib/sabito-widget";

/** The chat UI is supplied entirely by Sabito's official loader. */
export function SabitoWidget() {
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!loading) syncSabitoWidget(userId);
  }, [loading, userId]);

  return null;
}
