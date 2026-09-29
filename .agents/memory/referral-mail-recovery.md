---
name: Referral recovery after notification failure
description: Recovery constraint when commission mail is queued in the bonus-credit transaction after the deposit has already committed.
---

Referral recovery must consider both processing referrals and pending referrals whose qualifying deposit was already credited.

**Why:** The deposit commits before the separate referral payout starts. If queuing the commission notification fails, the referral transaction rolls back to pending. A retry that only scans processing referrals will never revisit it, and retrying the completed deposit cannot trigger its normal credit path again.

**How to apply:** When changing notification delivery, bonus payout, or recovery logic, preserve an independent way to discover eligible credited deposits for pending referrals. Credit and queue atomically with a stable referral event key; never rely only on the depositing request to retry.