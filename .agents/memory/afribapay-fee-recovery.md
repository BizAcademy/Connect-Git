---
name: AfribaPAY historical fee recovery
description: Official history/status API fields and constraints for recovering real deposit costs.
---

**Rule:** Automatic reconciliation is authorized for completed AfribaPAY deposits with missing provider fees. Recover fee and tax amounts only from AfribaPAY status or history responses. The official examples expose `fees` and `taxes` (and `fees_taxes_ttc` in status); history supports exact order/transaction ID lookups and date windows of up to six months. Provider retention is not guaranteed by the documentation, and `amount_total` must not be treated as the merchant's gross or payer debit until its accounting meaning is confirmed. Keep the per-transaction admin preview read-only.

**Why:** The user authorized background recovery while requiring exact provider-reported amounts and preserving the manual preview's read-only role. Estimated rates or an incorrect gross basis would make transaction-level net amounts misleading.

**How to apply:** Reconcile completed deposits through a rate-limited provider lookup by saved order/transaction ID, and leave fees/net unknown when the provider returns no actual amounts. Never use `amount_total` as a fee substitute; confirm its accounting meaning before changing the report's gross calculation.
