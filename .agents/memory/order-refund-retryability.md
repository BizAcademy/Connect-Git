---
name: Order refund retryability
description: Ordering and recovery rules that prevent failed or canceled SMM orders from becoming permanently unrefunded
---

Rule: for provider statuses that require a refund, complete the atomic wallet credit before persisting the terminal order status. Recovery scans must catch errors per order and continue processing the remaining eligible orders.

**Why:** the status poller excludes terminal orders. If `failed` or `canceled` is saved before a wallet transaction that then fails, normal polling stops retrying that order. A recovery loop that aborts on one malformed order can also block every later refund in its page.

**How to apply:** keep refund writes idempotent and transactional; only publish the terminal status after the credit succeeds. Retain a frequent missed-refund scanner for already-terminal rows, and isolate each order so one failure cannot block others.