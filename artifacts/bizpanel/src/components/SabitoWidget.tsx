import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { syncSabitoWidget, disableSabitoWidget } from "@/lib/sabito-widget";
import { useSabitoSettings } from "@/hooks/useSabitoSettings";

/** The chat UI is supplied entirely by Sabito's official loader. */
export function SabitoWidget() {
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  const settings = useSabitoSettings();
  const enabled = settings.data?.enabled === true && !settings.isError;

  useEffect(() => {
    if (!enabled) disableSabitoWidget();
    else if (!loading) syncSabitoWidget(userId);
  }, [enabled, loading, userId]);

  return null;
}
