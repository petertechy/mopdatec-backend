import { pool } from "../db/pool";
import { disableVoucher } from "./voucherService";
import { listActiveSessions } from "../routeros/client";

export interface IncomingUsageEvent {
  user: string; // voucher PIN
  sessionId: string;
  address: string;
  bytesIn: number;
  bytesOut: number;
  bytesRemaining?: number | null;
}

export interface UsageRow {
  sessionId: string;
  voucherPin: string;
  ipAddress: string;
  bytesUsed: number;
  bytesLimit: number | null;
  percentUsed: number | null; // null for unlimited plans
  planLabel: string;
  disabled: boolean;
  recordedAt: string;
}

function mapLatestUsageRow(r: any): UsageRow {
  const bytesLimit = r.plan_bytes_limit === null ? null : Number(r.plan_bytes_limit);
  const bytesUsed =
    r.bytes_remaining !== null && bytesLimit !== null
      ? Math.max(0, bytesLimit - Number(r.bytes_remaining))
      : Number(r.bytes_in) + Number(r.bytes_out);

  return {
    sessionId: r.session_id,
    voucherPin: r.voucher_pin,
    ipAddress: r.ip_address,
    bytesUsed,
    bytesLimit,
    percentUsed: bytesLimit === null ? null : Math.min(100, Math.round((bytesUsed / bytesLimit) * 100)),
    planLabel: r.plan_label,
    disabled: r.disabled,
    recordedAt: r.recorded_at,
  };
}

export async function getActiveUsage(): Promise<UsageRow[]> {
  const { rows } = await pool.query(
    "SELECT * FROM latest_usage WHERE recorded_at > now() - interval '10 minutes' ORDER BY recorded_at DESC",
  );
  return rows.map(mapLatestUsageRow);
}

export interface PortalUsage {
  pin: string;
  planLabel: string;
  bytesUsed: number;
  bytesLimit: number | null;
  percentUsed: number | null;
  disabled: boolean;
  expiresAt: string;
  hasActiveSession: boolean;
  recordedAt: string | null; // when the last usage snapshot landed — powers the "updated Xs ago" label
}

/**
 * Powers the external portal status page (frontend/src/pages/portal/PortalStatus.tsx).
 * Unlike RouterOS's own status.html, this isn't scoped to "the device currently
 * making this request" — it looks up by PIN directly, since the PIN is already
 * the sole credential in this system (same trust model as router login itself).
 * Falls back to voucher/plan info with zero usage if no session snapshot has
 * landed yet (e.g. right after redemption, before the first webhook push).
 */
export async function getUsageForVoucher(pin: string): Promise<PortalUsage | null> {
  const voucherRes = await pool.query(
    `SELECT v.pin, v.disabled, v.expires_at, p.label, p.bytes_limit
     FROM vouchers v JOIN plans p ON p.key = v.plan_key
     WHERE v.pin = $1`,
    [pin],
  );
  if (voucherRes.rows.length === 0) return null;
  const v = voucherRes.rows[0];
  const bytesLimit = v.bytes_limit === null ? null : Number(v.bytes_limit);

  const snapRes = await pool.query(
    `SELECT bytes_in, bytes_out, bytes_remaining, recorded_at FROM usage_snapshots
     WHERE voucher_pin = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [pin],
  );

  let bytesUsed = 0;
  let hasActiveSession = false;
  let recordedAt: string | null = null;
  if (snapRes.rows.length > 0) {
    const s = snapRes.rows[0];
    hasActiveSession = new Date(s.recorded_at).getTime() > Date.now() - 10 * 60 * 1000;
    recordedAt = s.recorded_at;
    bytesUsed =
      s.bytes_remaining != null && bytesLimit !== null
        ? Math.max(0, bytesLimit - Number(s.bytes_remaining))
        : Number(s.bytes_in) + Number(s.bytes_out);
  }

  return {
    pin: v.pin,
    planLabel: v.label,
    bytesUsed,
    bytesLimit,
    percentUsed: bytesLimit === null ? null : Math.min(100, Math.round((bytesUsed / bytesLimit) * 100)),
    disabled: v.disabled,
    expiresAt: v.expires_at,
    hasActiveSession,
    recordedAt,
  };
}

const REFRESH_COOLDOWN_MS = 5000;
const lastManualRefreshAt = new Map<string, number>();

/**
 * Powers PortalStatus's manual "Refresh" button — the portal-facing version
 * of the dashboard's existing "Poll router now" (POST /api/usage/poll), but
 * scoped to one voucher's own session(s) rather than admin-gated and
 * global. Polls the router for just this PIN's active sessions (one API
 * call regardless of how many other sessions exist — same call the admin
 * poll makes, just filtered), ingests them, then returns the updated
 * snapshot the same shape as getUsageForVoucher.
 *
 * A per-PIN cooldown guards the router round trip specifically — this is
 * the one portal endpoint a customer can trigger that actually talks to
 * RouterOS, so it's worth not letting rapid double-taps hammer it. Within
 * the cooldown window this just re-reads whatever's already in Postgres
 * (which the router's own webhook keeps updating every 30s regardless) —
 * never an error, so the button never needs special-case failure handling.
 */
export async function refreshVoucherUsage(pin: string): Promise<PortalUsage | null> {
  const now = Date.now();
  const last = lastManualRefreshAt.get(pin) || 0;

  if (now - last >= REFRESH_COOLDOWN_MS) {
    lastManualRefreshAt.set(pin, now);
    try {
      const sessions = await listActiveSessions();
      for (const session of sessions.filter((s) => s.user === pin)) {
        await ingestUsageEvent({
          user: session.user,
          sessionId: session.sessionId,
          address: session.address,
          bytesIn: session.bytesIn,
          bytesOut: session.bytesOut,
        });
      }
    } catch (err: any) {
      // Router unreachable etc. — fall through and return whatever's
      // already in Postgres rather than erroring the button out.
      console.error(`[usageService] manual refresh poll failed for ${pin}:`, err?.message || err);
    }
  }

  return getUsageForVoucher(pin);
}

/** Stamps first-login time — called by the portal login page right after it posts to the router. */
export async function markRedeemed(pin: string): Promise<void> {
  await pool.query(
    "UPDATE vouchers SET redeemed_at = now() WHERE pin = $1 AND redeemed_at IS NULL",
    [pin],
  );
}

/**
 * Ingests one usage event from the router's webhook push (or the manual
 * polling fallback). Writes the snapshot, and if the voucher's plan has a
 * byte cap that's been reached, triggers the disable flow immediately as a
 * BACKUP enforcement path — the PRIMARY enforcement is still RouterOS's own
 * native limit-bytes-total (Issue 2 fix), which cuts the connection at the
 * packet level regardless of whether this webhook call ever arrives.
 */
export async function ingestUsageEvent(event: IncomingUsageEvent): Promise<UsageRow | null> {
  const voucherRes = await pool.query(
    `SELECT v.pin, v.disabled, p.bytes_limit, p.label
     FROM vouchers v JOIN plans p ON p.key = v.plan_key
     WHERE v.pin = $1`,
    [event.user],
  );
  if (voucherRes.rows.length === 0) {
    console.warn(`[usageService] webhook usage event for unknown voucher: ${event.user}`);
    return null;
  }
  const voucher = voucherRes.rows[0];

  await pool.query(
    `INSERT INTO usage_snapshots (voucher_pin, session_id, ip_address, bytes_in, bytes_out, bytes_remaining)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [event.user, event.sessionId, event.address, event.bytesIn, event.bytesOut, event.bytesRemaining ?? null],
  );

  const bytesLimit = voucher.bytes_limit === null ? null : Number(voucher.bytes_limit);
  const bytesUsed =
    event.bytesRemaining != null && bytesLimit !== null
      ? Math.max(0, bytesLimit - event.bytesRemaining)
      : event.bytesIn + event.bytesOut;

  if (!voucher.disabled && bytesLimit !== null && bytesUsed >= bytesLimit) {
    console.log(`[usageService] voucher ${event.user} reached its cap — disabling (backup enforcement)`);
    await disableVoucher(event.user).catch((err) =>
      console.error(`[usageService] backup disable failed for ${event.user}:`, err.message),
    );
  }

  return {
    sessionId: event.sessionId,
    voucherPin: event.user,
    ipAddress: event.address,
    bytesUsed,
    bytesLimit,
    percentUsed: bytesLimit === null ? null : Math.min(100, Math.round((bytesUsed / bytesLimit) * 100)),
    planLabel: voucher.label,
    disabled: voucher.disabled || bytesUsed >= (bytesLimit ?? Infinity),
    recordedAt: new Date().toISOString(),
  };
}
