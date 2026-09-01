import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../src/db/pool";
import { findOverdueVoucherPins } from "../src/services/expiryService";

// Real integration test against whichever Postgres DATABASE_URL points at
// (same DB the app runs against locally) — no mocking, since the whole
// point is verifying the actual SQL date-boundary comparison. Uses a
// distinctive pin prefix so cleanup can't accidentally touch real data,
// and cleans up in both beforeAll and afterAll in case a previous run was
// interrupted before its own cleanup ran.
const TEST_PINS = ["TEST-EXP-YESTERDAY", "TEST-EXP-TODAY", "TEST-EXP-TOMORROW", "TEST-EXP-DISABLED"];

async function cleanup() {
  await pool.query("DELETE FROM vouchers WHERE pin = ANY($1)", [TEST_PINS]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO vouchers (pin, plan_key, expires_at, disabled, router_synced) VALUES
       ('TEST-EXP-YESTERDAY', 'LS', ((now() AT TIME ZONE 'utc')::date - 1), false, true),
       ('TEST-EXP-TODAY',     'LS', (now() AT TIME ZONE 'utc')::date,       false, true),
       ('TEST-EXP-TOMORROW',  'LS', ((now() AT TIME ZONE 'utc')::date + 1), false, true),
       ('TEST-EXP-DISABLED',  'LS', ((now() AT TIME ZONE 'utc')::date - 1), true,  true)`,
  );
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("expiryService.findOverdueVoucherPins", () => {
  it("includes vouchers whose expiry date is today or earlier", async () => {
    const pins = await findOverdueVoucherPins();
    expect(pins).toContain("TEST-EXP-YESTERDAY");
    expect(pins).toContain("TEST-EXP-TODAY");
  });

  it("excludes vouchers that don't expire until tomorrow", async () => {
    const pins = await findOverdueVoucherPins();
    expect(pins).not.toContain("TEST-EXP-TOMORROW");
  });

  it("excludes vouchers that are already disabled, even if overdue", async () => {
    const pins = await findOverdueVoucherPins();
    expect(pins).not.toContain("TEST-EXP-DISABLED");
  });
});
