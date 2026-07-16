#!/bin/bash
# ============================================================
# Script de préparation du déploiement — BUZZ BOOSTER
# Copie les builds dans dist-deploy/ prêt pour Plesk
# ============================================================

set -e

WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$WORKSPACE/dist-deploy"

echo "📦 Préparation du déploiement..."

# Frontend
echo "  → Copie du frontend..."
rm -rf "$DIST/frontend"
mkdir -p "$DIST/frontend"
cp -r "$WORKSPACE/artifacts/bizpanel/dist/public/." "$DIST/frontend/"

# API Server
echo "  → Copie de l'API server..."
rm -rf "$DIST/api-server"
mkdir -p "$DIST/api-server"
cp -r "$WORKSPACE/artifacts/api-server/dist/." "$DIST/api-server/"

echo "✅ dist-deploy/ prêt !"
echo ""
echo "👉 Prochaine étape : bash push-to-github.sh \"feat: description\""
