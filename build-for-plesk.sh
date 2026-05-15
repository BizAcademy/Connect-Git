#!/bin/bash
# ============================================================
# Build de production pour Plesk — BUZZ BOOSTER
# À exécuter depuis l'onglet Shell de Replit avant chaque push :
#   bash build-for-plesk.sh
#   bash push-to-github.sh "description des changements"
#
# Structure produite dans dist-deploy/ (structure attendue par Plesk) :
#   dist-deploy/api-server/           ← serveur Node.js (Plesk Node.js app)
#   dist-deploy/api-server/public/    ← frontend statique (document root Plesk)
# ============================================================

set -e

echo ""
echo "🔨 [1/4] Build API Server..."
pnpm --filter @workspace/api-server run build
echo "✅ API Server buildé"

echo ""
echo "🔨 [2/4] Build Frontend (BizPanel)..."
NODE_ENV=production BASE_PATH=/ pnpm --filter @workspace/bizpanel run build
echo "✅ Frontend buildé"

echo ""
echo "📋 [3/4] Copie vers dist-deploy/ (structure Plesk)..."

# ── API Server ──────────────────────────────────────────────
mkdir -p dist-deploy/api-server
# Vide le contenu précédent sauf le dossier public/ (géré séparément)
find dist-deploy/api-server -maxdepth 1 -not -name 'api-server' -not -name 'public' -delete 2>/dev/null || true
cp -r artifacts/api-server/dist/. dist-deploy/api-server/
# Préserver le package.json et start.sh personnalisés (s'ils ne viennent pas du build)
cp dist-deploy/api-server/package.json dist-deploy/api-server/package.json 2>/dev/null || true
echo "   ✓ dist-deploy/api-server/ mis à jour ($(du -sh dist-deploy/api-server/index.mjs | cut -f1))"

# ── Frontend → public/ (document root Plesk) ────────────────
rm -rf dist-deploy/api-server/public
mkdir -p dist-deploy/api-server/public
cp -r artifacts/bizpanel/dist/public/. dist-deploy/api-server/public/
echo "   ✓ dist-deploy/api-server/public/ créé ($(du -sh dist-deploy/api-server/public | cut -f1))"

echo ""
echo "============================================================"
echo "✅ [4/4] Build terminé ! Structure Plesk prête :"
echo ""
echo "   dist-deploy/api-server/           → Node.js app (index.mjs)"
echo "   dist-deploy/api-server/public/    → Frontend statique"
echo ""
echo "Prochaine étape :"
echo '   bash push-to-github.sh "description des changements"'
echo "============================================================"
