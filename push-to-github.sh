#!/bin/bash
# ============================================================
# Push vers GitHub — BUZZ BOOSTER
# Exécutez ce script depuis l'onglet Shell de Replit :
#   bash push-to-github.sh "votre message de commit"
# ============================================================

set -e

MSG="${1:-"chore: mise à jour"}"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "❌ Secret GITHUB_PERSONAL_ACCESS_TOKEN manquant."
  echo "   Vérifiez l'onglet Secrets dans Replit."
  exit 1
fi

REPO_URL="https://x-token:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/BizAcademy/Connect-Git.git"

# Configurer l'identité git (nécessaire pour git commit)
git config user.email "replit@buzzbooster.app"
git config user.name "BizAcademy"

# S'assurer que le remote origin pointe vers GitHub
git remote set-url origin "$REPO_URL" 2>/dev/null \
  || git remote add origin "$REPO_URL"

BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
echo "📌 Branche locale : $BRANCH"

# Ajouter tous les fichiers modifiés
git add -A

# Vérifier s'il y a des changements à commiter
if git diff --cached --quiet; then
  echo "ℹ️  Aucun changement à commiter."
else
  git commit -m "$MSG"
  echo "✅ Commit : $MSG"
fi

# Push en forçant la branche distante à suivre la locale
echo "🚀 Push vers GitHub (branche main)..."
git push origin "$BRANCH:main"

echo "✅ Push réussi → https://github.com/BizAcademy/Connect-Git"
