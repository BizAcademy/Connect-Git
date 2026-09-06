# BizPanel MySQL/MariaDB cutover

Authentication is isolated behind `/api/auth/*` and uses the `bb_session`
HttpOnly cookie. MySQL/MariaDB is the runtime system of record for profiles,
roles, orders, deposits, wallet/audit records, refunds, referrals, tickets,
earnings, settings, site content, provider configuration, and pricing.
Supabase is archive/export-only; normal runtime must not require Supabase
environment variables or call its Auth, REST, RPC, or Storage APIs.

## Configuration and schema

Set only `MYSQL_HOST`, `MYSQL_PORT` (optional, defaults to 3306),
`MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` for the MySQL pool.
Do not put credentials in files or commands. From a new, empty schema:

```sh
pnpm --filter @workspace/api-server run migrate:mysql
```

The command tests connectivity first, applies every numbered SQL file in order,
and records completed files in `schema_migrations`. A failed connection or SQL
statement is a failure, never a successful migration.

## Safe legacy user/profile/role import

Export locally as JSON with exactly these columns per record:

`id`, `email`, `encrypted_password`, `username`, `country`, `currency`,
`balance`, `affiliate_earnings`, `avatar_url`, `referral_code`, and optional
`roles` (an array of role strings exported from `public.user_roles`, such as
`["admin"]`). The importer always adds the baseline `user` role and imports
only explicitly exported roles; it never infers administration from profile
data.

`id` must be the UUID from `auth.users`; `encrypted_password` must be the
original bcrypt MCF value from `auth.users`. `balance` and
`affiliate_earnings` are imported in their current display currency and
converted to integer minor units in MySQL. Do not export access tokens,
refresh tokens, service keys, MFA secrets, or any other auth metadata. Put the
file under ignored `exports/`, then run:

```sh
pnpm --filter @workspace/api-server run import:supabase-users -- exports/supabase-users.json
```

The importer validates UUIDs and bcrypt MCF hashes, upserts by UUID/email, and
does not print password hashes. It performs each user's profile and role import
in one transaction. Test on a database copy first. Legacy bcrypt
hashes are transparently rehashed at the current application cost at the next
successful login.

## Archive boundary and reconciliation

The importer deliberately does **not** import historic orders, payments,
wallet transactions, refunds, earnings, tickets, or provider records. Those
records remain in the Supabase archive for reconciliation and export. New
activity is written only to MySQL after cutover. Preserve a read-only archive
export outside the normal API process if historical reports are required.

Before switching traffic, export and reconcile old profile balances and roles,
run the importer against a database copy, and verify count/balance totals.
Do not mark the migration successful merely because the SQL command was
invoked: it succeeds only after it can connect and apply to an empty target
schema. In this Replit environment `MYSQL_HOST` currently resolves to an
inaccessible localhost, so an actual migration/run remains blocked until a
reachable MySQL/MariaDB host is configured.