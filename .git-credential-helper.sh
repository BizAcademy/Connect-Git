#!/bin/sh
# Git credential helper — lit le token depuis les secrets Replit
# Ne jamais commiter ce fichier tel quel, le token est lu depuis l'env
echo "username=x-token"
echo "password=${GITHUB_PERSONAL_ACCESS_TOKEN}"
