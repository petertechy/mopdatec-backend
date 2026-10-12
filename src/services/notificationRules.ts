// Pure rules for WHEN a customer gets a push alert — no DB, no network, so
// they're unit-testable (tests/notificationRules.test.ts). pushService does
// the sending and the "already sent?" bookkeeping.

/** Percent of data REMAINING at which a capped-plan customer is alerted. */
export const DATA_THRESHOLDS = [20, 10, 5] as const;
/** Days before expiry at which an UNLIMITED-plan customer is alerted. */
export const EXPIRY_THRESHOLD_DAYS = [5, 2] as const;

export interface ThresholdHit {
  /** Every threshold now crossed, as dedupe keys, e.g. ["data_20", "data_10"]. */
  crossedKinds: string[];
  /** The tightest one crossed — the only one worth interrupting the customer for. */
  targetKind: string;
  /** The raw threshold value of targetKind (percent, or days). */
  targetValue: number;
}

/**
 * If data usage has crossed one or more thresholds, returns all of them plus
 * the tightest. A customer who jumps from 30% to 4% left gets ONE alert (the
 * 5% one), not three — but all three are recorded as sent so the 20% and 10%
 * alerts don't fire late on the next check.
 */
export function pickDataThreshold(usedBytes: number, limitBytes: number): ThresholdHit | null {
  if (limitBytes <= 0) return null;
  const remainingPct = (1 - usedBytes / limitBytes) * 100;
  const crossed = DATA_THRESHOLDS.filter((t) => remainingPct <= t);
  if (crossed.length === 0) return null;
  const target = Math.min(...crossed);
  return { crossedKinds: crossed.map((t) => `data_${t}`), targetKind: `data_${target}`, targetValue: target };
}

/** Same idea for time left on an unlimited plan: 5 days, then 2 days. Null once expired. */
export function pickExpiryThreshold(msLeft: number): ThresholdHit | null {
  if (msLeft <= 0) return null;
  const crossed = EXPIRY_THRESHOLD_DAYS.filter((d) => msLeft <= d * 86_400_000);
  if (crossed.length === 0) return null;
  const target = Math.min(...crossed);
  return { crossedKinds: crossed.map((d) => `expiry_${d}d`), targetKind: `expiry_${target}d`, targetValue: target };
}

// Subscription endpoints are supplied by the (unauthenticated) customer and
// our server POSTs to them, so restrict them to the real browser push
// services — otherwise this would be a blind-SSRF primitive.
const PUSH_HOST_SUFFIXES = [
  ".googleapis.com", // Chrome / Edge / Samsung / most Android (FCM)
  ".push.services.mozilla.com", // Firefox
  ".push.apple.com", // Safari / iOS home-screen web apps
  ".notify.windows.com", // legacy Edge / Windows
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOST_SUFFIXES.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}
