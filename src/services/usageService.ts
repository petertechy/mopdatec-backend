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
  // Voucher-level cumulative total (banked + current session) — NOT the raw
  // per-session bytes_in/bytes_out, which reset every time a session gets
  // recycled. See the usage_banked_bytes comment on the vouchers table.
  const bytesUsed = Number(r.usage_banked_bytes) + Number(r.usage_current_session_bytes);

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
 * Falls back to voucher/plan info with zero usage if no usage event has
 * landed yet (e.g. right after redemption, before the first webhook push).
 *
 * bytesUsed is the voucher's cumulative lifetime total (usage_banked_bytes +
 * usage_current_session_bytes, maintained by ingestUsageEvent) — NOT a raw
 * session snapshot, which would reset to near-zero on every reconnect.
 */
export async function getUsageForVoucher(pin: string): Promise<PortalUsage | null> {
  const voucherRes = await pool.query(
    `SELECT v.pin, v.disabled, v.expires_at, v.usage_banked_bytes, v.usage_current_session_bytes,
            v.usage_last_recorded_at, p.label, p.bytes_limit
     FROM vouchers v JOIN plans p ON p.key = v.plan_key
     WHERE v.pin = $1`,
    [pin],
  );
  if (voucherRes.rows.length === 0) return null;
  const v = voucherRes.rows[0];
  const bytesLimit = v.bytes_limit === null ? null : Number(v.bytes_limit);
  const bytesUsed = Number(v.usage_banked_bytes) + Number(v.usage_current_session_bytes);
  const recordedAt: string | null = v.usage_last_recorded_at;
  const hasActiveSession = recordedAt !== null && new Date(recordedAt).getTime() > Date.now() - 10 * 60 * 1000;

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
 * polling fallback), and returns the voucher's up-to-date CUMULATIVE usage
 * (not just this one event's raw numbers).
 *
 * RouterOS's own bytes-in/bytes-out on an active session are SESSION-scoped:
 * they start back at 0 every time that session gets recycled (WiFi drop,
 * phone sleep, manual logout+login with the same PIN) even though the
 * voucher's real lifetime usage hasn't reset at all. Reading those directly
 * as "bytesUsed" was the bug — a portal refresh right after a reconnect
 * would show almost nothing used, discarding every previous session's
 * total. The fix banks each session's final known total into
 * vouchers.usage_banked_bytes the moment a DIFFERENT session_id shows up
 * for the same voucher, so the running total survives reconnects:
 *
 *   same session_id as last time  -> just overwrite usage_current_session_bytes
 *                                     (RouterOS's own counter only grows within
 *                                     one session, so the latest reading IS
 *                                     the correct up-to-date value for it)
 *   new/different session_id      -> bank the OLD session's last known bytes
 *                                     into usage_banked_bytes first, THEN
 *                                     start tracking the new session_id
 *
 * True lifetime total is always usage_banked_bytes + usage_current_session_bytes
 * — that's what both getUsageForVoucher and getActiveUsage read.
 *
 * Also still writes the raw usage_snapshots row (history/audit — unchanged),
 * and if the cumulative total has now reached the plan's byte cap, triggers
 * the disable flow as a BACKUP enforcement path — the PRIMARY enforcement is
 * still RouterOS's own native limit-bytes-total (Issue 2 fix), which cuts
 * the connection at the packet level regardless of whether this webhook
 * call ever arrives, and which this cumulative total now actually matches
 * (the old session-only check could under-count usage right after a
 * reconnect and never fire at all).
 */
export async function ingestUsageEvent(event: IncomingUsageEvent): Promise<UsageRow | null> {
  const voucherRes = await pool.query(
    `SELECT v.pin, v.disabled, v.usage_banked_bytes, v.usage_current_session_id, v.usage_current_session_bytes,
            p.bytes_limit, p.label
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

  const rawSessionBytes = event.bytesIn + event.bytesOut;
  const isNewSession = voucher.usage_current_session_id !== null && voucher.usage_current_session_id !== event.sessionId;
  const bankedBytes = Number(voucher.usage_banked_bytes) + (isNewSession ? Number(voucher.usage_current_session_bytes) : 0);

  await pool.query(
    `UPDATE vouchers SET usage_banked_bytes = $1, usage_current_session_id = $2,
            usage_current_session_bytes = $3, usage_last_recorded_at = now()
     WHERE pin = $4`,
    [bankedBytes, event.sessionId, rawSessionBytes, event.user],
  );

  const bytesLimit = voucher.bytes_limit === null ? null : Number(voucher.bytes_limit);
  // bytesRemaining, when a caller ever supplies it, is already a router-side
  // TOTAL-remaining figure (not session-scoped) — takes priority over the
  // banked calc when present, though no current caller actually sends it.
  const bytesUsed =
    event.bytesRemaining != null && bytesLimit !== null
      ? Math.max(0, bytesLimit - event.bytesRemaining)
      : bankedBytes + rawSessionBytes;

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
