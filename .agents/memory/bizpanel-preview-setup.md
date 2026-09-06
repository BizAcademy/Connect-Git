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
Replit preview, obtain a public MariaDB hostname/IP from Cybrance and allow
remote connections. Never assume the website domain is also the database host.

## Backend build

The API development workflow builds before it starts. A committed `dist/`
bundle can be stale, so restart `artifacts/api-server: API Server` after source
or dependency changes.
