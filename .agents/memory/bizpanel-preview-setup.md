---
name: BizPanel preview setup
description: Environment-specific database and build requirements for running BizPanel in Replit and Plesk.
---

# Running BizPanel across Replit and Plesk

The real project lives in GitHub (`BizAcademy/Connect-Git`), not in the Replit template. A fresh workspace must be synced from the repo, then the `bizpanel` artifact adopted so the platform creates its workflow.

## MariaDB locality

The Plesk database advertises `localhost:3306`; that address is correct only
when the Node API runs on the same Plesk server. In Replit, `localhost` points
back to the Replit container and produces `ECONNREFUSED`.

**Why:** The application was moved from Supabase runtime storage to the user's
Plesk MariaDB. Preview and production now have different network paths to the
same kind of database.

**How to apply:** Use `localhost:3306` in Plesk production. For an interactive
Replit backend test, obtain a public MariaDB hostname/IP from Cybrance and
allow remote connections. Never assume the website domain is also the
database host.

The user chose to let the Replit preview proxy all API calls to the live
Plesk API so they can sign in with existing accounts. This is suitable for
viewing and using the deployed product, not for testing undeployed API changes
such as the crypto-wallet integration. All writes made in that preview affect
real Plesk data.

**Why:** The configured MySQL secrets still pointed to a loopback host in the
Replit container, while the Plesk API's own database health check succeeded.
Using the live API avoided pretending that the Replit backend had access to
Plesk's local MariaDB.

**How to apply:** Preserve the development-only proxy and its visible live-data
warning while the user wants production account access in preview. Before
validating new backend changes, explicitly arrange a reachable test database
or deploy to a test Plesk environment; a passing proxied health check only
proves Plesk is healthy.

## Backend build

The API development workflow builds before it starts. A committed `dist/`
bundle can be stale, so restart `artifacts/api-server: API Server` after source
or dependency changes.
