# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Contains the BUZZ BOOST app (codebase historically named "bizpanel" — package and folder names kept for stability) — a Social Media Marketing (SMM) platform for Francophone Africa.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM (shared backend) + Supabase (BUZZ BOOST auth & data)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## BUZZ BOOST (`artifacts/bizpanel`)

Frontend SMM platform built with React + Vite + Tailwind CSS.

### Pages

- `/` — Landing page (Navbar, Hero, Services, Features, Pricing, Footer + WhatsApp button)
- `/auth` — Login / Signup / Password reset
- `/reset-password` — Password update after email link
- `/admin` — Admin panel (Users, Orders, Payments, Bonus, Transactions, Support, Services, Content, Settings)
- `/dashboard` — User dashboard layout
  - `/dashboard` (index) — Overview stats + recent orders
  - `/dashboard/order` — New order form
  - `/dashboard/orders` — All user orders history
  - `/dashboard/deposit` — Top-up wallet (AfribaPay Mobile Money integration, multi-country, multi-operator wizard)
  - `/dashboard/payments` — Payment history

### Backend / Auth

- **Supabase**: Authentication (email/password), Postgres DB, RPC for roles
- **Tables**: `profiles`, `orders`, `payments`, `user_roles`, `services`, `site_content`, `settings`
- **Payment gateway**: AfribaPay (Mobile Money multi-pays Afrique francophone — Orange, MTN, Wave, Moov, Airtel, M-Pesa). Guinée et R.D.C. exclues.
- **Roles**: `admin` / `user`

### Key Features

- Editable landing page content (via `site_content` table in admin)
- AfribaPay payment integration (server-proxied — credentials are server-only env vars: `AFRIBAPAY_API_USER`, `AFRIBAPAY_API_KEY`, `AFRIBAPAY_MERCHANT_KEY`, optional `AFRIBAPAY_API_BASE`)
- Affiliate system (tracked in `profiles.affiliate_earnings`)
- Dynamic services loaded from DB (fallback to hardcoded defaults)
- **Deposit bonus**: every confirmed deposit ≥ 5 000 FCFA grants the user
  a +200 FCFA bonus credited automatically with the deposit. Centralized,
  idempotent server logic in `artifacts/api-server/src/lib/deposits.ts`
  (CAS on `payments.credited_at IS NULL`). Triggered by:
  - `POST /api/payments/webhook` (public; auth via HMAC-SHA256 signature
    of the raw body using `AFRIBAPAY_API_KEY`, sent in the
    `Afribapay-Sign` header). Requires `SUPABASE_SERVICE_ROLE_KEY` to
    write across users.
  - Admin panel "Bonus" tab → manual validation / bonus retry, using the
    admin's own session via RLS.
- **Admin earnings dashboard** ("Mes gains administrateur"): aggregated
  totals (today/month/year/total), rolling-30-day projections, area
  chart, and a permanent **journal quotidien** that lists every day of
  the chosen window (30 / 90 / 365 days, full history, or custom date
  range) — including days with zero orders — with a CSV export. Backed
  by `GET /api/admin/earnings` which now accepts `days`, `from`, `to`,
  `all` query params and pre-fills empty days server-side. The ledger
  itself is stored on **Supabase** (`earnings` table) so preview and
  published environments share a single source of truth that survives
  redeploys — see `artifacts/api-server/src/lib/earnings.ts`.

## Migrations

SQL migrations under `migrations/` must be applied **manually** in the
Supabase SQL editor (in order).

**Préférence utilisateur** : à chaque création ou modification d'une
migration SQL, coller systématiquement le contenu complet du fichier
directement dans la conversation (bloc ```sql) sans attendre que
l'utilisateur le demande, en plus de l'écrire dans `migrations/`.

- `001_settings_rls.sql` — RLS on `settings` + purge of legacy SoleasPay
  credentials (now server env vars only).
- `002_payments_bonus.sql` — adds `bonus_amount`, `bonus_status`,
  `bonus_credited_at`, `credited_at` columns to `payments`, plus
  indexes; backfills `bonus_status='pending'` for existing eligible
  deposits.
- `003_earnings.sql` — creates the `earnings` ledger table on Supabase
  (with the unique index on `provider_order_id` for idempotency) and
  enables RLS with no policies — only the API server (using the service
  role key) can read or write the table.
- `004_refunds.sql` — adds `refunded_at` and `refunded_amount` columns to
  `orders` (with index) for the idempotent SMM auto-refund flow.
- `005_smm_refund_atomic.sql` — Postgres function `smm_refund_order(uuid, int)`
  that locks the order row, marks it refunded and credits the user balance
  in a single transaction (eliminates the residual two-step risk).
- `007_afribapay.sql` — AfribaPay deposit integration: adds `operator`,
  `country`, `phone_number`, `currency`, `transaction_id`, `order_id`
  columns to `payments`, plus a partial unique index on `order_id` (used
  by the webhook for idempotent lookup). Old SoleasPay columns
  (`reference`, etc.) are kept for historical rows.
- `006_multi_provider.sql` — multi-provider support: adds `provider smallint`
  column to `orders` and `earnings` (default 1, check IN (1,2,3)), drops the
  old single-column unique index on `earnings.provider_order_id` and recreates
  it as a composite `(provider, provider_order_id)` so two SMM panels can
  legitimately return the same numeric order id; creates the new
  `smm_providers_config` table (one row per provider 1/2/3 with display_order,
  enabled, header_title, header_text) with public-read RLS. The API server
  expects all three changes; until applied, multi-provider features fall back
  to provider 1 only and the admin "providers" tab uses in-memory defaults.
  - **Provider 4 (Peakerr)**: the code accepts provider id 4 everywhere and
    requires `SMM_PANEL_4_API_URL` + `SMM_PANEL_4_API_KEY` secrets. The
    matching `smm_providers_config` row must be inserted manually (the
    schema check on `provider IN (1,2,3,4)` is added implicitly by the
    code; if your existing CHECK constraint hard-codes 1/2/3, drop and
    recreate it before inserting the row).

## SMM provider integration (Peakerr-aware)

`lib/smm-status.ts` centralises the cross-cutting helpers used by both the
HTTP routes and the background poller:

- `mapProviderStatus()` — normalises provider status strings ("In progress",
  "Completed", "Partial", "Canceled", ...) into the lowercase canonical set
  used by the DB (`processing`, `completed`, `partial`, `canceled`, ...).
- `FINAL_REFUND_STATUSES` — set of mapped statuses that make an order
  eligible for an automatic refund (`canceled`, `refunded`, `failed`).
- `SUPPORTED_SERVICE_TYPES` + `isSupportedServiceType()` — **allowlist** of
  Peakerr service types compatible with our generic `service+link+quantity`
  order payload (`default`, `package`). Any other type (Custom Comments,
  Mentions, Polls, Subscriptions, Comment Likes, ...) is hidden from the
  public catalogue (`/api/smm/services`) AND rejected at `/api/smm/order`
  with HTTP 400. Providers that omit the `type` field are tolerated
  (matches historical behaviour of provider 1/2/3).

`lib/order-status-poller.ts` uses Peakerr's documented multi-order endpoint
(`action=status&orders=1,2,3` — up to 100 ids per call) to keep upstream
load constant as order volume grows: orders are grouped by provider, then
ONE batched status call is made per provider. Only orders whose mapped
status changed (or that are eligible for a refund retry) are then handed
to `syncOrderInternal` for the heavy DB+refund path. Both documented
response shapes are parsed (`{id: {status,...}}` keyed object and
`[{order, status,...}]` array). Orders not recognised in the batch fall
back to a per-order sync so errors surface properly. The poller's tick
log now includes `providers_polled`, `synced` and `skipped_unchanged`
counters for observability.

## SMM auto-refund (idempotent)

When a provider returns a `Canceled` / `Refunded` status for an order
that the user already paid for, the API server credits the user back
automatically:

- `POST /api/smm/orders/:externalId/sync` (user-scoped) and
  `POST /api/admin/orders/:externalId/refund` (admin-only) both call
  `syncOrderInternal` which uses a CAS PATCH on
  `orders?refunded_at=is.null` to claim the refund slot, then credits
  the user via `refundBalanceServiceRole`.
- If the balance credit fails AFTER the CAS, the server reverts the
  `refunded_at` marker so the next sync can retry — no money silently
  lost. The fallback is logged at ERROR level.
- The user-facing `/dashboard/transactions` page lists deposits, orders
  and refunds with a printable invoice modal. The admin "Transactions"
  tab shows the same unified ledger plus a "Rembourser" button to force
  a refund.

Until `003_earnings.sql` is applied AND `SUPABASE_SERVICE_ROLE_KEY` is
configured, the earnings ledger falls back to a local append-only file
(`data/earnings.jsonl` next to the API server). That file lives inside
the runtime container, is NOT shared between preview and the published
environment, and is wiped on every deployment — i.e. the published
"Mes gains administrateur" screen will show no data until both the
secret and the migration are in place. The same file is also used as a
transient safety net if a single Supabase write fails after the
migration; rows captured there can be re-imported via the admin
"Synchroniser" button (`POST /api/admin/earnings/backfill`).

## Required server env vars

- `AFRIBAPAY_API_USER` (publishable key `pk_…`), `AFRIBAPAY_API_KEY`
  (secret key `sk_…`, sert aussi pour la signature HMAC du webhook),
  `AFRIBAPAY_MERCHANT_KEY` (`mk_…`) — passerelle de paiement
  (server-only). Optionnel : `AFRIBAPAY_API_BASE` (défaut
  `https://api.afribapay.com`).
- `PUBLIC_API_URL` — URL publique du serveur d'API utilisée comme
  `notify_url` envoyée à AfribaPay. À défaut, le serveur déduit l'URL
  depuis `REPLIT_DEV_DOMAIN` en environnement Replit.
- `SUPABASE_SERVICE_ROLE_KEY` — required for the public webhook to write
  to Supabase (bypasses RLS). Never expose client-side.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
