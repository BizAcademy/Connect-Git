#!/bin/bash
set -euo pipefail

# The runnable packages use committed API client code. The api-spec package is
# only needed when regenerating it, and its Orval version is blocked by the
# package firewall; do not bypass the firewall to install it during merges.
pnpm --filter '!@workspace/api-spec' install --frozen-lockfile

# BizPanel uses MySQL. The template PostgreSQL schema is empty, so a Drizzle
# push here would affect an unrelated database rather than migrate this app.
