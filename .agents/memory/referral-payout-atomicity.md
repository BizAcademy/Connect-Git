---
name: Referral payout atomicity
description: How referral bonuses must be credited — atomic SQL RPC, flag = proof of credit
---

Rule: any multi-beneficiary money payout (e.g. referral bonuses to referrer + referred) must run through the atomic Postgres function `award_referral_leg` — ONE transaction: row lock (`FOR UPDATE`), balance credit, proof flag (`*_credited_at`), finalize `paid` when both proofs exist. Never split claim/credit across separate PostgREST calls from Node.

**Why:** architect review (July 2026) failed two successive Node-side designs: (1) claim `pending→paid` then credit = silent permanent underpayment if a credit fails after the claim; (2) per-leg flag-before-credit with compensating rollback = a network *exception* between flag and credit leaves a flag without money, later finalized as paid. Only a DB-side transaction makes the flag a *proof* — retries become idempotent by construction, crashes roll back everything.

**How to apply:**
- State machine on `referrals.status`: `pending` → `processing` (single CAS PATCH claim, amounts frozen at claim time) → `paid` (set by the RPC itself).
- Recovery: `recoverStuckReferrals()` swept by the pending-payment scanner + every new deposit of the referred user resumes `processing` rows with the FROZEN amounts (current deposit/threshold not re-tested).
- Business rule "bonus reporté": a deposit below the minimum does NOT consume the referral — the row stays `pending`.
- Any new SECURITY INVOKER RPC called with the service key needs `REVOKE ALL FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role` (house pattern, cf. `smm_refund_order` in migrations 005/019) — REVOKE without the GRANT breaks the API call itself.
