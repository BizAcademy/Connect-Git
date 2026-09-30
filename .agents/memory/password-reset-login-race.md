---
name: Password reset and login race
description: Security constraint tying password change, session revocation, and concurrent login.
---

Password reset must serialize with the full login operation: old-password verification, any password-hash rehash, and session creation. A login that checks the old hash before reset and inserts its session after reset's revocation bypasses the intended logout.

**Why:** Revoking existing sessions is insufficient if a concurrent login can create a new one just after the revocation. An opportunistic login rehash can also overwrite the new reset hash if not conditioned on the originally verified hash.

**How to apply:** Preserve a shared user-row lock and one login transaction through session creation when changing authentication; keep rehash updates conditional on the hash that was verified. Check concurrent login/reset behavior, not only sequential tests.