-- Migration 019 : corrections des warnings Security Advisor Supabase
-- ---------------------------------------------------------------------------
-- Corrige les warnings signalés dans le Security Advisor :
--   1. "Function Search Path Mutable" → nos deux fonctions trigger manquaient
--      SET search_path = public (risque de search_path hijacking).
--   2. "Public Can Execute SECURITY DEFINER Function" → les fonctions trigger
--      (handle_new_user, prevent_user_balance_change, log_balance_change) ne
--      doivent jamais être appelées directement par un utilisateur ; seul le
--      mécanisme de trigger doit les invoquer.
--
-- Warnings ACCEPTABLES (non corrigés ici) :
--   - has_role() : utilisée légitimement par le frontend et l'API server via
--     le JWT de l'utilisateur connecté. Révoquer casserait la vérification du
--     rôle admin. Warning normal pour une fonction RPC publique.
--   - smm_refund_order() : déjà sécurisée (migration 005 → REVOKE ALL puis
--     GRANT service_role). Le Security Advisor peut afficher un faux positif
--     si la politique de grant précédente n'est pas encore visible.
--   - rls_auto_enable() : fonction interne Supabase, ne pas toucher.
--   - storage.avatars / storage.site-images : buckets publics intentionnels
--     (avatars profil et images du site). Warning acceptable.
-- ---------------------------------------------------------------------------

-- ── 1. Corriger search_path sur prevent_user_balance_change ───────────────
CREATE OR REPLACE FUNCTION public.prevent_user_balance_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Seul le service_role (serveur / webhooks) peut modifier le solde.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    RAISE EXCEPTION 'Balance modification not allowed — use the server API.';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2. Corriger search_path sur log_balance_change ────────────────────────
CREATE OR REPLACE FUNCTION public.log_balance_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    INSERT INTO public.balance_audit_log (user_id, balance_before, balance_after)
    VALUES (NEW.user_id, OLD.balance, NEW.balance);
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3. Révoquer l'exécution directe des fonctions trigger ─────────────────
-- Ces fonctions sont SECURITY DEFINER et ne doivent être invoquées que par
-- le moteur de trigger PostgreSQL, jamais directement via RPC ou SQL client.

REVOKE ALL ON FUNCTION public.prevent_user_balance_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_user_balance_change() FROM anon;
REVOKE ALL ON FUNCTION public.prevent_user_balance_change() FROM authenticated;

REVOKE ALL ON FUNCTION public.log_balance_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_balance_change() FROM anon;
REVOKE ALL ON FUNCTION public.log_balance_change() FROM authenticated;

-- handle_new_user est un trigger sur auth.users (crée le profil à l'inscription).
-- Aucun utilisateur ne doit pouvoir l'appeler directement.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM authenticated;

-- Répéter le grant service_role sur smm_refund_order pour être sûr
-- (le Security Advisor peut afficher un faux positif après une migration).
REVOKE ALL ON FUNCTION public.smm_refund_order(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.smm_refund_order(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.smm_refund_order(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.smm_refund_order(uuid, integer) TO service_role;
