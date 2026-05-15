#!/bin/bash
# ============================================================
# Build de production pour Plesk — BUZZ BOOSTER
# À exécuter depuis l'onglet Shell de Replit avant chaque push :
#   bash build-for-plesk.sh
#   bash push-to-github.sh "description des changements"
# ============================================================

set -e

echo ""
echo "🔨 [1/2] Build API Server..."
pnpm --filter @workspace/api-server run build
echo "✅ API Server buildé → artifacts/api-server/dist/index.mjs"

echo ""
echo "🔨 [2/2] Build Frontend (BizPanel)..."
NODE_ENV=production BASE_PATH=/ pnpm --filter @workspace/bizpanel run build
echo "✅ Frontend buildé → artifacts/bizpanel/dist/public/"

echo ""
echo "============================================================"
echo "✅ Build terminé ! Les dist/ sont prêts à être commités."
echo ""
echo "Prochaine étape :"
echo '  bash push-to-github.sh "description des changements"'
echo "============================================================"
