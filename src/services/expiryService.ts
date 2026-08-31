import { pool } from "../db/pool";
import { disableVoucher } from "./voucherService";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Finds vouchers whose `expires_at` date has passed but are still enabled,
 * and disables each directly (DB + router — see voucherService.disableVoucher,
 * which calls disableVoucherEverywhere under the hood).
 *
 * This replaces reliance on the router's own hourly expiry scheduler
 * (expire-vouchers.rsc from the original static-portal project — not
 * migrated into this backend), which is what caused vouchers to stay
 * "active" up to ~59 minutes past their real expiry: it only re-checked
 * once an hour, on the hour. Postgres already has the answer the moment a
 * date rolls over — no need to wait on the router's own cron to notice, we
 * just push the disable ourselves on a tighter interval.
 *
 * Compared against the UTC date, not Postgres's session-local CURRENT_DATE,
 * because voucherService.expiryDateString() stamps expires_at using UTC —
 * they need to agree on what "today" means or this drifts by a day near
 * midnight depending on server timezone.
 */
export async function expireOverdueVouchers(): Promise<void> {
  const { rows } = await pool.query<{ pin: string }>(
    `SELECT pin FROM vouchers WHERE disabled = false AND expires_at <= (now() AT TIME ZONE 'utc')::date`,
  );
  if (!rows.length) return;

  console.log(`[expiryService] ${rows.length} voucher(s) past expiry — disabling...`);
  for (const { pin } of rows) {
    try {
      await disableVoucher(pin);
      console.log(`[expiryService] disabled expired voucher ${pin}`);
    } catch (err: any) {
      // One failure (e.g. router unreachable) shouldn't block the rest of
      // the batch — it's still `disabled=false` in the DB, so it's simply
      // retried on the next tick.
      console.error(`[expiryService] failed to disable expired voucher ${pin}:`, err?.message || err);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Called once from index.ts at startup. */
export function startExpiryCron(): void {
  if (intervalHandle) return; // already running — guards against double-start on hot reload

  expireOverdueVouchers().catch((err) => console.error("[expiryService] startup check failed:", err));
  intervalHandle = setInterval(() => {
    expireOverdueVouchers().catch((err) => console.error("[expiryService] check failed:", err));
  }, CHECK_INTERVAL_MS);

  console.log(`[expiryService] cron started — checking for overdue vouchers every ${CHECK_INTERVAL_MS / 60000}min`);
}

export function stopExpiryCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
