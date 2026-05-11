-- Migration 009: tickets table
-- Remplace le stockage local (fichiers JSONL) par une table Supabase persistante.
-- Les tickets sont les demandes d'annulation / remboursement / accélération
-- envoyées par les utilisateurs depuis la page "Annuler une commande".

CREATE TABLE IF NOT EXISTS tickets (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code           TEXT        NOT NULL UNIQUE,
  ts                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_external_id    TEXT,
  order_local_id       UUID,
  provider_id          INTEGER,
  service_name         TEXT,
  action_type          TEXT        NOT NULL CHECK (action_type IN ('cancel','refund','speed_up','other')),
  message              TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('open','in_progress','resolved','closed')),
  admin_response       TEXT,
  resolved_at          TIMESTAMPTZ,
  resolved_by          UUID,
  cancel_executed      BOOLEAN     NOT NULL DEFAULT FALSE,
  cancel_executed_at   TIMESTAMPTZ,
  refunded             BOOLEAN     NOT NULL DEFAULT FALSE,
  refunded_amount_fcfa INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour les requêtes admin (tickets ouverts en premier)
CREATE INDEX IF NOT EXISTS tickets_status_ts_idx   ON tickets (status, ts DESC);
CREATE INDEX IF NOT EXISTS tickets_user_id_ts_idx  ON tickets (user_id, ts DESC);

-- RLS : chaque utilisateur voit ses propres tickets
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

-- Lecture : utilisateur voit les siens, service_role voit tout
CREATE POLICY "tickets_select_own"
  ON tickets FOR SELECT
  USING (user_id = auth.uid());

-- Insertion : uniquement ses propres tickets
CREATE POLICY "tickets_insert_own"
  ON tickets FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Mise à jour : le service_role (API serveur) gère les mises à jour admin
-- Les utilisateurs n'ont pas le droit de modifier leurs tickets après envoi
-- (le service_role contourne le RLS)

-- Accorder les droits à anon/authenticated (le RLS filtre ce qu'ils voient)
GRANT SELECT, INSERT ON tickets TO anon, authenticated;
GRANT ALL ON tickets TO service_role;

-- Activer Supabase Realtime pour les notifications instantanées côté admin
ALTER TABLE tickets REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE tickets;
