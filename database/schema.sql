-- MOPDATEC WI-FI — full-stack schema
-- Run once against a fresh PostgreSQL database (e.g. Render Postgres).

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL until an admin's sessions are explicitly revoked (lost device,
  -- offboarding — see adminService.revokeSessions()). A JWT is rejected by
  -- requireAdmin if it was issued (its `iat`) before this timestamp, so
  -- bumping it invalidates every token issued so far without waiting out
  -- the normal 12h expiry.
  token_valid_after TIMESTAMPTZ
);

-- Idempotent companion to the column above, for databases where this
-- schema.sql already ran once before token_valid_after existed — plain
-- CREATE TABLE IF NOT EXISTS skips an already-existing table entirely, so
-- re-running the file alone wouldn't add the column to those installs.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS token_valid_after TIMESTAMPTZ;

-- Who did what, for actions with real consequences (voucher batch
-- creation, voucher disable, new admin added, sessions revoked) — added
-- once more than one admin account existed, so "who did this" has an
-- answer beyond "someone with a shared password". Written by
-- services/auditService.ts; not a full audit of every read.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id             BIGSERIAL PRIMARY KEY,
  admin_username TEXT NOT NULL,
  action         TEXT NOT NULL, -- e.g. 'voucher_batch_created', 'voucher_disabled', 'admin_created', 'admin_sessions_revoked'
  details        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at DESC);

-- Mirrors plan-data.js from the original static-portal project.
-- This table is now the single source of truth; plan-data.js (still served
-- to login.html/status.html on the router) should be generated FROM this
-- table (see backend/src/services/planService.ts -> exportPlanDataJs()),
-- not maintained by hand in two places.
CREATE TABLE IF NOT EXISTS plans (
  key            TEXT PRIMARY KEY,        -- e.g. 'LS', 'standard', 'Trader Pass'
  prefix         TEXT UNIQUE NOT NULL,    -- e.g. 'LS-'
  label          TEXT NOT NULL,           -- e.g. 'Low Standard (3GB)'
  duration_label TEXT NOT NULL,           -- e.g. '1 Day Validity'
  chip_label     TEXT NOT NULL,
  profile        TEXT NOT NULL,           -- RouterOS /ip hotspot user profile name
  bytes_limit    BIGINT,                  -- NULL = unlimited (Premium)
  duration_days  INT NOT NULL,
  shared_users   INT NOT NULL DEFAULT 1,
  price_kobo     BIGINT NOT NULL DEFAULT 0, -- price in kobo (₦1 = 100 kobo); 0 = not for sale in-app
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vouchers (
  pin          TEXT PRIMARY KEY,          -- also the RouterOS hotspot username/password
  plan_key     TEXT NOT NULL REFERENCES plans(key),
  disabled     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,      -- full timestamp: exactly created_at + plan.duration_days,
                                           -- NOT rounded to a calendar date (see voucherService.expiryTimestamp)
  redeemed_at  TIMESTAMPTZ,               -- first successful login, NULL until then
  router_synced BOOLEAN NOT NULL DEFAULT false, -- true once the RouterOS API create call succeeded
  -- Lifetime usage tracking — see the "bank on session change" comment on
  -- usageService.ingestUsageEvent(). RouterOS's own bytes-in/bytes-out on an
  -- active session are SESSION-scoped and reset to 0 every time that session
  -- gets recycled (WiFi drop, phone sleep, manual logout+login) — reading
  -- those directly (the original bug) made total usage appear to reset on
  -- every reconnect. usage_banked_bytes holds everything from sessions that
  -- have already been superseded; usage_current_session_bytes holds the
  -- live count for whichever session_id is currently open. True lifetime
  -- total is always banked + current — never read either alone.
  usage_banked_bytes BIGINT NOT NULL DEFAULT 0,
  usage_current_session_id TEXT,
  usage_current_session_bytes BIGINT NOT NULL DEFAULT 0,
  usage_last_recorded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vouchers_plan_key ON vouchers(plan_key);
CREATE INDEX IF NOT EXISTS idx_vouchers_expires_at ON vouchers(expires_at);

-- latest_usage (defined further below) SELECTs v.expires_at, so on an
-- install where that view already exists, Postgres refuses to retype the
-- column underneath it ("cannot alter type of a column used by a view or
-- rule") — drop it first; the real CREATE VIEW below recreates it once
-- usage_snapshots (which it also SELECTs from) exists further down.
DROP VIEW IF EXISTS latest_usage;

-- Idempotent companion for installs where vouchers already existed with the
-- old DATE-only expires_at (see the column comment above) — CREATE TABLE IF
-- NOT EXISTS above is a no-op on those, so the widen has to happen here.
-- Existing rows keep their calendar date, now read back as that date's
-- midnight UTC; only newly-created vouchers get the real 24h-from-creation
-- timestamp via voucherService.expiryTimestamp().
ALTER TABLE vouchers ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz;

-- Same idempotent-migration need for the usage-tracking columns above, on
-- installs where vouchers already existed without them. Existing vouchers
-- start at banked=0/no current session — the very next webhook push picks
-- up their real in-progress session correctly (RouterOS's own session
-- counter hasn't reset just because we deployed), so only usage from
-- sessions that had *already ended* before this migration is unrecoverable.
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS usage_banked_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS usage_current_session_id TEXT;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS usage_current_session_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS usage_last_recorded_at TIMESTAMPTZ;

-- One row per usage push/poll per active session. Keyed by session_id (RouterOS's
-- internal .id for the active-session entry), NOT by IP — IPs get recycled by
-- DHCP when a session ends, so IP is kept only as a display field (see the
-- earlier audit note on this exact risk).
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  voucher_pin    TEXT NOT NULL REFERENCES vouchers(pin),
  session_id     TEXT NOT NULL,           -- RouterOS active-session .id, e.g. "*3A"
  ip_address     INET,
  bytes_in       BIGINT NOT NULL DEFAULT 0,
  bytes_out      BIGINT NOT NULL DEFAULT 0,
  bytes_remaining BIGINT,                 -- from $(remain-bytes-total) when available
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_voucher_pin ON usage_snapshots(voucher_pin);
CREATE INDEX IF NOT EXISTS idx_usage_session_id ON usage_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_recorded_at ON usage_snapshots(recorded_at DESC);

-- Convenience view: latest snapshot per active session (for its IP/IN-SESSION
-- freshness), joined to the VOUCHER's cumulative usage totals (not the raw
-- per-session bytes_in/bytes_out, which reset on reconnect — see the
-- usage_banked_bytes comment on the vouchers table) plus its plan.
-- This is what the dashboard's initial GET /api/usage/active reads from.
-- DROP first, not CREATE OR REPLACE: this redefinition removes columns
-- (bytes_in/bytes_out/bytes_remaining) that the live version already has,
-- and Postgres only allows OR REPLACE to append columns, never drop them.
DROP VIEW IF EXISTS latest_usage;
CREATE VIEW latest_usage AS
SELECT DISTINCT ON (us.session_id)
  us.session_id,
  us.voucher_pin,
  us.ip_address,
  us.recorded_at,
  v.plan_key,
  v.disabled,
  v.expires_at,
  v.usage_banked_bytes,
  v.usage_current_session_bytes,
  p.label       AS plan_label,
  p.bytes_limit AS plan_bytes_limit
FROM usage_snapshots us
JOIN vouchers v ON v.pin = us.voucher_pin
JOIN plans p    ON p.key = v.plan_key
ORDER BY us.session_id, us.recorded_at DESC;

-- One row per Paystack Standard Checkout transaction initiated from the
-- self-service portal buy page (frontend/src/pages/portal/PortalBuy.tsx).
-- A payment only produces a voucher once the webhook confirms charge.success
-- (see backend/src/services/paymentService.ts -> fulfillPayment()) — the
-- reference is created up front so the portal has something to poll while
-- the customer is still on Paystack's checkout page.
CREATE TABLE IF NOT EXISTS payments (
  id            BIGSERIAL PRIMARY KEY,
  reference     TEXT UNIQUE NOT NULL,     -- Paystack transaction reference
  plan_key      TEXT NOT NULL REFERENCES plans(key),
  email         TEXT NOT NULL,
  amount_kobo   BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  voucher_pin   TEXT REFERENCES vouchers(pin),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- Seed plan data (mirrors plan-data.js exactly — see original project audit).
INSERT INTO plans (key, prefix, label, duration_label, chip_label, profile, bytes_limit, duration_days, shared_users, price_kobo)
VALUES
  ('LS',           'LS-', 'Low Standard (3GB)',      '1 Day Validity',    'Low Standard (3GB - 1 Day)',    'LS',           3000000000,   1,  1, 50000),
  ('standard',     'ST-', 'Standard (6.5GB)',        '1 Day Validity',    'Standard (6.5GB - 1 Day)',      'standard',     6500000000,   1,  1, 100000),
  ('Trader Pass',  'TP-', 'Trader Pass (18.5GB)',     '3 Days Validity',   'Trader Pass (18.5GB - 3 Days)', 'Trader Pass',  18500000000,  3,  1, 300000),
  ('Pro Weekly',   'PW-', 'Pro Weekly (70GB)',        '7 Days (2 Users)',  'Pro Weekly (70GB - 7 Days)',    'Pro Weekly',   70000000000,  7,  2, 500000),
  ('Pro Monthly',  'PM-', 'Pro Monthly (150GB)',      '30 Days (3 Users)', 'Pro Monthly (150GB - 30 Days)', 'Pro Monthly',  150000000000, 30, 3, 2000000),
  ('Premium',      'PR-', 'Premium (Unlimited)',      '30 Days (5 Users)', 'Premium Unlimited (30 Days)',   'Premium',      NULL,         30, 5, 4000000)
ON CONFLICT (key) DO NOTHING;
