---
name: BizPanel SEO prerender
description: Why and how the BizPanel homepage is prerendered to static HTML for Google indexing.
---

# BizPanel homepage prerendering (SEO)

BizPanel is a CSR-only React+Vite SPA deployed as **static files on Plesk**. The served HTML body was just `<div id="root"></div>` (1 char of visible text), which contributed to the site being dropped from Google's index.

## Solution
A build-time prerender step (`artifacts/bizpanel/prerender.mjs`, run via `pnpm --filter @workspace/bizpanel run prerender`) launches headless Chromium against the built `dist/public`, renders `/`, and overwrites `index.html` with the fully-rendered DOM (module script preserved, so client React still takes over). Wired into `build-for-plesk.sh` as a **non-fatal** step ([2b/4]) between the frontend build and the dist-deploy copy.

## Key constraints (non-obvious)
- **Chromium must come from Nix, not puppeteer's bundled download.** The puppeteer-downloaded chrome fails with `libglib-2.0.so.0: cannot open shared object file`. Install via `installSystemDependencies(["chromium"])`; the script auto-detects it with `which chromium`.
- The build runs **on Replit** (not on Plesk — Plesk only serves the pushed static files), so a browser-based prerender at build time is viable and produces pure static output.
- Only `/` is prerendered: production serves `index.html` via SPA fallback for all routes, so a single prerendered index.html is what matters. `/auth` etc. are low SEO value.
- Prerender is intentionally non-fatal: if the browser fails, the build continues with the standard (empty-body) index.html so deploys never break.

**Why:** User reported the live site disappeared from Google. Technical SEO (robots.txt, sitemap, meta robots=index, canonical, JSON-LD) was already correct — the empty rendered body was the gap. Code fix alone doesn't re-index; the user must also request re-indexing / check manual actions in Google Search Console.
