#!/usr/bin/env bash
# Démarrage du serveur API en production
set -euo pipefail
cd "$(dirname "$0")"
export NODE_ENV=production
export PORT="${PORT:-8080}"
exec node --enable-source-maps ./index.mjs
