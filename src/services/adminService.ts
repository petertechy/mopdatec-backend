import bcrypt from "bcryptjs";
import { pool } from "../db/pool";
import { env } from "../config/env";

const SALT_ROUNDS = 12;

export interface Admin {
  id: number;
  username: string;
  createdAt: string;
}

interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

function toAdmin(row: AdminRow): Admin {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

/** Used by routes/auth.ts's login handler — includes the hash, unlike everything else here. */
export async function findAdminByUsername(username: string): Promise<AdminRow | null> {
  const { rows } = await pool.query<AdminRow>("SELECT * FROM admins WHERE username = $1", [username]);
  return rows[0] || null;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function listAdmins(): Promise<Admin[]> {
  const { rows } = await pool.query<AdminRow>("SELECT * FROM admins ORDER BY created_at ASC");
  return rows.map(toAdmin);
}

/**
 * Called from routes/admins.ts, behind requireAdmin — any signed-in staff
 * member can add another. Throws a plain message on a duplicate username
 * (admins.username is UNIQUE) so the route can surface it directly.
 */
export async function createAdmin(username: string, password: string): Promise<Admin> {
  const existing = await findAdminByUsername(username);
  if (existing) throw new Error(`Username "${username}" is already taken`);

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query<AdminRow>(
    `INSERT INTO admins (username, password_hash) VALUES ($1, $2) RETURNING *`,
    [username, hash],
  );
  return toAdmin(rows[0]);
}

/**
 * Read by middleware/auth.ts's requireAdmin on every authenticated request
 * — a token is rejected if it was issued (its JWT `iat`) before this
 * timestamp. Returns null (no revocation) for the common case without a
 * second query.
 */
export async function getTokenValidAfter(adminId: number): Promise<Date | null> {
  const { rows } = await pool.query<{ token_valid_after: Date | null }>(
    "SELECT token_valid_after FROM admins WHERE id = $1",
    [adminId],
  );
  return rows[0]?.token_valid_after ?? null;
}

/**
 * Invalidates every token issued for this admin so far — the fix for "a
 * staff laptop is lost" or "someone's let go" without waiting out the
 * normal 12h JWT expiry. The admin's own next login issues a fresh token
 * with a later `iat`, so this doesn't lock them out permanently, only kicks
 * whatever session(s) already existed at the moment this was called.
 */
export async function revokeSessions(adminId: number): Promise<Admin> {
  const { rows } = await pool.query<AdminRow>(
    "UPDATE admins SET token_valid_after = now() WHERE id = $1 RETURNING *",
    [adminId],
  );
  if (!rows[0]) throw new Error("Admin not found");
  return toAdmin(rows[0]);
}

/**
 * Runs once at server startup (see index.ts). The `admins` table ships
 * empty, so on a fresh install — or on this exact upgrade, for anyone who
 * already has ADMIN_USERNAME/ADMIN_PASSWORD set — there'd be no way to log
 * in at all. If the table is still empty, seed one row from those env vars
 * (bcrypt-hashed) so the existing login keeps working unchanged; once any
 * admin exists, this is permanently a no-op and ADMIN_USERNAME/PASSWORD are
 * only ever read here.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text FROM admins");
  if (Number(rows[0].count) > 0) return;

  await createAdmin(env.adminUsername, env.adminPassword);
  console.log(
    `[adminService] no admins existed yet — bootstrapped "${env.adminUsername}" from ADMIN_USERNAME/ADMIN_PASSWORD. Add more staff from the dashboard and consider rotating that password.`,
  );
}
