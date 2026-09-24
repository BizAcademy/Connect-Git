---
name: IziChange Pay credit policy
description: Why crypto deposits are credited only after strict provider verification and exact amount matching
---

IziChange Pay payment intents are denominated in fiat USD even when a customer sends crypto. Credit the requested USD amount only after the provider's current intent state is `completed`, its amount and merchant reference match our record, and its payment result is exact. An `irregular` status or accepted under/over-payment needs a separate human decision rather than automatic fixed-value credit.

**Why:** The provider documents that irregular payments can be held pending a merchant decision, and that webhook payloads are immutable snapshots that can be retried after the resource state changes. A signed webhook alone is not sufficient proof of the *current* settled amount.

**How to apply:** For every crypto webhook or customer status check, authenticate the notification and retrieve the current intent using the merchant's server key before crediting. The webhook endpoint is configured in the IziChange Pay dashboard, not supplied as a per-intent URL. Keep the old mobile-money wallet and its AfribaPay credit path separate.