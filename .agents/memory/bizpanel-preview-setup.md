---
name: BizPanel preview setup
description: What it takes to run the BizPanel (BUZZ BOOSTER) preview in a fresh Replit workspace synced from GitHub.
---

# Running BizPanel preview in a fresh workspace

The real project lives in GitHub (`BizAcademy/Connect-Git`), not in the Replit template. A fresh workspace must be synced from the repo, then the `bizpanel` artifact adopted so the platform creates its workflow.

## Frontend (artifacts/bizpanel)
- Needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (from the user's Supabase project). Without them the app throws `supabaseUrl is required` at load. Set as Replit secrets; Vite exposes `VITE_*` from env.

## Backend (artifacts/api-server)
- The dev script is `pnpm run build && pnpm run start` — it rebuilds `dist/` on start.
- **The repo commits a `dist/` bundle that can be stale.** If routes that exist in source (e.g. `/api/smm/services`) return 404, the running bundle is old — just restart the `artifacts/api-server: API Server` workflow to force a rebuild.
- Full data functionality needs server-only credentials the user keeps in their Plesk deploy: SMM provider keys (`SMM_PANEL_*_API_KEY`), AfribaPay (`AFRIBAPAY_API_USER/API_KEY/MERCHANT_KEY`), `SUPABASE_SERVICE_ROLE_KEY`. Without them endpoints return 500 (e.g. "Fournisseur SMM #1 non configuré") — this is config, not a bug.

**Why:** User only wanted to preview the app ("just open, don't modify"). The landing page renders with just the two VITE_ Supabase vars; deeper panel data requires the backend credentials.
