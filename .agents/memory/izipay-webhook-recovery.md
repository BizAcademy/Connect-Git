---
name: Crypto webhook recovery
description: Why signed payment webhooks need quick acknowledgement plus durable independent reconciliation
---

Signed crypto webhook deliveries should be acknowledged promptly without waiting for the payment provider API or wallet database transaction. This is safe only when checkout links are handed out after the payment intent reference has been durably stored, and a separate scanner can recover uncredited intents by retrieving their authoritative provider state. Never credit from webhook payload alone; invalid signatures still fail.

**Why:** IziChange Pay's documented policy counts non-2xx responses and 10-second transport timeouts as failures and disables a webhook endpoint after five consecutive failures. Synchronous reconciliation makes a transient provider/DB outage look like five bad deliveries. A detached in-memory job alone would lose payments on process restart.

**How to apply:** Preserve the persisted-intent-before-checkout contract and independent reconciliation without an age cutoff when changing crypto payment flows. A delivery with a valid HMAC but an old signed timestamp is acknowledged without processing its payload immediately; the scanner checks current provider state. This prevents an old retry from exhausting the failure budget without making replayed payloads trigger provider calls. After fixing a disabled endpoint, the merchant must reactivate it in the provider dashboard and can resend deliveries from its history. If delivery history shows 401, diagnose the signature/secret or proxy headers rather than accepting unverified events.