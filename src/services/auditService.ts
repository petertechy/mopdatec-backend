import { pool } from "../db/pool";

export interface AuditLogEntry {
  id: number;
  adminUsername: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Fire-and-forget audit trail for actions with real consequences — added
 * once more than one admin account existed, so "who disabled this voucher /
 * created 500 free ones / added a new admin" has an answer beyond "someone
 * with a shared password". A failed write is logged but never thrown —
 * recording history must never block the actual action it's recording.
 */
export async function logAction(
  adminUsername: string,
  action: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_username, action, details) VALUES ($1, $2, $3)`,
      [adminUsername, action, details ? JSON.stringify(details) : null],
    );
  } catch (err: any) {
    console.error(`[auditService] failed to log action "${action}" by ${adminUsername}:`, err?.message || err);
  }
}

export async function listRecentAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  const { rows } = await pool.query(
    `SELECT id, admin_username, action, details, created_at
     FROM admin_audit_log ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    id: r.id,
    adminUsername: r.admin_username,
    action: r.action,
    details: r.details,
    createdAt: r.created_at,
  }));
}
