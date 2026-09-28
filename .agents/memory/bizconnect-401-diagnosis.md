---
name: BizConnect 401 diagnosis
description: How to distinguish an IP allowlist rejection from a credential rejection without consuming OTP attempts.
---

Do not treat an IP reported by a third-party echo service as proof of the source IP seen by BizConnect. If BizConnect returns 401 despite an active client, a matching client ID and an allowlisted observed egress IP, obtain the provider's rejection reason and source IP or temporarily use a separate test-only client without an IP restriction. Never relax the production client's network restrictions just for diagnosis.

**Why:** The provider's 401 is generic enough that secret mismatch and source-IP filtering cannot reliably be distinguished from the application's response alone. Different destinations can see different outbound IPs, and failed signup messages consume the per-account send allowance.

**How to apply:** Probe authentication with an empty, non-deliverable request first. Only request a new OTP after the provider stops returning 401. Explain that an unrestricted test client has less network protection and should be retired or restricted after diagnosis.