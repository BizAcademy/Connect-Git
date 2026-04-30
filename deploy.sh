#!/usr/bin/env bash
# ============================================================================
# BUZZ BOOST — Build script for production deployment (Cybrancy / VPS)
# ----------------------------------------------------------------------------
# Produit deux dossiers prêts à uploader sur le serveur :
#   1) dist-deploy/frontend/    -> contenu statique (HTML/CSS/JS) du panel
#   2) dist-deploy/api-server/  -> serveur Node.js (Express)
#
# Usage local (depuis Replit ou n'importe quelle machine) :
#   bash deploy.sh
#
# Pré-requis : pnpm, node >= 20
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$ROOT_DIR/dist-deploy"
FRONT_OUT="$OUT_DIR/frontend"
API_OUT="$OUT_DIR/api-server"

echo ""
echo "=========================================="
echo "  BUZZ BOOST — Build production"
echo "=========================================="
echo ""

# ---------------------------------------------------------------------------
# 1) Dépendances
# ---------------------------------------------------------------------------
echo "[1/5] Installation des dépendances pnpm..."
pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 2) Build du frontend (bizpanel)
# ---------------------------------------------------------------------------
echo ""
echo "[2/5] Build du frontend bizpanel..."
# PORT et BASE_PATH sont requis par vite.config.ts mais ne sont utilisés
# qu'au runtime du dev server : on leur donne une valeur factice pour le build.
PORT=8080 BASE_PATH=/ pnpm --filter @workspace/bizpanel run build

# ---------------------------------------------------------------------------
# 3) Build du serveur API
# ---------------------------------------------------------------------------
echo ""
echo "[3/5] Build du serveur API..."
pnpm --filter @workspace/api-server run build

# ---------------------------------------------------------------------------
# 4) Préparation du dossier de déploiement
# ---------------------------------------------------------------------------
echo ""
echo "[4/5] Préparation du dossier dist-deploy/..."
rm -rf "$OUT_DIR"
mkdir -p "$FRONT_OUT" "$API_OUT"

# Frontend statique
cp -r "$ROOT_DIR/artifacts/bizpanel/dist/public/." "$FRONT_OUT/"

# Serveur API : code compilé + package.json minimal pour installer les deps natives
cp -r "$ROOT_DIR/artifacts/api-server/dist/." "$API_OUT/"

# package.json MINIMAL pour Plesk — pas de dépendances runtime à installer
# (esbuild a déjà bundlé express/pino/cors/etc. dans index.mjs). Plesk peut
# donc démarrer l'app sans avoir besoin de faire `npm install` ni de build.
cat > "$API_OUT/package.json" <<'EOF'
{
  "name": "buzzboost-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.mjs",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node --enable-source-maps ./index.mjs"
  }
}
EOF

# Script de démarrage
cat > "$API_OUT/start.sh" <<'EOF'
#!/usr/bin/env bash
# Démarrage du serveur API en production
set -euo pipefail
cd "$(dirname "$0")"
export NODE_ENV=production
export PORT="${PORT:-8080}"
exec node --enable-source-maps ./index.mjs
EOF
chmod +x "$API_OUT/start.sh"

# Configuration PM2 (gestionnaire de process recommandé pour VPS)
cat > "$OUT_DIR/ecosystem.config.cjs" <<'EOF'
// PM2 ecosystem file — voir https://pm2.keymetrics.io/
module.exports = {
  apps: [
    {
      name: "buzzboost-api",
      script: "./api-server/index.mjs",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: 8080,
      },
      max_memory_restart: "512M",
      autorestart: true,
      watch: false,
    },
  ],
};
EOF

# Exemple de configuration Nginx
cat > "$OUT_DIR/nginx.example.conf" <<'EOF'
# /etc/nginx/sites-available/buzzboost
# Remplacez votre-domaine.com par votre nom de domaine.

server {
    listen 80;
    listen [::]:80;
    server_name votre-domaine.com www.votre-domaine.com;

    # Redirection HTTPS (après obtention du certificat Let's Encrypt)
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name votre-domaine.com www.votre-domaine.com;

    ssl_certificate     /etc/letsencrypt/live/votre-domaine.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/votre-domaine.com/privkey.pem;

    client_max_body_size 25M;

    # API Node.js
    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Frontend statique
    root /var/www/buzzboost/frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache long pour les assets fingerprintés
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

# Exemple .env serveur
cat > "$OUT_DIR/.env.example" <<'EOF'
# ============================================================================
# Variables d'environnement du serveur API — à placer dans api-server/.env
# ============================================================================

NODE_ENV=production
PORT=8080

# URL publique HTTPS de votre API (utilisée pour le webhook AfribaPay)
PUBLIC_API_URL=https://votre-domaine.com

# Supabase (base de données + auth)
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# Prestataire de paiement Mobile Money
AFRIBAPAY_API_USER=...
AFRIBAPAY_API_KEY=...
AFRIBAPAY_MERCHANT_KEY=...
AFRIBAPAY_API_BASE=https://api.afribapay.com

# Fournisseurs SMM (5 panneaux)
SMM_PANEL_API_URL=...
SMM_PANEL_API_KEY=...
SMM_PANEL_2_API_URL=...
SMM_PANEL_2_API_KEY=...
SMM_PANEL_3_API_URL=...
SMM_PANEL_3_API_KEY=...
SMM_PANEL_4_API_URL=...
SMM_PANEL_4_API_KEY=...
SMM_PANEL_5_API_URL=...
SMM_PANEL_5_API_KEY=...
EOF

# ---------------------------------------------------------------------------
# 5) Récapitulatif
# ---------------------------------------------------------------------------
echo ""
echo "[5/5] Build terminé."
echo ""
echo "=========================================="
echo "  Contenu de dist-deploy/"
echo "=========================================="
ls -la "$OUT_DIR"
echo ""
echo "  frontend/   $(du -sh "$FRONT_OUT" | cut -f1)  (à uploader dans /var/www/buzzboost/frontend)"
echo "  api-server/ $(du -sh "$API_OUT" | cut -f1)  (à uploader dans /var/www/buzzboost/api-server)"
echo ""
echo "Étapes suivantes :"
echo "  1) Transférez le dossier dist-deploy/ sur votre serveur Cybrancy"
echo "     scp -r dist-deploy/ user@votre-serveur:/var/www/buzzboost/"
echo "  2) Sur le serveur, installez les dépendances runtime de l'API :"
echo "     cd /var/www/buzzboost/api-server && npm install --omit=dev"
echo "  3) Créez le fichier api-server/.env (voir .env.example)"
echo "  4) Lancez avec PM2 : pm2 start ecosystem.config.cjs && pm2 save"
echo "  5) Configurez Nginx avec nginx.example.conf"
echo ""
