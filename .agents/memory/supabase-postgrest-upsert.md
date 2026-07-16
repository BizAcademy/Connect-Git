---
name: PostgREST upsert needs on_conflict
description: Supabase/PostgREST upserts on a UNIQUE (non-PK) column must pass ?on_conflict=<col> or they 409
---

When upserting into a table via the Supabase REST API (`POST /rest/v1/<table>`)
with `Prefer: resolution=merge-duplicates`, you MUST add the query param
`?on_conflict=<column>` naming the UNIQUE column you want to merge on.

**Why:** PostgREST resolves conflicts on the PRIMARY KEY by default. The
`settings` table has `id` as PK and a separate UNIQUE constraint on `key`
(`settings_key_key`). Without `on_conflict=key`, the first save INSERTs fine,
but every later save retries an INSERT and hits the unique violation:
`409 / 23505 duplicate key value violates unique constraint`. The symptom is
"works once, then 'Impossible de sauvegarder' on every edit after".

**How to apply:** Any admin route that writes to `settings` (USD service rates,
deposit currency rates, etc.) must POST to `${SUPABASE_URL}/rest/v1/settings?on_conflict=key`.
