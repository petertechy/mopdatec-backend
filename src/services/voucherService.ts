import { pool } from "../db/pool";
import { getPlan } from "./planService";
import { createHotspotUser, disableVoucherEverywhere } from "../routeros/client";

// Excludes visually-ambiguous characters (0/O, 1/I/L) — same charset choice
// as the original admin.html generator, kept for printed-voucher legibility.
const PIN_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PIN_CODE_LENGTH = 5;

function randomCode(): string {
  let out = "";
  for (let i = 0; i < PIN_CODE_LENGTH; i++) {
    out += PIN_CHARS.charAt(Math.floor(Math.random() * PIN_CHARS.length));
  }
  return out;
}

/**
 * Fixes audit finding #3: the original client-side generator had no
 * uniqueness check, in-batch or against the router. Here we check against
 * the vouchers table (the durable system of record) on every attempt, so a
 * collision — either against an already-issued voucher or another PIN
 * generated earlier in the same batch — is retried rather than silently
 * shipped on a printed card.
 */
async function generateUniquePin(prefix: string): Promise<string> {
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pin = prefix + randomCode();
    const { rows } = await pool.query("SELECT 1 FROM vouchers WHERE pin = $1", [pin]);
    if (rows.length === 0) return pin;
  }
  throw new Error(`Could not generate a unique PIN for prefix "${prefix}" after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Real 24h-per-day expiry, measured from the exact moment of creation — NOT
 * rounded down to a calendar date. The old version stamped only a YYYY-MM-DD
 * date, which meant a voucher bought at 8pm for a "1 day" plan expired at
 * the next midnight (~4 hours later), while one bought at 1am got nearly 47
 * hours — both wrong. This gives every voucher its full nominal duration
 * regardless of what time of day it was created.
 */
function expiryTimestamp(durationDays: number): string {
  return new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
}

export interface CreatedVoucher {
  pin: string;
  planKey: string;
  expiresAt: string;
  routerSynced: boolean;
  routerError?: string;
}

/**
 * Creates `qty` vouchers for a plan: unique PIN, DB row, then the RouterOS
 * API call that both creates AND enables the hotspot user in one step
 * (Issue 5), with limit-bytes-total set natively (Issue 2's real fix — this
 * is enforced by the router per-packet, not by anything polling afterward).
 *
 * Router calls happen sequentially and are individually fault-tolerant: if
 * one fails (e.g. transient connection drop), that voucher is still saved to
 * the DB with router_synced=false so it can be retried, instead of the whole
 * batch aborting and leaving printed/undefined state.
 */
export async function createVoucherBatch(planKey: string, qty: number): Promise<CreatedVoucher[]> {
  const plan = await getPlan(planKey);
  if (!plan) throw new Error(`Unknown plan key: ${planKey}`);
  if (qty < 1 || qty > 500) throw new Error("qty must be between 1 and 500");

  const results: CreatedVoucher[] = [];

  for (let i = 0; i < qty; i++) {
    const pin = await generateUniquePin(plan.prefix);
    const expiresAt = expiryTimestamp(plan.durationDays);

    await pool.query(
      `INSERT INTO vouchers (pin, plan_key, expires_at, router_synced) VALUES ($1, $2, $3, false)`,
      [pin, plan.key, expiresAt],
    );

    let routerSynced = false;
    let routerError: string | undefined;
    try {
      await createHotspotUser({
        pin,
        profile: plan.profile,
        bytesLimit: plan.bytesLimit,
        expiresAt,
      });
      routerSynced = true;
      await pool.query("UPDATE vouchers SET router_synced = true WHERE pin = $1", [pin]);
    } catch (err: any) {
      routerError = err?.message || "unknown RouterOS API error";
      console.error(`[voucherService] router create failed for ${pin}:`, routerError);
    }

    results.push({ pin, planKey: plan.key, expiresAt, routerSynced, routerError });
  }

  return results;
}

export type VoucherStatus = "active" | "not_synced" | "expired" | "disabled";

export interface VoucherWithPlan {
  pin: string;
  planKey: string;
  planLabel: string;
  disabled: boolean;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  routerSynced: boolean;
  status: VoucherStatus;
}

export interface ListVouchersOptions {
  search?: string; // matched against pin, case-insensitive substring
  planKey?: string;
  status?: VoucherStatus;
  sort?: "asc" | "desc"; // by created_at; default desc (newest first)
  limit?: number;
}

/**
 * Search/filter/sort all live in this one query rather than the dashboard
 * fetching everything and filtering client-side (Issue: "becomes unusable
 * past a few hundred vouchers" once VoucherList.tsx has to render/scan the
 * whole table itself). `status` is computed here — same expiry rule
 * expiryService.ts uses (a direct timestamp comparison against `now()`, now
 * that expires_at is a real TIMESTAMPTZ rather than a calendar date) — so
 * the badge in VoucherList and the filter dropdown can never disagree with
 * each other.
 *
 * The outer WHERE against an aliased subquery (rather than repeating the
 * CASE expression) is just so `status` filtering can reference the
 * computed column instead of duplicating the expiry logic a second time.
 */
export async function listVouchers(opts: ListVouchersOptions = {}): Promise<VoucherWithPlan[]> {
  const { search, planKey, status, sort = "desc", limit = 200 } = opts;
  const sortSql = sort === "asc" ? "ASC" : "DESC"; // whitelisted, not interpolated from raw input

  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT v.pin, v.plan_key, p.label AS plan_label, v.disabled, v.created_at,
              v.expires_at, v.redeemed_at, v.router_synced,
              CASE
                WHEN v.disabled THEN 'disabled'
                WHEN v.expires_at <= now() THEN 'expired'
                WHEN NOT v.router_synced THEN 'not_synced'
                ELSE 'active'
              END AS status
       FROM vouchers v JOIN plans p ON p.key = v.plan_key
     ) sub
     WHERE ($1::text IS NULL OR sub.pin ILIKE '%' || $1 || '%')
       AND ($2::text IS NULL OR sub.plan_key = $2)
       AND ($3::text IS NULL OR sub.status = $3)
     ORDER BY sub.created_at ${sortSql}
     LIMIT $4`,
    [search || null, planKey || null, status || null, Math.min(limit, 1000)],
  );
  return rows.map((r) => ({
    pin: r.pin,
    planKey: r.plan_key,
    planLabel: r.plan_label,
    disabled: r.disabled,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    redeemedAt: r.redeemed_at,
    routerSynced: r.router_synced,
    status: r.status,
  }));
}

/** Issue 4: bulk-disable every session under one voucher PIN, both steps, on the router AND in the DB. */
export async function disableVoucher(pin: string): Promise<{ sessionsRemoved: number }> {
  const result = await disableVoucherEverywhere(pin);
  await pool.query("UPDATE vouchers SET disabled = true WHERE pin = $1", [pin]);
  return result;
}
