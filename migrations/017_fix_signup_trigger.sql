-- Migration 017 : fiabilisation de l'inscription
-- ---------------------------------------------------------------------------
-- Corrige l'erreur intermittente "Database error saving new user" survenant
-- lors de l'inscription. Cette erreur est renvoyée par Supabase/GoTrue quand
-- le trigger AFTER INSERT sur auth.users (handle_new_user) lève une exception
-- pendant la création de la ligne profiles — par ex. une collision sur un
-- username déjà pris, une contrainte NOT NULL, ou tout autre incident DB.
--
-- Le nouveau trigger est :
--   1. IDEMPOTENT      — ne recrée pas le profil s'il existe déjà.
--   2. ANTI-COLLISION  — si le username est déjà utilisé, on ajoute un suffixe
--                        numérique (Eric → Eric1 → Eric2 …) plutôt que d'échouer.
--   3. À TOLÉRANCE DE PANNE — toute erreur sur la création du profil OU du rôle
--                        est capturée et journalisée (RAISE WARNING) SANS jamais
--                        faire échouer la création du compte auth.users.
--
-- Chaque étape (profil, rôle) vit dans son propre bloc EXCEPTION : un échec sur
-- l'attribution du rôle ne fait donc PAS perdre la création du profil.

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
BEGIN
  -- ── 1. Profil ───────────────────────────────────────────────────────────
  BEGIN
    -- Métadonnées passées par le client lors du signUp (peuvent être absentes)
    v_username := nullif(btrim(coalesce(new.raw_user_meta_data->>'username', '')), '');
    v_country  := upper(nullif(btrim(coalesce(new.raw_user_meta_data->>'country', '')), ''));

    -- Repli : si aucun username fourni, on dérive du début de l'email
    IF v_username IS NULL THEN
      v_username := split_part(coalesce(new.email, 'user'), '@', 1);
    END IF;

    -- Idempotence : ne rien faire si un profil existe déjà pour cet utilisateur
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = new.id) THEN
      v_base := v_username;
      v_try  := v_base;

      -- Tente l'INSERT et gère les collisions de manière ATOMIQUE :
      -- on capture unique_violation et on réessaie avec un suffixe. Si la
      -- collision vient du user_id (profil déjà créé en concurrence), on sort.
      LOOP
        BEGIN
          INSERT INTO public.profiles (user_id, username, email, country)
          VALUES (new.id, v_try, new.email, coalesce(v_country, ''));
          EXIT; -- succès
        EXCEPTION WHEN unique_violation THEN
          -- Le profil a-t-il été créé entre-temps (course) ? → terminé.
          IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = new.id) THEN
            EXIT;
          END IF;
          -- Sinon c'est le username qui est pris → on suffixe et on réessaie.
          v_n := v_n + 1;
          IF v_n > 50 THEN
            v_try := v_base || '_' || substr(new.id::text, 1, 8);
          ELSE
            v_try := v_base || v_n::text;
          END IF;
          IF v_n > 60 THEN
            -- garde-fou absolu pour ne jamais boucler indéfiniment
            EXIT;
          END IF;
        END;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: profile creation failed for % : %', new.id, sqlerrm;
  END;

  -- ── 2. Rôle par défaut ──────────────────────────────────────────────────
  -- (Optionnel : une absence de ligne user_roles équivaut déjà à un rôle
  --  « user ». On insère malgré tout pour rester explicite, sans jamais
  --  bloquer l'inscription si la table/enum diffère.)
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = new.id) THEN
      INSERT INTO public.user_roles (user_id, role) VALUES (new.id, 'user');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: role assignment failed for % : %', new.id, sqlerrm;
  END;

  RETURN new;
END;
$$;

-- (Ré)attache le trigger sur auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
