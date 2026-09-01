const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes — failures older than this don't count toward a lockout
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes locked out once MAX_ATTEMPTS is hit

interface Attempt {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
}

// In-memory, per-process — resets on restart/redeploy, same trade-off as
// expiryService's and routerHealthService's timers. Keyed by username
// (case-insensitive) rather than IP: this is a small staff team, not a
// public-facing login, so the real threat is guessing one account's
// password, not distributed abuse — and per-IP tracking risks locking out
// a whole shared office network over one person's typo.
const attempts = new Map<string, Attempt>();

export interface LockoutStatus {
  locked: boolean;
  retryAfterSeconds?: number;
}

export function checkLockout(username: string): LockoutStatus {
  const key = username.toLowerCase();
  const rec = attempts.get(key);
  if (!rec || !rec.lockedUntil) return { locked: false };

  const now = Date.now();
  if (now >= rec.lockedUntil) {
    attempts.delete(key); // lockout window has passed — start clean
    return { locked: false };
  }
  return { locked: true, retryAfterSeconds: Math.ceil((rec.lockedUntil - now) / 1000) };
}

/** Called on a failed login attempt (wrong password OR unknown username). */
export function recordFailedAttempt(username: string): void {
  const key = username.toLowerCase();
  const now = Date.now();
  const rec = attempts.get(key);

  if (!rec || now - rec.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: null });
    return;
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    console.warn(`[loginThrottle] locking out "${username}" after ${rec.count} failed attempts`);
  }
}

/** Called on a successful login — a real login clears any accumulated failure count. */
export function clearAttempts(username: string): void {
  attempts.delete(username.toLowerCase());
}
