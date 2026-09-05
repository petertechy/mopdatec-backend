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
Edit `$webhookUrl` and `$secret` inside that script first (must match your backend's deployed URL and `WEBHOOK_SHARED_SECRET`).

The original static-portal project referenced five other one-time setup
scripts; none shipped in this repo, so here's what actually still applies
for a fresh install (none of this applies if you're migrating from an
already-running static-portal deployment — that's a different, not-yet-
written script, since it depends on that system's exact existing data):

- **`create-hotspot-profiles.rsc`** — rewritten from scratch in this repo,
  based on the `plans` table's actual seed data. Creates the six hotspot
  user profiles (`LS`, `standard`, `Trader Pass`, `Pro Weekly`,
  `Pro Monthly`, `Premium`) that voucher creation references by name —
  **required**, RouterOS rejects creating a hotspot user against a profile
  that doesn't exist. Written without live router access this session —
  verify it in a WinBox terminal before trusting it against real vouchers.
- **`verify-captive-portal.rsc`** — also rewritten, as a **diagnostic**
  rather than an auto-fix (no live router access to safely test a blind
  firewall/DNS mutation against). Checks for the three most common causes
  of "popup doesn't trigger": missing DNS/HTTP redirect NAT rules, and a
  walled-garden entry accidentally allowing an OS's own captive-portal
  canary-check domain through untouched. If it flags something, the usual
  real fix on an incomplete setup is just re-running RouterOS's own
  `/ip hotspot setup` wizard, which configures both correctly.
- **`sync-profile-scripts.rsc`** and **`expire-vouchers.rsc`** — not
  needed. Both addressed whatever the old system did at the hotspot-profile
  level for data-cap enforcement and expiry; this backend now sets
  `limit-bytes-total` directly per-voucher at creation time (see Issue 2 in
  the table above) and runs its own expiry cron (`expiryService.ts`)
  instead.
- **`migrate-legacy-vouchers.rsc`** — not needed for a fresh install
  (nothing pre-existing to migrate).

Also make sure the RouterOS **API service** is enabled (it's off by default on some configs):
```
/ip service enable api
```
For anything reachable over the public internet, use `api-ssl` (port 8729) instead and set `ROUTEROS_TLS=true` in `.env`, not the plaintext `api` service.

## Deployment

### Backend → VPS + WireGuard (recommended — see deploy/DEPLOY.md)
Full step-by-step runbook in [`deploy/DEPLOY.md`](deploy/DEPLOY.md): a
plain Ubuntu VPS (systemd + Caddy for automatic HTTPS) running the backend,
connected to the router over a WireGuard tunnel
(`router-scripts/setup-wireguard-vps-tunnel.rsc`) rather than a public
port-forward. Postgres stays on a separate managed host (Render/Neon/
Supabase) — the VPS only runs the Node process. Chosen over a plain
PaaS (Render/etc.) specifically because:
- A VPS has a static IP by default, so the router's firewall can allow
  exactly one address instead of the whole internet — most PaaS platforms'
  standard tiers don't give you a static outbound IP without a paid add-on.
- The WireGuard tunnel means the RouterOS API is never exposed to the
  public internet at all, and it works even if the router is behind
  ISP-side CGNAT with no real public IP (the router initiates the tunnel
  outbound) — a plain port-forward silently doesn't work in that case.

### Backend + Postgres → Render (simpler, if router exposure is acceptable)
Still valid if you'd rather not run your own VPS and are OK with the
router-exposure trade-off documented below.
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
This backend needs a direct network path to the router's RouterOS API port (8728/8729) — this only works if the router has a public IP/reachable port-forward, or you run the backend on a network that can reach the router directly (e.g. same LAN, VPN, or a small VPS at the same site as the router). Render is a fully public-internet host with no static outbound IP on standard tiers, so a Render deployment means either opening that port to the whole internet (protected only by RouterOS credentials + `api-ssl` TLS — use a strong, unique `ROUTEROS_PASSWORD` if you go this route) or paying for Render's static-IP add-on so you can scope the firewall rule to just that address. The VPS + WireGuard path above avoids this trade-off entirely.

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
the router's own scheduler running at all. `expires_at` is a real
`TIMESTAMPTZ` — stamped as exactly `created_at + plan.duration_days` by
`voucherService.expiryTimestamp()`, not rounded down to a calendar date — so
a voucher bought at 8pm for a "1 day" plan actually gets a full 24 hours,
not just until the next midnight. The cron's own check is a plain
`expires_at <= now()` comparison against that same timestamp.
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

## Login rate limiting

`services/loginThrottle.ts` locks out a username for 15 minutes after 5
failed `POST /api/auth/login` attempts within a 15-minute window — in-memory,
per-username (not per-IP, to avoid one shared office network's mistyped
password locking out everyone behind that IP). Checked *before* the
password is even compared, so a locked-out username gets the same `429`
regardless of whether the password would've been right. Resets on a
successful login, or naturally after the lockout window passes. Like the
other in-memory timers in this codebase (expiry cron, router health), state
resets on a process restart — an accepted trade-off, not a persistent
lockout store.

## Audit log + session revocation

Added once more than one admin account existed, so two things that a
shared single password never needed have answers now:

- **"Who did that?"** — `services/auditService.ts`'s `logAction()` records
  every `voucher_batch_created`, `voucher_disabled` (only when triggered by
  an admin via the dashboard — the expiry cron and usage-cap backup
  enforcement also call the same underlying `disableVoucher()`, but
  deliberately aren't logged as an admin action), `admin_created`, and
  `admin_sessions_revoked` event, with who did it and the relevant details
  as JSON. `GET /api/admins/audit-log?limit=` reads it back, most recent
  first; the dashboard's Manage Staff screen shows the last 20 as "Recent
  Activity". A failed audit write is logged but never blocks the action
  itself.
- **"Kill that session"** — `admins.token_valid_after` (NULL until set) is
  checked on every authenticated request (`requireAdmin` in
  `middleware/auth.ts`): a JWT is rejected if it was issued (its `iat`)
  before that timestamp. `POST /api/admins/:id/revoke-sessions`
  (`adminService.revokeSessions()`) sets it to `now()`, instantly
  invalidating every token issued for that admin so far — the fix for a
  lost staff laptop or someone being let go, instead of waiting out the
  normal 12h JWT expiry. That admin's *next* login still works fine (a
  fresh token has a later `iat`). Costs one extra indexed lookup per
  authenticated request; fails closed (503, not silently-allowed) if that
  lookup itself errors.

## Backend test suite

`npm test` (vitest) covers the trickiest logic added this round — not a
full suite, but a real one:

- `tests/loginThrottle.test.ts` — the rate-limiter above, in isolation.
- `tests/paymentWebhookSignature.test.ts` — Paystack HMAC signature
  verification (valid, tampered, garbage, and missing signature/body);
  skips itself cleanly if `PAYSTACK_SECRET_KEY` isn't set, same as the
  feature it's testing.
- `tests/expiryService.test.ts` and `tests/voucherServiceFilters.test.ts` —
  real integration tests against whichever Postgres `DATABASE_URL` points
  at (the same DB the app runs against locally), seeding distinctively-
  prefixed rows and cleaning them up in `afterAll`. These test the actual
  SQL (date-boundary comparison, computed `status`, search/filter/sort),
  not a mock of it.

`npm run typecheck` runs `tsc --noEmit` over both `src/` and `tests/` (a
separate `tsconfig.test.json`, since `tests/` is intentionally excluded
from the build's own `tsconfig.json` — test files never get compiled into
`dist/`).

## Dashboard overview stats

`GET /api/stats/overview` (`services/statsService.ts`) backs the admin
dashboard's Overview page stat cards — total vouchers, a status breakdown,
vouchers created today, active sessions, and revenue (today + all-time,
from `payments` where `status='success'`). Real Postgres aggregates
(`COUNT`/`SUM`, run in parallel), not derived from whatever page of
results the voucher list happens to have fetched client-side — that's
capped (see `voucherService.listVouchers`'s `limit`) and would silently
undercount once there are more vouchers than one page. The status
breakdown uses the same `CASE` expression as `listVouchers` — kept in sync
by hand, since it's the one other place that logic exists.

## Analytics page

`GET /api/stats/analytics?days=` (`statsService.getAnalyticsStats()`) backs
the dashboard's Analytics page — revenue and voucher-creation trends
(gap-filled per day via `generate_series`, so a zero-activity day is a real
0 point, never a silently skipped one), a per-plan breakdown (voucher
count + revenue), and a redemption rate, all scoped to the same `days`
window so every number on the page agrees with every other. `voucher_counts`
and `plan_revenue` are computed as separate CTEs rather than one multi-join
— joining vouchers AND payments to `plans` in a single query would fan out
(N vouchers × M payments per plan) and silently inflate both counts.

## Known follow-ups (carried over from the static-portal audit)

- Premium (unlimited) plan usage display is still session-scoped only (resets on reconnect) since RouterOS never populates `remain-bytes-total` without a `limit-bytes-total` set — same underlying RouterOS limitation as before, not something a backend can work around.
