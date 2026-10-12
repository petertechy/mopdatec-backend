import webpush from "web-push";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { pickDataThreshold, pickExpiryThreshold, ThresholdHit } from "./notificationRules";
export { isAllowedPushEndpoint } from "./notificationRules";

const MAX_SUBSCRIPTIONS_PER_VOUCHER = 10;
const EXPIRY_CHECK_INTERVAL_MS = 30 * 60 * 1000;

let configured = false;

/** True only when VAPID keys are set; the whole feature is a no-op otherwise. */
export function pushEnabled(): boolean {
  const { publicKey, privateKey, subject } = env.vapid;
  if (!publicKey || !privateKey || !subject) return false;
  if (!configured) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  }
  return true;
}

export function getPublicKey(): string {
  return env.vapid.publicKey;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class VoucherNotFoundForPushError extends Error {}
export class TooManySubscriptionsError extends Error {}

export async function saveSubscription(pin: string, sub: PushSubscriptionInput): Promise<void> {
  const exists = await pool.query("SELECT 1 FROM vouchers WHERE pin = $1", [pin]);
  if (exists.rows.length === 0) throw new VoucherNotFoundForPushError(pin);

  const count = await pool.query(
    "SELECT count(*)::int AS n FROM push_subscriptions WHERE voucher_pin = $1 AND endpoint <> $2",
    [pin, sub.endpoint],
  );
  if (count.rows[0].n >= MAX_SUBSCRIPTIONS_PER_VOUCHER) throw new TooManySubscriptionsError(pin);

  await pool.query(
    `INSERT INTO push_subscriptions (voucher_pin, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (voucher_pin, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [pin, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
}

export async function removeSubscription(pin: string, endpoint: string): Promise<void> {
  await pool.query("DELETE FROM push_subscriptions WHERE voucher_pin = $1 AND endpoint = $2", [pin, endpoint]);
}

export async function hasSubscription(pin: string, endpoint: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM push_subscriptions WHERE voucher_pin = $1 AND endpoint = $2",
    [pin, endpoint],
  );
  return rows.length > 0;
}

interface Payload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

async function sendToVoucher(pin: string, subs: { endpoint: string; p256dh: string; auth: string }[], payload: Payload) {
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          TTL: 12 * 60 * 60,
        });
      } catch (err: any) {
        // 404/410 = the browser unsubscribed or the subscription expired —
        // drop it so we stop trying. Anything else is transient; log and move on.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await removeSubscription(pin, s.endpoint).catch(() => {});
        } else {
          console.error(`[pushService] send failed for ${pin}:`, err?.statusCode || err?.message || err);
        }
      }
    }),
  );
}

/**
 * Sends one alert for a threshold hit, at most once per voucher per
 * threshold. Subscribers are looked up FIRST and nothing is recorded when
 * there are none, so a customer who turns alerts on while already below a
 * threshold still gets that alert on the next check instead of never.
 * Recording happens before sending (at-most-once): a failed send isn't
 * retried, which beats spamming a customer if a push service flaps.
 */
async function alertOnce(pin: string, hit: ThresholdHit, build: (hit: ThresholdHit) => Omit<Payload, "url" | "tag">) {
  const { rows: subs } = await pool.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE voucher_pin = $1",
    [pin],
  );
  if (subs.length === 0) return;

  const inserted = await pool.query(
    `INSERT INTO notification_log (voucher_pin, kind)
     SELECT $1, k FROM unnest($2::text[]) AS k
     ON CONFLICT DO NOTHING RETURNING kind`,
    [pin, hit.crossedKinds],
  );
  if (!inserted.rows.some((r) => r.kind === hit.targetKind)) return; // already alerted at this level

  const { title, body } = build(hit);
  await sendToVoucher(pin, subs, {
    title,
    body,
    url: `/portal/status?username=${encodeURIComponent(pin)}`,
    tag: `${pin}-${hit.targetKind}`,
  });
  console.log(`[pushService] sent ${hit.targetKind} alert to ${subs.length} device(s) for ${pin}`);
}

/**
 * Called from usageService after each router sync for a capped voucher.
 * Cheap on the hot path: the pure rule check runs first and only vouchers
 * actually at/below 20% remaining touch the database.
 */
export async function notifyDataUsage(pin: string, usedBytes: number, limitBytes: number, planLabel: string): Promise<void> {
  if (!pushEnabled()) return;
  const hit = pickDataThreshold(usedBytes, limitBytes);
  if (!hit) return;
  await alertOnce(pin, hit, (h) =>
    usedBytes >= limitBytes
      ? { title: "You've used all your data", body: `Your ${planLabel} data is finished. Tap to top up and stay connected.` }
      : { title: `${h.targetValue}% of your data left`, body: `Your ${planLabel} plan is running low. Tap to check your usage or top up.` },
  );
}

function formatLagos(d: Date): string {
  return d.toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Unlimited plans only: alert 5 days and 2 days before expiry. */
export async function checkExpiringUnlimited(): Promise<void> {
  if (!pushEnabled()) return;
  const { rows } = await pool.query(
    `SELECT v.pin, v.expires_at, p.label
     FROM vouchers v JOIN plans p ON p.key = v.plan_key
     WHERE p.bytes_limit IS NULL AND NOT v.disabled AND v.archived_at IS NULL
       AND v.expires_at > now() AND v.expires_at <= now() + interval '5 days'
       AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.voucher_pin = v.pin)`,
  );
  for (const r of rows) {
    const expiresAt = new Date(r.expires_at);
    const hit = pickExpiryThreshold(expiresAt.getTime() - Date.now());
    if (!hit) continue;
    await alertOnce(r.pin, hit, (h) => ({
      title: `Your plan expires in ${h.targetValue} days`,
      body: `Your ${r.label} plan ends on ${formatLagos(expiresAt)}. Tap to renew and stay connected.`,
    })).catch((err) => console.error(`[pushService] expiry alert failed for ${r.pin}:`, err?.message || err));
  }
}

let expiryTimer: NodeJS.Timeout | null = null;

export function startNotificationCron(): void {
  if (expiryTimer) return;
  if (!pushEnabled()) {
    console.log("[pushService] VAPID keys not set — push notifications disabled");
    return;
  }
  const run = () => checkExpiringUnlimited().catch((err) => console.error("[pushService] expiry check failed:", err));
  run();
  expiryTimer = setInterval(run, EXPIRY_CHECK_INTERVAL_MS);
  console.log(`[pushService] push notifications enabled — expiry check every ${EXPIRY_CHECK_INTERVAL_MS / 60000}min`);
}
