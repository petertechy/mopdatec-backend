import { pool } from "../db/pool";

export interface OverviewStats {
  totalVouchers: number;
  vouchersByStatus: {
    active: number;
    not_synced: number;
    expired: number;
    disabled: number;
  };
  vouchersCreatedToday: number;
  activeSessions: number;
  totalRevenueKobo: number;
  revenueTodayKobo: number;
  successfulPayments: number;
}

/**
 * Backs the admin dashboard's Overview page stat cards — one query per
 * metric, all cheap (COUNT/SUM with indexed columns), run in parallel.
 * Deliberately real aggregates from Postgres, not derived from whatever
 * page of results the voucher list happens to have fetched client-side
 * (which is capped — see voucherService.listVouchers's `limit`).
 */
export async function getOverviewStats(): Promise<OverviewStats> {
  const [statusCounts, createdToday, activeSessions, revenue] = await Promise.all([
    // Same CASE expression as voucherService.listVouchers — kept in sync
    // by hand since it's the one other place this status logic exists.
    pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text FROM (
         SELECT CASE
           WHEN disabled THEN 'disabled'
           WHEN expires_at <= now() THEN 'expired'
           WHEN NOT router_synced THEN 'not_synced'
           ELSE 'active'
         END AS status
         FROM vouchers
       ) sub GROUP BY status`,
    ),
    pool.query<{ count: string }>(
      `SELECT count(*)::text FROM vouchers WHERE created_at >= date_trunc('day', now())`,
    ),
    pool.query<{ count: string }>(
      `SELECT count(*)::text FROM latest_usage WHERE recorded_at > now() - interval '10 minutes'`,
    ),
    pool.query<{ total: string | null; today: string | null; count: string }>(
      `SELECT
         coalesce(sum(amount_kobo), 0)::text AS total,
         coalesce(sum(amount_kobo) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::text AS today,
         count(*)::text
       FROM payments WHERE status = 'success'`,
    ),
  ]);

  const byStatus = { active: 0, not_synced: 0, expired: 0, disabled: 0 };
  let totalVouchers = 0;
  for (const row of statusCounts.rows) {
    const n = Number(row.count);
    totalVouchers += n;
    if (row.status in byStatus) (byStatus as any)[row.status] = n;
  }

  return {
    totalVouchers,
    vouchersByStatus: byStatus,
    vouchersCreatedToday: Number(createdToday.rows[0].count),
    activeSessions: Number(activeSessions.rows[0].count),
    totalRevenueKobo: Number(revenue.rows[0].total),
    revenueTodayKobo: Number(revenue.rows[0].today),
    successfulPayments: Number(revenue.rows[0].count),
  };
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface PlanBreakdown {
  planKey: string;
  planLabel: string;
  voucherCount: number;
  revenueKobo: number;
}

export interface AnalyticsStats {
  days: number;
  revenueByDay: DailyPoint[];
  vouchersByDay: DailyPoint[];
  byPlan: PlanBreakdown[];
  redemption: { redeemed: number; total: number };
}

/**
 * Backs the Analytics page. Every metric is scoped to the same `days`
 * window (so the numbers on the page always agree with each other — see
 * the dataviz skill's "filters scope everything below them" rule),
 * computed as real Postgres aggregates.
 *
 * revenueByDay/vouchersByDay are gap-filled via generate_series — a day
 * with zero activity is a real 0 point, not a missing one, so the chart
 * never silently skips a day.
 */
export async function getAnalyticsStats(days: number): Promise<AnalyticsStats> {
  const [revenueByDay, vouchersByDay, byPlan, redemption] = await Promise.all([
    pool.query<{ date: string; value: string }>(
      `WITH day_spine AS (
         SELECT generate_series(
           (now() AT TIME ZONE 'utc')::date - ($1::int - 1),
           (now() AT TIME ZONE 'utc')::date,
           '1 day'
         )::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date, coalesce(sum(p.amount_kobo), 0)::text AS value
       FROM day_spine d
       LEFT JOIN payments p
         ON p.status = 'success' AND (p.created_at AT TIME ZONE 'utc')::date = d.day
       GROUP BY d.day ORDER BY d.day`,
      [days],
    ),
    pool.query<{ date: string; value: string }>(
      `WITH day_spine AS (
         SELECT generate_series(
           (now() AT TIME ZONE 'utc')::date - ($1::int - 1),
           (now() AT TIME ZONE 'utc')::date,
           '1 day'
         )::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date, count(v.pin)::text AS value
       FROM day_spine d
       LEFT JOIN vouchers v ON (v.created_at AT TIME ZONE 'utc')::date = d.day
       GROUP BY d.day ORDER BY d.day`,
      [days],
    ),
    // voucher_counts and revenue are separate CTEs (not one multi-join)
    // specifically to avoid a fan-out: joining vouchers AND payments to
    // plans in one query would multiply rows (N vouchers × M payments per
    // plan) and silently inflate both counts.
    pool.query<{ plan_key: string; plan_label: string; voucher_count: string; revenue_kobo: string }>(
      `WITH voucher_counts AS (
         SELECT plan_key, count(*) AS voucher_count
         FROM vouchers
         WHERE created_at >= (now() AT TIME ZONE 'utc')::date - ($1::int - 1)
         GROUP BY plan_key
       ), plan_revenue AS (
         SELECT plan_key, sum(amount_kobo) AS revenue_kobo
         FROM payments
         WHERE status = 'success' AND created_at >= (now() AT TIME ZONE 'utc')::date - ($1::int - 1)
         GROUP BY plan_key
       )
       SELECT p.key AS plan_key, p.label AS plan_label,
              coalesce(vc.voucher_count, 0)::text AS voucher_count,
              coalesce(r.revenue_kobo, 0)::text AS revenue_kobo
       FROM plans p
       LEFT JOIN voucher_counts vc ON vc.plan_key = p.key
       LEFT JOIN plan_revenue r ON r.plan_key = p.key
       ORDER BY coalesce(vc.voucher_count, 0) DESC`,
      [days],
    ),
    pool.query<{ redeemed: string; total: string }>(
      `SELECT count(*) FILTER (WHERE redeemed_at IS NOT NULL)::text AS redeemed, count(*)::text AS total
       FROM vouchers
       WHERE created_at >= (now() AT TIME ZONE 'utc')::date - ($1::int - 1)`,
      [days],
    ),
  ]);

  return {
    days,
    revenueByDay: revenueByDay.rows.map((r) => ({ date: r.date, value: Number(r.value) })),
    vouchersByDay: vouchersByDay.rows.map((r) => ({ date: r.date, value: Number(r.value) })),
    byPlan: byPlan.rows.map((r) => ({
      planKey: r.plan_key,
      planLabel: r.plan_label,
      voucherCount: Number(r.voucher_count),
      revenueKobo: Number(r.revenue_kobo),
    })),
    redemption: {
      redeemed: Number(redemption.rows[0].redeemed),
      total: Number(redemption.rows[0].total),
    },
  };
}
