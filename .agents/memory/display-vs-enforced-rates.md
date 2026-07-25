---
name: Display vs enforced currency rates
description: Frontend static rates are display-only; anything that must match enforcement is computed server-side
---

Rule: any user-facing amount that must match what the backend enforces (qualification thresholds, minimums) must be computed **server-side** with the live effective rate — never with the frontend's static rate table.

**Why:** bizpanel's `src/lib/currency.ts` has hardcoded fcfaPerUnit rates (display approximations), while the api-server applies admin overrides from `settings.currency_rate_*` (loaded via `ensureRatesLoaded`). They diverge silently (July 2026: CD static 0.1111 vs admin 0.15 → the referral threshold showed 18 002 CDF while 13 334 CDF actually qualified — users thought they didn't qualify when they did).

**How to apply:**
- Server: resolve the rate through the SAME code path the money flow uses (`getEffectiveRateByCurrency` shares resolution with `toFcfaByCurrency`), then send the converted amount in the API response (e.g. `/api/referrals/me` → `min_deposit_local` + `currency`).
- Round thresholds UP (`Math.ceil`) so the displayed amount always qualifies (never display an amount that fails the check; overstating by 1 local unit is fine).
- Frontend: prefer the server-provided local amount, keep `formatBalance` only as fallback.
- User's currency: `profiles.currency` first, else map from `profiles.country`.
