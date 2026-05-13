#!/bin/bash
# Point d'entrée pour Plesk / PM2 / Passenger
exec node --enable-source-maps "$(dirname "$0")/index.mjs"
