-- Migration 020 : système d'affiliation / parrainage
-- ---------------------------------------------------------------------------
-- À exécuter dans Supabase > SQL Editor. Idempotente (ré-exécutable sans danger).
-- Compatible avec le code serveur actuel ET précédent : peut être appliquée
-- AVANT le déploiement du nouveau code.
--
-- Contenu :
--   1. profiles.referral_code (unique) + profiles.referred_by
--   2. Générateur de codes + backfill pour tous les utilisateurs existants
--   3. Table referrals  (1 ligne par filleul, statut pending → processing → paid)
--   4. Table referral_visits (compteur de visites des liens de parrainage)
--   4b. Fonction award_referral_leg : crédit de bonus ATOMIQUE (transaction
--       unique = zéro perte, zéro double paiement, rejouable sans risque)
--   5. handle_new_user étendu : attribue un code au nouvel inscrit et lie le
--      parrain via les métadonnées d'inscription (raw_user_meta_data.referral_code)
--   6. Paramètres par défaut (5% parrain / 2% filleul / dépôt min 2000 FCFA)
--   7. Verrouillage sécurité (RLS + REVOKE : écriture via service_role uniquement)
--
-- Règle métier (bonus reporté) : le bonus s'applique au PREMIER dépôt complété
-- d'au moins `referral_min_deposit_fcfa` (2000 FCFA après conversion), même si
-- des dépôts plus petits l'ont précédé. Tant qu'aucun dépôt qualifié n'existe,
-- la ligne referrals reste en statut 'pending'.

-- ── 1. Colonnes sur profiles ────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referral_code text NULL,
  ADD COLUMN IF NOT EXISTS referred_by uuid NULL,
  ADD COLUMN IF NOT EXISTS affiliate_earnings numeric NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_referral_code_key
  ON public.profiles (referral_code);

CREATE INDEX IF NOT EXISTS profiles_referred_by_idx
  ON public.profiles (referred_by);

-- ── 2. Générateur de codes ──────────────────────────────────────────────────
-- Format : BB + 6 caractères sans ambiguïté (pas de 0/O/1/I) → ex. BBK7M2XQ
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result   text := 'BB';
  i        int;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(alphabet, 1 + floor(random() * 32)::int, 1);
  END LOOP;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_referral_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_referral_code() FROM anon, authenticated;

-- Backfill : un code pour chaque utilisateur existant qui n'en a pas.
DO $$
DECLARE
  r      record;
  v_code text;
  v_n    int;
BEGIN
  FOR r IN SELECT user_id FROM public.profiles WHERE referral_code IS NULL LOOP
    v_n := 0;
    LOOP
      v_code := public.generate_referral_code();
      BEGIN
        UPDATE public.profiles SET referral_code = v_code WHERE user_id = r.user_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_n := v_n + 1;
        IF v_n > 10 THEN
          RAISE WARNING 'referral backfill: could not assign code to %', r.user_id;
          EXIT;
        END IF;
      END;
    END LOOP;
  END LOOP;
END;
$$;

-- ── 3. Table referrals ──────────────────────────────────────────────────────
-- Statuts : pending    → en attente d'un premier dépôt qualifié
--           processing → dépôt qualifié réclamé, crédits en cours (montants figés)
--           paid       → les deux bonus ont été crédités
-- Les drapeaux *_credited_at tracent chaque crédit individuellement : en cas de
-- panne en plein milieu, la reprise automatique (scanner API) retente UNIQUEMENT
-- les crédits manquants — jamais de double paiement, jamais de perte silencieuse.
CREATE TABLE IF NOT EXISTS public.referrals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id      uuid NOT NULL,
  referred_user_id      uuid NOT NULL UNIQUE,   -- un seul parrain par filleul
  code_used             text NOT NULL,
  status                text NOT NULL DEFAULT 'pending',  -- pending | processing | paid
  qualifying_payment_id uuid NULL,
  qualifying_amount_fcfa integer NULL,
  referrer_bonus_fcfa   integer NULL,
  referred_bonus_fcfa   integer NULL,
  referrer_credited_at  timestamptz NULL,
  referred_credited_at  timestamptz NULL,
  paid_at               timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Idempotence si une version antérieure de la table existe déjà.
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referrer_credited_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS referred_credited_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON public.referrals (referrer_user_id);
CREATE INDEX IF NOT EXISTS referrals_status_idx   ON public.referrals (referred_user_id, status);

-- ── 4. Table referral_visits ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.referral_visits (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code        text NOT NULL,
  visitor_key text NULL,          -- identifiant anonyme du navigateur (dédoublonnage)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS referral_visits_code_idx ON public.referral_visits (code);
-- Un même navigateur ne compte qu'une visite par code.
CREATE UNIQUE INDEX IF NOT EXISTS referral_visits_dedupe_key
  ON public.referral_visits (code, visitor_key)
  WHERE visitor_key IS NOT NULL;

-- ── 4b. Crédit atomique d'une jambe de bonus ────────────────────────────────
-- Le serveur API appelle cette fonction (via /rest/v1/rpc, clé service_role
-- uniquement) pour payer UNE jambe (parrain ou filleul) d'un parrainage en
-- 'processing'. Tout se passe dans UNE transaction :
--   verrou ligne → vérif drapeau → crédit balance (+ affiliate_earnings pour
--   le parrain) → pose du drapeau → finalisation paid si les 2 jambes sont OK.
-- Garanties : le drapeau *_credited_at n'est posé QUE si le crédit est commité
-- (preuve de paiement, pas simple réclamation) ; rejouable à l'infini sans
-- double crédit ; une coupure en plein vol annule tout (la ligne reste
-- 'processing' et la reprise automatique rejoue l'appel).
CREATE OR REPLACE FUNCTION public.award_referral_leg(p_referral_id uuid, p_leg text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER          -- exécutée sous le rôle appelant = service_role
SET search_path = public
AS $$
DECLARE
  r       public.referrals%ROWTYPE;
  v_user  uuid;
  v_bonus integer;
  v_flag  timestamptz;
BEGIN
  IF p_leg NOT IN ('referrer', 'referred') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_leg');
  END IF;

  SELECT * INTO r FROM public.referrals WHERE id = p_referral_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF r.status <> 'processing' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_processing', 'status', r.status);
  END IF;

  IF p_leg = 'referrer' THEN
    v_flag := r.referrer_credited_at; v_user := r.referrer_user_id; v_bonus := coalesce(r.referrer_bonus_fcfa, 0);
  ELSE
    v_flag := r.referred_credited_at; v_user := r.referred_user_id; v_bonus := coalesce(r.referred_bonus_fcfa, 0);
  END IF;

  -- Jambe déjà payée : on tente juste la finalisation (auto-guérison).
  IF v_flag IS NOT NULL THEN
    UPDATE public.referrals SET status = 'paid', paid_at = now()
    WHERE id = p_referral_id AND status = 'processing'
      AND referrer_credited_at IS NOT NULL AND referred_credited_at IS NOT NULL;
    RETURN jsonb_build_object('ok', true, 'already', true, 'paid', FOUND);
  END IF;

  -- Crédit (0 = rien à payer, on pose seulement la preuve).
  IF v_bonus > 0 THEN
    UPDATE public.profiles
    SET balance = coalesce(balance, 0) + v_bonus,
        affiliate_earnings = CASE WHEN p_leg = 'referrer'
                                  THEN coalesce(affiliate_earnings, 0) + v_bonus
                                  ELSE affiliate_earnings END
    WHERE user_id = v_user;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'profile_not_found');
    END IF;
  END IF;

  -- Preuve de crédit (même transaction que le crédit lui-même).
  IF p_leg = 'referrer' THEN
    UPDATE public.referrals SET referrer_credited_at = now() WHERE id = p_referral_id;
  ELSE
    UPDATE public.referrals SET referred_credited_at = now() WHERE id = p_referral_id;
  END IF;

  -- Finalisation si les deux jambes sont payées.
  UPDATE public.referrals SET status = 'paid', paid_at = now()
  WHERE id = p_referral_id AND status = 'processing'
    AND referrer_credited_at IS NOT NULL AND referred_credited_at IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'credited', v_bonus, 'paid', FOUND);
END;
$$;

-- Seul le serveur API (clé service_role) peut exécuter cette fonction.
REVOKE ALL ON FUNCTION public.award_referral_leg(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.award_referral_leg(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_referral_leg(uuid, text) TO service_role;

-- ── 5. handle_new_user étendu ───────────────────────────────────────────────
-- Reprend intégralement la version de la migration 017 (idempotence, collision
-- de username, tolérance de panne) et ajoute :
--   (c) attribution d'un referral_code au nouveau profil
--   (d) liaison au parrain si un code valide est présent dans les métadonnées
-- Chaque ajout vit dans son propre bloc EXCEPTION : jamais d'échec d'inscription.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username text;
  v_country  text;
  v_base     text;
  v_try      text;
  v_n        int := 0;
  v_ref_code text;
  v_referrer uuid;
  v_code     text;
  v_cn       int := 0;
BEGIN
  -- ── 1. Profil ───────────────────────────────────────────────────────────
  BEGIN
    v_username := nullif(btrim(coalesce(new.raw_user_meta_data->>'username', '')), '');
    v_country  := upper(nullif(btrim(coalesce(new.raw_user_meta_data->>'country', '')), ''));

    IF v_username IS NULL THEN
      v_username := split_part(coalesce(new.email, 'user'), '@', 1);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = new.id) THEN
      v_base := v_username;
      v_try  := v_base;

      LOOP
        BEGIN
          INSERT INTO public.profiles (user_id, username, email, country)
          VALUES (new.id, v_try, new.email, coalesce(v_country, ''));
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = new.id) THEN
            EXIT;
          END IF;
          v_n := v_n + 1;
          IF v_n > 50 THEN
            v_try := v_base || '_' || substr(new.id::text, 1, 8);
          ELSE
            v_try := v_base || v_n::text;
          END IF;
          IF v_n > 60 THEN
            EXIT;
          END IF;
        END;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: profile creation failed for % : %', new.id, sqlerrm;
  END;

  -- ── 2. Rôle par défaut ──────────────────────────────────────────────────
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = new.id) THEN
      INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'user');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: role assignment failed for % : %', new.id, sqlerrm;
  END;

  -- ── 3. Code de parrainage du nouvel inscrit ─────────────────────────────
  BEGIN
    LOOP
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE user_id = new.id AND referral_code IS NULL
      );
      v_code := public.generate_referral_code();
      BEGIN
        UPDATE public.profiles
        SET referral_code = v_code
        WHERE user_id = new.id AND referral_code IS NULL;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_cn := v_cn + 1;
        IF v_cn > 10 THEN
          RAISE WARNING 'handle_new_user: referral_code assignment failed for %', new.id;
          EXIT;
        END IF;
      END;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: referral_code block failed for % : %', new.id, sqlerrm;
  END;

  -- ── 4. Liaison au parrain (code saisi/appliqué à l'inscription) ─────────
  BEGIN
    v_ref_code := upper(nullif(btrim(coalesce(new.raw_user_meta_data->>'referral_code', '')), ''));
    IF v_ref_code IS NOT NULL THEN
      SELECT user_id INTO v_referrer
      FROM public.profiles
      WHERE upper(referral_code) = v_ref_code
      LIMIT 1;

      -- Parrain valide et différent du nouvel inscrit uniquement
      IF v_referrer IS NOT NULL AND v_referrer <> new.id THEN
        UPDATE public.profiles
        SET referred_by = v_referrer
        WHERE user_id = new.id AND referred_by IS NULL;

        INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_used)
        VALUES (v_referrer, new.id, v_ref_code)
        ON CONFLICT (referred_user_id) DO NOTHING;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: referral link failed for % : %', new.id, sqlerrm;
  END;

  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- (Ré)attache le trigger sur auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 6. Paramètres par défaut (modifiables ensuite dans la table settings) ──
INSERT INTO public.settings (key, value) VALUES
  ('referral_referrer_pct', '5'),
  ('referral_referred_pct', '2'),
  ('referral_min_deposit_fcfa', '2000')
ON CONFLICT (key) DO NOTHING;

-- ── 7. Sécurité ─────────────────────────────────────────────────────────────
-- Les deux tables ne sont accessibles QUE via l'API serveur (service_role,
-- qui contourne la RLS). Aucune policy pour anon/authenticated = accès refusé.
ALTER TABLE public.referrals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_visits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.referrals       FROM anon, authenticated;
REVOKE ALL ON public.referral_visits FROM anon, authenticated;

-- Les utilisateurs ne peuvent pas modifier leur code ni leur parrain via
-- PostgREST (même principe que le verrou sur balance de la migration 018).
REVOKE UPDATE (referral_code) ON public.profiles FROM authenticated;
REVOKE UPDATE (referred_by)   ON public.profiles FROM authenticated;

-- Vérification rapide (facultatif) :
--   SELECT count(*) FROM public.profiles WHERE referral_code IS NULL;   -- doit être 0
--   SELECT * FROM public.referrals LIMIT 5;
