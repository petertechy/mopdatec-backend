# MOPDATEC WI-FI — Backend

Node + TypeScript + Express + PostgreSQL, talking to a MikroTik router over
the RouterOS binary API (`node-routeros`), with Socket.IO for live dashboard
updates. This is the backend half of the MOPDATEC WiFi voucher/hotspot
platform — the companion `mopdatec-frontend` repo (React + TypeScript +
Tailwind) is the admin dashboard and customer-facing captive portal that
talks to this API.

This backend replaces the earlier static-portal project's "generate a
command, paste into Terminal" admin workflow with real API calls and a live
dashboard.

## What this fixes vs. the static-portal version

| Issue | Static-portal version | This app |
|---|---|---|
| 1 — popup not triggering | `verify-captive-portal.rsc` (manual run) | Same script, still required — this is a router-side fix regardless of what talks to it |
| 2 — data limit overshoot | `limit-bytes-total` set via pasted command | Set via `POST /api/vouchers` → RouterOS API call, no copy-paste |
| 3 — disable + redirect | Two-command paste from `admin.html` | `POST /api/vouchers/:pin/disable` does both steps atomically |
| 4 — bulk-disable shared voucher | Manual "generate disable command" | Same endpoint as #3 — one click in the dashboard |
| 5 — one-step voucher creation | `disabled=no` in the pasted command | Same, but also now checks PIN uniqueness against the database before creating (audit finding #3 fix) |
| Plan pricing desync (audit #2) | Hardcoded separately in `login.html` | `plans` table is the only source of truth; `GET /api/plans/export.js` regenerates `plan-data.js` for the router's static pages |

## Architecture

```
Browser (React dashboard, separate repo)
   │  REST (fetch) + Socket.IO
   ▼
Node/Express backend (this repo)  ──────────────►  PostgreSQL (plans, vouchers, usage_snapshots, payments)
   │  RouterOS binary API (node-routeros, port 8728/8729)
   ▼
MikroTik router  ──(scheduler, /tool fetch, every 30s)──►  POST /api/usage/webhook
```

Two paths feed usage data into the backend:
1. **Router push** (`router-scripts/push-usage-webhook.rsc`) — primary, near-real-time, dashboard-freshness only.
2. **Manual poll** (`POST /api/usage/poll`, "Poll router now" button) — on-demand fallback, reads `/ip/hotspot/active/print` directly.

**Actual data-cap enforcement never depends on either of these** — it's native `limit-bytes-total` on the RouterOS user, enforced per-packet by the router itself. The webhook/poll paths only exist to keep the *dashboard* current and to trigger a backup disable call if something's usage sneaks past due to an edge case.

## Local setup

### 1. Database
```bash
createdb mopdatec
psql mopdatec -f database/schema.sql
```
Or point `DATABASE_URL` at a hosted Postgres (e.g. Render) and skip the local `createdb`.

### 2. Backend
```bash
cp .env.example .env   # fill in DATABASE_URL, ROUTEROS_*, JWT_SECRET, etc.
npm install
npm run dev             # http://localhost:4000
```

### 3. Frontend
See the `mopdatec-frontend` repo — it needs `VITE_API_URL` pointed at wherever this backend is running.

### 4. Router
On the MikroTik router, over WinBox New Terminal:
```
/import file-name=push-usage-webhook.rsc
```
Edit `$webhookUrl` and `$secret` inside that script first (must match your backend's deployed URL and `WEBHOOK_SHARED_SECRET`). This is in addition to — not a replacement for — the five setup scripts from the original static-portal project (`create-hotspot-profiles.rsc`, `sync-profile-scripts.rsc`, `migrate-legacy-vouchers.rsc`, `verify-captive-portal.rsc`, `expire-vouchers.rsc`), which still need to be run for the underlying hotspot behavior (Issues 1–3) to work at all.

Also make sure the RouterOS **API service** is enabled (it's off by default on some configs):
```
/ip service enable api
```
For anything reachable over the public internet, use `api-ssl` (port 8729) instead and set `ROUTEROS_TLS=true` in `.env`, not the plaintext `api` service.

## Deployment

### Backend + Postgres → Render
1. Create a **Postgres** instance on Render, copy its connection string into `DATABASE_URL`.
2. Create a **Web Service** from this repository.
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Add all vars from `.env.example` in Render's environment settings.
3. After first deploy, run the migration once (Render Shell, or a one-off job):
   ```
   node dist/db/migrate.js
   ```
4. Your router must be able to reach this Render URL over the internet for `push-usage-webhook.rsc` to work — Render's default URL (`https://your-app.onrender.com`) is publicly reachable, so this works out of the box as long as your router has outbound internet access, which it already needs for normal operation.

### Router reachability note
This backend needs a direct network path to the router's RouterOS API port (8728/8729) — this only works if the router has a public IP/reachable port-forward, or you run the backend on a network that can reach the router directly (e.g. same LAN, VPN, or a small VPS at the same site as the router). Render is a fully public-internet host, so plan your router's exposure (port-forward + firewall rules restricting to your backend's outbound IP, or a VPN tunnel) before pointing `ROUTEROS_HOST` at a public address.

Set `CORS_ORIGIN` to your deployed frontend's URL (comma-separate if you keep a preview URL too).

## The customer-facing captive portal is now dynamic too

`login.html`, `status.html`, `logout.html`, and `error.html` are no longer
static files on the router with hardcoded plan data. They're now **thin
redirect stubs** (`router-scripts/hotspot-stubs/*.html`) that forward
RouterOS's own template variables (`$(link-login-only)`, `$(error)`, etc.) as
URL params to real, dynamic pages in the frontend repo
(`frontend/src/pages/portal/*.tsx` there), reached at `/portal/login`,
`/portal/status`, `/portal/logout`, `/portal/error`.

```
Client's phone
   │  auto-popup → router serves login.html (tiny stub)
   ▼
Router's login.html
   │  window.location.replace(...) with RouterOS vars as query params
   ▼
https://your-frontend.vercel.app/portal/login?linkLoginOnly=...&error=...
   │  fetches GET /api/plans (live from Postgres) — renders real-time pricing
   │  user submits — form POSTs directly to $(link-login-only) on the router
   ▼
Router completes auth (PAP, same as before) → redirects to $(link-orig)
```

This is the same external-hosting pattern the competitor's system used (the
`yuslamuniquetechandcomputerserviceslimited...` domain from the reference
video) — RouterOS supports it natively via the walled garden, it isn't a hack.

**What this fixes that the static version couldn't:**
- Plan pricing/labels on the login page now come from the same `plans` table
  that vouchers are actually created against — permanently closes audit
  finding #2 (previously only `bytesLimit`/`durationDays` were synced via
  `plan-data.js`; price was hardcoded a third time, separately, in
  `login.html`).
- `status.html`'s usage figures now come from `usage_snapshots` (persists
  across reconnects) instead of RouterOS's session-scoped `$(bytes-in)` /
  `$(bytes-out)` counters, which reset on every reconnect/idle-timeout.

**Required setup step:**
1. In each file under `router-scripts/hotspot-stubs/`, replace
   `YOUR-FRONTEND.vercel.app` with your actual deployed frontend domain, then
   upload them to the router's `/hotspot/` directory (WinBox → Files),
   overwriting the originals.
2. Run `router-scripts/allow-portal-domain.rsc` (after replacing the domain
   inside it too) — without this, unauthenticated clients can't reach the
   portal domain to load the redirect target at all.
3. `alogin.html`, `rlogin.html`, `redirect.html`, `radvert.html` are left as
   local static files (still on the router, unchanged) — they're pure
   transitional spinners with no user-specific data to render, so there's no
   benefit to externalizing them.

The actual RouterOS **authentication** (username/password check,
`limit-bytes-total` enforcement) is completely unchanged by any of this —
only what the customer *sees* moved off the router.

## Self-service voucher purchase (Paystack)

`/portal/buy` (frontend repo) lets a customer pick a plan, pay with Paystack
(card/bank transfer/USSD), and get a voucher PIN automatically — no admin
action required. Flow:

```
/portal/buy
   │  POST /api/payments/initialize {planKey, email}
   │  → creates a pending `payments` row, returns Paystack's authorization_url
   ▼
Paystack Standard Checkout (customer's own device/data)
   │  on success, Paystack POSTs the charge.success event to
   │  POST /api/payments/webhook (HMAC-signature verified, not the
   │  WEBHOOK_SHARED_SECRET header the router's own webhook uses)
   ▼
paymentService.fulfillPayment() → createVoucherBatch(planKey, 1)
   │  Paystack also redirects the browser to /portal/buy/complete?reference=...
   ▼
/portal/buy/complete polls GET /api/payments/:reference until the webhook
has landed, then shows the voucher PIN.
```

**Setup:**
1. Get your secret + public keys from
   [dashboard.paystack.co/#/settings/developer](https://dashboard.paystack.co/#/settings/developer)
   and set `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` in `.env`.
   Leaving these blank disables the feature cleanly — `POST
   /api/payments/initialize` returns a clear error, nothing else breaks.
2. In that same dashboard page, register
   `https://<your-backend>/api/payments/webhook` as the webhook URL.
3. Only plans with `price_kobo > 0` are offered for sale — the frontend's
   `PortalBuy.tsx` filters on that.

**Important constraint — this is a self-data page, not a walled-garden one:**
`/portal/buy` is deliberately **not** designed to be opened by a device that's
still unauthenticated on the hotspot. Paystack's checkout can redirect
through arbitrary bank/3-D-Secure domains that can't be enumerated in a
RouterOS walled-garden rule (unlike `PortalLogin`/`PortalStatus`/etc., which
only ever need the one portal domain — see
`router-scripts/allow-portal-domain.rsc`). The expected path is: customer
opens `/portal/buy` on their own mobile data (a link, QR code, or the
"💳 Buy Voucher Online" button on `PortalLogin`/`PortalStatus`), completes
payment there, then brings the resulting PIN to the hotspot's actual login
page — same pattern the pre-existing WhatsApp/Telegram-bot buttons already
relied on, just self-service instead of manual.

## Multi-admin staff auth

Login (`POST /api/auth/login`) checks the `admins` table — bcrypt-hashed
passwords, not a single shared username/password pair. Flow:

- On first boot with an empty `admins` table, `adminService.ensureBootstrapAdmin()`
  (called once at startup in `index.ts`) seeds one row from
  `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`, so an existing single-admin
  setup keeps working unchanged after upgrading. It's a no-op forever after
  that — those two env vars are never read again.
- Any signed-in admin can add another from the dashboard's **Manage Staff**
  screen (`/staff` in the frontend repo), which calls `GET`/`POST
  /api/admins` (`routes/admins.ts`, behind the same `requireAdmin` JWT check
  as the rest of the dashboard). There's no separate "super admin" role yet
  — every account has equal access.

## Voucher expiry cron

`expiryService.ts` polls Postgres every 5 minutes (`startExpiryCron()`,
started once in `index.ts`) for vouchers where `expires_at` has passed but
`disabled` is still `false`, and calls `disableVoucher()` on each directly —
same DB-update-plus-router-disable path the dashboard's manual disable
button already uses. This replaces reliance on `expire-vouchers.rsc`'s
hourly on-router scheduler (up to ~59min lag past a plan's exact validity
window); the new lag ceiling is ~5min, and detection no longer depends on
the router's own scheduler running at all. Compares against the UTC date
(not Postgres's session-local `CURRENT_DATE`) to stay consistent with how
`voucherService.expiryDateString()` stamps `expires_at` in the first place.
A voucher that fails to disable (e.g. router unreachable) is simply retried
on the next tick — it stays `disabled=false` until a disable actually
succeeds.

## Dashboard failure visibility

Two additions so a RouterOS outage or a failed voucher sync gets noticed on
the dashboard instead of via a customer complaint:

- **Router health badge** — `routerHealthService.ts` polls `testConnection()`
  every 20s and broadcasts the result over the same socket the dashboard
  already holds open for live usage (`router:health` event). `GET
  /api/health` answers from that cache instead of testing live, so it stays
  cheap even while the router's down. The frontend's `useRouterHealth.ts` +
  `RouterHealthBadge.tsx` render it green/red in the dashboard header.
- **Unsynced-voucher alerts** — the frontend's `CreateVoucherForm` fires a
  toast immediately when a just-created voucher's `router_synced` comes
  back `false` from `POST /api/vouchers`. Its dashboard also shows a
  persistent amber banner listing *every* currently-enabled voucher with
  `router_synced=false`, not just ones from the latest batch — catches a
  failure that happened earlier and was never retried. There's no one-click
  "retry sync" endpoint yet; today the fix is to disable and recreate the
  voucher.

## Voucher search, filter, and export

- **Search/filter/sort** — `GET /api/vouchers?search=&planKey=&status=&sort=`,
  which `voucherService.listVouchers()` turns into one query with all three
  filters plus a computed `status` column (`active` / `not_synced` /
  `expired` / `disabled` — same expiry rule as `expiryService.ts`, so a
  dashboard badge and this filter can never disagree). This runs in
  Postgres rather than the dashboard fetching everything and filtering
  client-side — a search for one PIN finds it regardless of table size;
  only the unfiltered "browse everything" view is capped (`limit`, default
  200, max 1000).
- **Bulk creation** — `POST /api/vouchers` with `{planKey, qty}`, up to 500
  per call, each PIN checked for uniqueness against the database before
  being created (not auto-incrementing — sequential voucher codes would be
  guessable/enumerable, a real vulnerability for something that's
  effectively a bearer credential). CSV export and printing are entirely
  client-side (frontend's `lib/voucherExport.ts` / `PrintableVoucherBatch.tsx`)
  — no backend endpoint involved.

## Voucher recovery (no SMS/WhatsApp delivery yet)

There's no SMS or WhatsApp push after a successful payment — if a customer
closes `/portal/buy/complete` before copying their PIN down, it's gone
unless they can get it back some other way.

`GET /api/payments/lookup?email=` (`paymentService.lookupPaymentsByEmail()`)
matches case-insensitively against `payments.email` for `status='success'`
rows, most recent 10 first, backing the frontend's `/portal/recover` page.
Matched on email alone, no verification step — same "the PIN is the
credential" trust model as the rest of the portal, but someone who knows a
stranger's email could pull up their still-valid vouchers this way. Worth
knowing if this ever needs hardening.

Actual SMS/WhatsApp delivery is intentionally not built — out of scope for
now.

## Portal usage freshness

`POST /api/portal/usage/:pin/refresh` is the portal-facing counterpart to
the dashboard's admin-only `POST /api/usage/poll`, but scoped to just that
one PIN's session(s) and with no admin auth needed (same trust model as the
rest of `/api/portal`). Backs the frontend's "Updated Xs ago" label +
"↻ Refresh" button on `/portal/status`.

`usageService.refreshVoucherUsage()` guards the actual router round trip
with a 5s per-PIN cooldown (`lastManualRefreshAt`, in-memory) — this is the
one portal endpoint a customer can trigger that talks to RouterOS at all,
so it's worth not letting rapid taps hammer it. Inside the cooldown window,
or if the router call itself fails, it just falls back to whatever's
already in Postgres (which the router's own webhook keeps updating every
30s regardless) — the endpoint never errors, it just may not have anything
new to return yet.

## Known follow-ups (carried over from the static-portal audit)

- Premium (unlimited) plan usage display is still session-scoped only (resets on reconnect) since RouterOS never populates `remain-bytes-total` without a `limit-bytes-total` set — same underlying RouterOS limitation as before, not something a backend can work around.
