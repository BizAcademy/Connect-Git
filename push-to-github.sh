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
GITHUB_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN:-${GITHUB_PAT:-}}"

if [ -z "$GITHUB_TOKEN" ] && ! git remote get-url origin >/dev/null 2>&1; then
  echo "❌ Aucun accès GitHub configuré : ni remote origin, ni secret GitHub."
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

git config user.email "replit@buzzbooster.app"
git config user.name "BizAcademy"

if [ -n "$GITHUB_TOKEN" ]; then
  REPO_URL="https://x-token:${GITHUB_TOKEN}@github.com/BizAcademy/Connect-Git.git"
  git remote set-url origin "$REPO_URL" 2>/dev/null \
    || git remote add origin "$REPO_URL"
fi

BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")

git add -A

if git diff --cached --quiet; then
  echo "ℹ️  Aucun changement à commiter."
else
  git commit -m "$MSG"
  echo "✅ Commit : $MSG"
fi

echo "🚀 Push vers GitHub (branche main, sans écraser les commits distants)..."
if ! git push origin "$BRANCH:main"; then
  echo ""
  echo "❌ Push refusé. Aucun push forcé ne sera tenté."
  echo "   Vérifiez l'accès GitHub et comparez la branche distante avant de réessayer."
  exit 1
fi

echo ""
echo "============================================================"
echo "✅ Terminé ! Prochaines étapes dans Plesk :"
echo "   1. Git → Pull"
echo "   2. Deploy Now"
echo "   3. Restart"
echo "   → Le push seul ne met pas encore l'application en ligne."
echo "   → Après ces étapes, vérifier les bundles et l'API avec DEPLOY-PLESK.md."
echo "============================================================"
