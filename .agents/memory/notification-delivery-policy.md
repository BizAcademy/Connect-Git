---
name: Transactional notification delivery
description: Why account/payment emails are queued transactionally, and the credential-rotation tradeoff.
---

Account and credited-payment notifications must persist with their business transaction. The background sender must keep the first payload and key unchanged across retries and leave leases recoverable if recording provider acceptance fails.

**Why:** Fire-and-forget sends lose notifications on process restart; regenerating payloads from mutable profiles can turn an uncertain retry into an idempotency conflict.

**How to apply:** Any new notification trigger should use the same transaction as the event. Never call the mail provider while holding the business transaction.

Queued payloads are encrypted with a domain-separated key derived from the BizConnect client secret; planned secret rotation must first drain the queue.

**Why:** Password-reset links must not sit in plaintext in MySQL. Reusing a derived key avoids imposing an extra deployment secret on this small integration, but rotating the provider secret makes pending ciphertext unreadable.

**How to apply:** Preserve this rotation warning; if independent key rotation becomes necessary, migrate to versioned encryption keys rather than silently replacing the derivation. Urgent credential revocation takes priority over pending mail.