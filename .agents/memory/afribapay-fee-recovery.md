---
name: AfribaPAY historical fee recovery
description: Official history/status API fields and constraints for recovering real deposit costs.
---

**Rule:** Recover fee and tax amounts only from AfribaPAY status or history responses. The official examples expose `fees` and `taxes` (and `fees_taxes_ttc` in status); history supports exact order/transaction ID lookups and date windows of up to six months. Provider retention is not guaranteed by the documentation, and `amount_total` must not be treated as the merchant's gross or payer debit until its accounting meaning is confirmed.

**Why:** The report must not substitute estimated rates for missing transaction-level costs, and an incorrect gross basis would make the net misleading even when the fee fields are real.

**How to apply:** Reconcile completed deposits through a controlled provider lookup, match on provider identifiers, and leave fees/net unknown when the provider returns no actual amounts. Confirm the accounting meaning of `amount_total` before changing the report's gross calculation.
