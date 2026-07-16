---
name: USD service rates must load from DB at startup
description: Admin USD→local pricing override is in-memory only; without a startup loader it silently reverts to hardcoded defaults on every restart/redeploy
---

The admin-configured USD→local SMM pricing lives in an in-memory override
(`_usdRatesOverride` in `lib/smm-pricing.ts`, key `smm_usd_rates` in Supabase
`settings`). `getUsdRates()` is synchronous and does NOT lazy-load from the DB.

**Why it matters:** the override was only ever populated by the admin PUT route.
So after any server restart or Plesk redeploy, prices silently reverted to the
hardcoded defaults until an admin reopened the "Devises" tab. Symptom: admin
saves affordable prices, they look fine, then revert on the next restart.

**How to apply:** the server now calls `loadUsdRatesAtStartup()` (exported from
`routes/admin.ts`) inside `index.ts` BEFORE `warmServicesCache()`. Keep that
ordering so the warmed services cache reflects saved prices, not defaults. Note
the contrast: deposit currency rates (`currency_rate_*`) DO self-heal via
`ensureRatesLoaded()` (TTL lazy-load in `lib/deposits.ts`); USD service rates do
not, so they depend on the startup load.
