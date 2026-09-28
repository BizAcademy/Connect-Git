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
Replit backend test, use the isolated local MariaDB test workflow and schema,
or an explicitly separate reachable test database. Never assume the website
domain is also the database host.

Previously the preview proxied all API calls to live Plesk so existing users
could sign in, but that could not test undeployed backend changes and any signup
created a real production account. The preview was switched to an isolated
local MariaDB schema for testing signup and BizConnect mail.

**Why:** Testing the undeployed transactional signup mail requires local routes
and local tables, without writing to production accounts or orders.

**How to apply:** Keep local preview isolated during signup tests. Do not
re-enable the Plesk proxy without explaining that preview signup then writes
to production. Local test database files are not version-controlled, so a
fresh checkout needs initialization and all migrations before testing.

## Backend build

The API development workflow builds before it starts. A committed `dist/`
bundle can be stale, so restart `artifacts/api-server: API Server` after source
or dependency changes.
