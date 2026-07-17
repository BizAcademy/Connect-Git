-- Migration 018 : durcissement sécurité post-incident
-- ---------------------------------------------------------------------------
-- 1. Révocation des permissions UPDATE sur les colonnes sensibles de profiles
--    pour le rôle "authenticated" (utilisateurs connectés via JWT).
--    Même si la RLS autorise un UPDATE sur la ligne, PostgreSQL refusera
--    toute tentative de modifier balance ou is_active via le rôle authenticated.
--    Le trigger prevent_user_balance_change (migration précédente) reste comme
--    seconde ligne de défense, mais le REVOKE opère plus tôt.
--
-- 2. Table d'audit pour les changements de solde.
--    Chaque crédit/débit est enregistré automatiquement avec l'identité de
--    l'appelant, la valeur avant/après et l'heure exacte.
-- ---------------------------------------------------------------------------

-- ── 1. Révoquer UPDATE sur colonnes sensibles ─────────────────────────────
-- Le rôle service_role (utilisé par le serveur et les webhooks) n'est pas
-- affecté car il bypasse les object-level privileges.

REVOKE UPDATE (balance)   ON public.profiles FROM authenticated;
REVOKE UPDATE (is_active) ON public.profiles FROM authenticated;

-- Les colonnes que les utilisateurs peuvent encore modifier sur leur propre
-- profil (soumis aux RLS policies) : username, phone, whatsapp, country, etc.
-- Aucune action nécessaire — elles sont simplement laissées accessibles.

-- ── 2. Table d'audit des changements de solde ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.balance_audit_log (
  id           bigserial PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  balance_before numeric   NOT NULL,
  balance_after  numeric   NOT NULL,
  delta          numeric   GENERATED ALWAYS AS (balance_after - balance_before) STORED,
  changed_by_role text     NOT NULL DEFAULT current_setting('role', true),
  changed_by_jwt  text     DEFAULT current_setting('request.jwt.claim.sub', true),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Index pour chercher rapidement les changements d'un utilisateur ou trier
CREATE INDEX IF NOT EXISTS balance_audit_log_user_id_idx  ON public.balance_audit_log (user_id);
CREATE INDEX IF NOT EXISTS balance_audit_log_created_at_idx ON public.balance_audit_log (created_at DESC);

-- Seul le service_role (serveur) peut lire l'audit log
ALTER TABLE public.balance_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_read_audit_log" ON public.balance_audit_log
  FOR SELECT USING (auth.role() = 'service_role');

-- ── 3. Trigger d'audit automatique ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_balance_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    INSERT INTO public.balance_audit_log (user_id, balance_before, balance_after)
    VALUES (NEW.user_id, OLD.balance, NEW.balance);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_balance_changes ON public.profiles;
CREATE TRIGGER audit_balance_changes
  AFTER UPDATE OF balance ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.log_balance_change();
