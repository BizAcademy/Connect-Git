#!/bin/bash
# ============================================================
# Script de push vers GitHub — BUZZ BOOSTER
# Utilisation : bash push-to-github.sh "Message de commit"
# ============================================================

set -e

MSG="${1:-"chore: mise à jour"}"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "❌ Erreur : secret GITHUB_PERSONAL_ACCESS_TOKEN manquant."
  exit 1
fi

REPO_URL="https://x-token:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/BizAcademy/Connect-Git.git"

cd "$(dirname "$0")"

BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
echo "📌 Branche : $BRANCH"

# Ajouter tous les changements
git add -A

# Vérifier s'il y a des changements à commiter
if git diff --cached --quiet; then
  echo "ℹ️  Aucun changement à commiter."
else
  # Utiliser les variables d'env pour éviter d'écrire dans .git/config
  GIT_AUTHOR_NAME="BizAcademy" \
  GIT_AUTHOR_EMAIL="replit@buzzbooster.app" \
  GIT_COMMITTER_NAME="BizAcademy" \
  GIT_COMMITTER_EMAIL="replit@buzzbooster.app" \
  git commit -m "$MSG"
  echo "✅ Commit créé : $MSG"
fi

# Push vers GitHub avec le token dans l'URL
echo "🚀 Push vers GitHub..."
git push "$REPO_URL" "$BRANCH:main"
echo "✅ Push réussi vers https://github.com/BizAcademy/Connect-Git.git"
