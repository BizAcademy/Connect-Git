# BizPanel MySQL/MariaDB phase 1

Authentication is now isolated behind `/api/auth/*` and uses the `bb_session`
HttpOnly cookie. Existing Supabase PostgREST/storage business routes remain
archive dependencies during this phase; do not remove their Supabase variables
until those routes have been migrated.

## Configuration and schema

Set only `MYSQL_HOST`, `MYSQL_PORT` (optional, defaults to 3306),
`MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` for the MySQL pool.
Do not put credentials in files or commands. From a new, empty schema:

```sh
pnpm --filter @workspace/api-server run migrate:mysql
```

The command tests connectivity first and refuses to run if any BizPanel target
table already exists. A failed connection or refusal is a failure, never a
successful migration.

## Safe Supabase user export/import

Export locally as JSON with exactly these columns per record:

`id`, `email`, `encrypted_password`, `username`, `country`, `currency`,
`balance`, `affiliate_earnings`, `avatar_url`, `referral_code`.

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
does not print password hashes. Test on a database copy first. Legacy bcrypt
hashes are transparently rehashed at the current application cost at the next
successful login.