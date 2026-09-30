---
name: Transactional notification delivery
description: Why account/payment emails are queued transactionally, and the credential-rotation tradeoff.
---

Account and credited-payment notifications must persist with their business transaction. The background sender must keep the first payload and key unchanged across retries and leave leases recoverable if recording provider acceptance fails.

**Why:** Fire-and-forget sends lose notifications on process restart; regenerating payloads from mutable profiles can turn an uncertain retry into an idempotency conflict.

**How to apply:** Any new notification trigger should use the same transaction as the event. Never call the mail provider while holding the business transaction.

An account e-mail change invalidates codes addressed to the old mailbox. Unsent non-security notifications may be requeued to the new address under **new event keys**, but never edit a frozen payload under its existing key. A message already leased for sending cannot be recalled.

**Why:** An old mailbox must not verify a newly assigned address, while rewriting a queued event across retries breaks the first-payload guarantee and may conflict with a provider acceptance whose database acknowledgement was lost.

**How to apply:** Serialize recipient lookup with account e-mail updates, invalidate old security codes, enqueue fresh verification in the same transaction, and requeue pending business mail rather than changing its existing payload. Be explicit that an in-flight delivery may still reach the former address.

Queued payloads are encrypted with a domain-separated key derived from the mail provider's API token; planned token rotation must first drain the queue.

**Why:** Password-reset links must not sit in plaintext in MySQL. Reusing a derived key avoids imposing an extra deployment secret on this small integration, but rotating the provider token makes pending ciphertext unreadable.

**How to apply:** Preserve this rotation warning; if independent key rotation becomes necessary, migrate to versioned encryption keys rather than silently replacing the derivation. Urgent credential revocation takes priority over pending mail.

In September 2026, the user confirmed receipt of a live Mailtrap transactional test message.

**Why:** Provider acceptance alone does not prove delivery; the recipient confirmation establishes the transport works with the verified sending domain, but it does not test the signup OTP queue.

**How to apply:** When investigating registration OTP issues, focus on signup and outbox behavior before assuming the basic Mailtrap sending path is broken. Recheck provider status if delivery later changes.