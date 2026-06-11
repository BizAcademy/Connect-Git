#!/bin/bash
# ============================================================
# Build + Push vers GitHub — BUZZ BOOSTER
# Une seule commande depuis l'onglet Shell de Replit :
#   bash push-to-github.sh "description des changements"
#
# Ce script fait automatiquement :
#   1. Build de production (frontend + API)
#   2. Commit + Push vers GitHub (avec dist-deploy/ inclus)
#
# Ensuite dans Plesk : Pull → Deploy Now → Restart
# ============================================================

set -e

MSG="${1:-"chore: mise à jour"}"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "❌ Secret GITHUB_PERSONAL_ACCESS_TOKEN manquant."
  echo "   Vérifiez l'onglet Secrets dans Replit."
  exit 1
fi

echo ""
echo "============================================================"
echo "🔨 Étape 1/2 : Build de production pour Plesk..."
echo "============================================================"
bash build-for-plesk.sh

echo ""
echo "============================================================"
echo "🚀 Étape 2/2 : Push vers GitHub..."
echo "============================================================"

REPO_URL="https://x-token:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/BizAcademy/Connect-Git.git"

git config user.email "replit@buzzbooster.app"
git config user.name "BizAcademy"

git remote set-url origin "$REPO_URL" 2>/dev/null \
  || git remote add origin "$REPO_URL"

BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")

git add -A

if git diff --cached --quiet; then
  echo "ℹ️  Aucun changement à commiter."
else
  git commit -m "$MSG"
  echo "✅ Commit : $MSG"
fi

echo "🚀 Push vers GitHub (branche main)..."
git push --force-with-lease origin "$BRANCH:main" \
  || git push --force origin "$BRANCH:main"

echo ""
echo "============================================================"
echo "✅ Terminé ! Prochaines étapes dans Plesk :"
echo "   1. Git → Pull"
echo "   2. Deploy Now"
echo "   3. Restart"
echo "   → L'application est en ligne avec les nouvelles modifications"
echo "============================================================"
