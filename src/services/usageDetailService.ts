import { pool } from "../db/pool";

export interface SnapshotRow {
  sessionId: string;
  ipAddress: string | null;
  bytesIn: number;
  bytesOut: number;
  recordedAt: string;
}

export interface UsageSession {
  sessionId: string;
  ipAddress: string | null;
  startedAt: string;
  endedAt: string;
  bytesIn: number;
  bytesOut: number;
  bytesTotal: number;
}

export interface TimelinePoint {
  at: string;
  cumulativeBytes: number;
}

const MAX_TIMELINE_POINTS = 300;

/**
 * Rebuilds per-session usage from raw usage_snapshots rows (oldest first).
 *
 * Tracks each router session_id independently, so a shared voucher with
 * several devices online at once (snapshots from device A and B interleaved)
 * isn't mistaken for constant session switching. A session_id's counter only
 * ever grows, so a LOWER reading under the same id means RouterOS reused the
 * id for a genuinely new connection (see the LS-E4MBY note in usageService)
 * and starts a new session entry.
 *
 * The running total is the sum of every session's latest reading, so it is
 * monotonic and never double-counts. Pure (no DB) so it's unit-testable.
 */
export function buildSessions(snapshots: SnapshotRow[]): { sessions: UsageSession[]; timeline: TimelinePoint[]; totalBytes: number } {
  const sessions: UsageSession[] = [];
  const timeline: TimelinePoint[] = [];
  const latestById = new Map<string, UsageSession>();
  let sum = 0;

  for (const s of snapshots) {
    const total = s.bytesIn + s.bytesOut;
    const cur = latestById.get(s.sessionId);
    if (!cur || total < cur.bytesTotal) {
      const created: UsageSession = {
        sessionId: s.sessionId,
        ipAddress: s.ipAddress,
        startedAt: s.recordedAt,
        endedAt: s.recordedAt,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
        bytesTotal: total,
      };
      sessions.push(created);
      latestById.set(s.sessionId, created);
      sum += total;
    } else {
      sum += total - cur.bytesTotal;
      cur.endedAt = s.recordedAt;
      cur.bytesIn = s.bytesIn;
      cur.bytesOut = s.bytesOut;
      cur.bytesTotal = total;
      cur.ipAddress = s.ipAddress ?? cur.ipAddress;
    }
    timeline.push({ at: s.recordedAt, cumulativeBytes: sum });
  }

  return { sessions, timeline: downsample(timeline), totalBytes: sum };
}

/** Keeps the first/last points and an even spread between, so the chart payload stays small. */
function downsample(points: TimelinePoint[]): TimelinePoint[] {
  if (points.length <= MAX_TIMELINE_POINTS) return points;
  const out: TimelinePoint[] = [];
  const step = (points.length - 1) / (MAX_TIMELINE_POINTS - 1);
  for (let i = 0; i < MAX_TIMELINE_POINTS; i++) out.push(points[Math.round(i * step)]);
  return out;
}

export interface VoucherUsageDetail {
  pin: string;
  planLabel: string;
  bytesLimit: number | null;
  /** Authoritative lifetime total kept on the voucher row (banked + current session). */
  bytesUsed: number;
  /** Total re-derived from the raw snapshots — a cross-check on bytesUsed. */
  snapshotTotalBytes: number;
  percentUsed: number | null;
  status: "active" | "disabled" | "expired" | "archived";
  disabled: boolean;
  disabledReason: "cap_reached" | "expired" | "manual" | null;
  disabledAt: string | null;
  disabledBy: string | null; // admin username, only for manual disables
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  lastSeenAt: string | null;
  snapshotCount: number;
  sessions: UsageSession[];
  timeline: TimelinePoint[];
}

/** Everything an admin needs to answer "I didn't use my data" — works for disabled and archived vouchers alike. Null if the PIN doesn't exist. */
export async function getVoucherUsageDetail(pin: string): Promise<VoucherUsageDetail | null> {
  const voucherRes = await pool.query(
    `SELECT v.pin, v.disabled, v.disabled_reason, v.disabled_at, v.created_at, v.expires_at,
            v.redeemed_at, v.archived_at, v.usage_banked_bytes, v.usage_current_session_bytes,
            v.usage_last_recorded_at, p.label, p.bytes_limit
     FROM vouchers v JOIN plans p ON p.key = v.plan_key
     WHERE v.pin = $1`,
    [pin],
  );
  if (voucherRes.rows.length === 0) return null;
  const v = voucherRes.rows[0];

  const snapRes = await pool.query(
    `SELECT session_id, host(ip_address) AS ip_address, bytes_in, bytes_out, recorded_at
     FROM usage_snapshots WHERE voucher_pin = $1 ORDER BY recorded_at ASC, id ASC`,
    [pin],
  );
  const { sessions, timeline, totalBytes } = buildSessions(
    snapRes.rows.map((r) => ({
      sessionId: r.session_id,
      ipAddress: r.ip_address,
      bytesIn: Number(r.bytes_in),
      bytesOut: Number(r.bytes_out),
      recordedAt: new Date(r.recorded_at).toISOString(),
    })),
  );

  let disabledBy: string | null = null;
  if (v.disabled && v.disabled_reason !== "cap_reached" && v.disabled_reason !== "expired") {
    const audit = await pool.query(
      `SELECT admin_username FROM admin_audit_log
       WHERE action = 'voucher_disabled' AND details->>'pin' = $1
       ORDER BY created_at DESC LIMIT 1`,
      [pin],
    );
    disabledBy = audit.rows[0]?.admin_username ?? null;
  }

  const bytesLimit = v.bytes_limit === null ? null : Number(v.bytes_limit);
  const bytesUsed = Number(v.usage_banked_bytes) + Number(v.usage_current_session_bytes);
  const status = v.archived_at
    ? "archived"
    : v.disabled
      ? "disabled"
      : new Date(v.expires_at).getTime() <= Date.now()
        ? "expired"
        : "active";

  return {
    pin: v.pin,
    planLabel: v.label,
    bytesLimit,
    bytesUsed,
    snapshotTotalBytes: totalBytes,
    percentUsed: bytesLimit === null ? null : Math.min(100, Math.round((bytesUsed / bytesLimit) * 100)),
    status,
    disabled: v.disabled,
    disabledReason: v.disabled ? v.disabled_reason : null,
    disabledAt: v.disabled_at,
    disabledBy,
    createdAt: v.created_at,
    expiresAt: v.expires_at,
    redeemedAt: v.redeemed_at,
    lastSeenAt: v.usage_last_recorded_at,
    snapshotCount: snapRes.rows.length,
    sessions,
    timeline,
  };
}
