---
name: OTP sign-in boundary
description: Why verification and automatic login remain separate security checks.
---

A returning unverified user's valid credentials should lead to email verification, and successful verification should automatically complete sign-in when those credentials are still available in memory. An OTP by itself must not create an authenticated session.

**Why:** The user explicitly chose automatic sign-in after verification. Reusing the password already supplied to the normal login flow meets that expectation without turning the verification endpoint into a passwordless login path.

**How to apply:** Keep the password transient (no browser storage, URLs, or logs). If it is unavailable or the second login fails, complete verification but return to a usable login form. Do not grant dashboard access before verification succeeds.

The administrator exception must follow the account's current role; do not manufacture a verified timestamp for an administrator who never completed email OTP.

**Why:** If that administrator is later demoted, a synthetic timestamp would preserve the verification bypass indefinitely.

**How to apply:** When correcting legacy accounts, clear unproven verification timestamps even for current administrators. Login and existing-session checks should exempt only accounts that currently hold the administrator role.