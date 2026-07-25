---
name: PostgREST upsert & ON CONFLICT limits
description: Upserts on a UNIQUE (non-PK) column need ?on_conflict=<col>; partial unique indexes cannot be ON CONFLICT arbiters via PostgREST (42P10)
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

## Partial unique indexes cannot be ON CONFLICT arbiters

`?on_conflict=<cols>` + `Prefer: resolution=ignore-duplicates` fails with
`400 / 42P10 "no unique or exclusion constraint matching the ON CONFLICT
specification"` when the dedupe index is a PARTIAL unique index (e.g.
`UNIQUE (code, visitor_key) WHERE visitor_key IS NOT NULL`) — PostgREST cannot
emit the index predicate required to select a partial arbiter.

**Why:** hit on referral visit tracking: every insert silently failed with
42P10, visits stayed at 0 while the rest of the feature worked.

**How to apply:** with a partial dedupe index, do a PLAIN INSERT (no
`on_conflict`) and treat `409` / body `23505` as success ("already counted").
Alternative: make the index non-partial — NULLs never conflict in Postgres, so
a full `UNIQUE (a, b)` usually behaves the same and works as arbiter.
