import { pool } from "../db/pool";
import { disableVoucher } from "./voucherService";
import { getVoucherUsageFromRouter } from "../routeros/client";
import { getIO } from "../sockets/io";
import { notifyDataUsage } from "./pushService";

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
 * usage_current_session_bytes, maintained by syncUsageFromRouter) — NOT a raw
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
 * not admin-gated. Re-syncs usage from the router, then returns the updated
 * snapshot the same shape as getUsageForVoucher.
 *
 * A global cooldown per PIN guards the router round trip specifically — this
 * is the one portal endpoint a customer can trigger that actually talks to
 * RouterOS, so it's worth not letting rapid double-taps hammer it. Within
 * the cooldown window this just re-reads whatever's already in Postgres
 * (which the background poller keeps updating regardless) — never an error,
 * so the button never needs special-case failure handling.
 */
export async function refreshVoucherUsage(pin: string): Promise<PortalUsage | null> {
  const now = Date.now();
  const last = lastManualRefreshAt.get(pin) || 0;

  if (now - last >= REFRESH_COOLDOWN_MS) {
    lastManualRefreshAt.set(pin, now);
    try {
      await syncUsageFromRouter();
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

let syncInFlight: Promise<UsageRow[]> | null = null;

/**
 * Router-authoritative usage sync. Replaces the old per-event "banking" logic,
 * which double-counted whenever a shared voucher had 2+ devices online at once
 * (each device's push looked like a "new session" and re-banked the other's
 * running total). Here nothing is accumulated: every run recomputes
 *   usage_banked_bytes          = the router's hotspot-user total (ended sessions)
 *   usage_current_session_bytes = sum of ALL live sessions for that PIN
 * which is exactly what RouterOS's own limit-bytes-total check uses.
 * Concurrent callers share one run.
 */
export function syncUsageFromRouter(): Promise<UsageRow[]> {
  if (!syncInFlight) {
    syncInFlight = doSync().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

async function doSync(): Promise<UsageRow[]> {
  const routerUsage = await getVoucherUsageFromRouter();
  const pins = [...routerUsage.keys()];
  if (pins.length === 0) return [];

  const { rows: vouchers } = await pool.query(
    `SELECT v.pin, v.disabled, v.usage_banked_bytes, v.usage_current_session_bytes,
            p.bytes_limit, p.label
     FROM vouchers v JOIN plans p ON p.key = v.plan_key
     WHERE v.pin = ANY($1)`,
    [pins],
  );

  const results: UsageRow[] = [];
  for (const v of vouchers) {
    const ru = routerUsage.get(v.pin)!;
    const liveBytes = ru.sessions.reduce((sum, s) => sum + s.bytesIn + s.bytesOut, 0);
    const unchanged =
      Number(v.usage_banked_bytes) === ru.closedBytes &&
      Number(v.usage_current_session_bytes) === liveBytes;
    if (unchanged && ru.sessions.length === 0) continue;

    for (const s of ru.sessions) {
      await pool.query(
        `INSERT INTO usage_snapshots (voucher_pin, session_id, ip_address, bytes_in, bytes_out, bytes_remaining)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [v.pin, s.sessionId, s.address, s.bytesIn, s.bytesOut],
      );
    }
    await pool.query(
      `UPDATE vouchers
       SET usage_banked_bytes = $1, usage_current_session_bytes = $2, usage_current_session_id = $3,
           usage_last_recorded_at = CASE WHEN $5::boolean THEN now() ELSE usage_last_recorded_at END
       WHERE pin = $4`,
      [ru.closedBytes, liveBytes, ru.sessions[0]?.sessionId ?? null, v.pin, ru.sessions.length > 0],
    );

    const bytesLimit = v.bytes_limit === null ? null : Number(v.bytes_limit);
    const bytesUsed = ru.closedBytes + liveBytes;
    const overCap = bytesLimit !== null && bytesUsed >= bytesLimit;
    if (!v.disabled && overCap) {
      console.log(`[usageService] voucher ${v.pin} reached its cap - disabling (backup enforcement)`);
      await disableVoucher(v.pin, "cap_reached").catch((err) =>
        console.error(`[usageService] backup disable failed for ${v.pin}:`, err.message),
      );
    }

    // Customer push alerts at 20/10/5% left — fire-and-forget so a slow push
    // service can never delay the sync (or the cap enforcement above).
    if (bytesLimit !== null) {
      notifyDataUsage(v.pin, bytesUsed, bytesLimit, v.label).catch((err) =>
        console.error(`[usageService] push alert failed for ${v.pin}:`, err?.message || err),
      );
    }

    for (const s of ru.sessions) {
      results.push({
        sessionId: s.sessionId,
        voucherPin: v.pin,
        ipAddress: s.address,
        bytesUsed,
        bytesLimit,
        percentUsed: bytesLimit === null ? null : Math.min(100, Math.round((bytesUsed / bytesLimit) * 100)),
        planLabel: v.label,
        disabled: v.disabled || overCap,
        recordedAt: new Date().toISOString(),
      });
    }
  }
  return results;
}

const USAGE_POLL_INTERVAL_MS = 20_000;
let usagePollTimer: NodeJS.Timeout | null = null;

/**
 * Background poller — keeps Postgres (and connected dashboards) within
 * USAGE_POLL_INTERVAL_MS of the router's real numbers at all times, instead
 * of only updating when an admin clicks "Poll router now" or a webhook
 * fires. Foundation for near-real-time cap enforcement on MAC-based
 * auto-login (shared vouchers) — without this running continuously, a
 * device's live allowance can drift stale between manual pokes.
 */
export function startUsagePoller(): void {
  if (usagePollTimer) return; // already running — safe to call more than once
  usagePollTimer = setInterval(async () => {
    try {
      const results = await syncUsageFromRouter();
      if (results.length > 0) {
        getIO().emit("usage:bulk-update", results);
      }
    } catch (err: any) {
      console.error("[usageService] background poll failed:", err?.message || err);
    }
  }, USAGE_POLL_INTERVAL_MS);
  console.log(`[usageService] background usage poller started (every ${USAGE_POLL_INTERVAL_MS / 1000}s)`);
}
