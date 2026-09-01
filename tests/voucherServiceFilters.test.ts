import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../src/db/pool";
import { listVouchers } from "../src/services/voucherService";

// Real integration test — same rationale as expiryService.test.ts. Seeds
// one voucher in each computed-status bucket directly (bypassing the
// router call createVoucherBatch would make) so the SQL status/filter
// logic in voucherService.listVouchers can be asserted without depending
// on RouterOS being reachable.
const TEST_PINS = ["TEST-VL-ACTIVE", "TEST-VL-EXPIRED", "TEST-VL-DISABLED", "TEST-VL-NOTSYNC"];

async function cleanup() {
  await pool.query("DELETE FROM vouchers WHERE pin = ANY($1)", [TEST_PINS]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO vouchers (pin, plan_key, expires_at, disabled, router_synced) VALUES
       ('TEST-VL-ACTIVE',   'LS', ((now() AT TIME ZONE 'utc')::date + 5), false, true),
       ('TEST-VL-EXPIRED',  'LS', ((now() AT TIME ZONE 'utc')::date - 2), false, true),
       ('TEST-VL-DISABLED', 'LS', ((now() AT TIME ZONE 'utc')::date + 5), true,  true),
       ('TEST-VL-NOTSYNC',  'LS', ((now() AT TIME ZONE 'utc')::date + 5), false, false)`,
  );
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("voucherService.listVouchers", () => {
  it("computes the correct status for each voucher", async () => {
    const vouchers = await listVouchers({ search: "TEST-VL-" });
    const byPin = Object.fromEntries(vouchers.map((v) => [v.pin, v.status]));

    expect(byPin["TEST-VL-ACTIVE"]).toBe("active");
    expect(byPin["TEST-VL-EXPIRED"]).toBe("expired");
    expect(byPin["TEST-VL-DISABLED"]).toBe("disabled");
    expect(byPin["TEST-VL-NOTSYNC"]).toBe("not_synced");
  });

  it("filters by status", async () => {
    const vouchers = await listVouchers({ search: "TEST-VL-", status: "expired" });
    expect(vouchers.map((v) => v.pin)).toEqual(["TEST-VL-EXPIRED"]);
  });

  it("filters by search substring, case-insensitively", async () => {
    const vouchers = await listVouchers({ search: "test-vl-active" });
    expect(vouchers.map((v) => v.pin)).toEqual(["TEST-VL-ACTIVE"]);
  });

  it("sorts by created_at ascending when asked", async () => {
    const vouchers = await listVouchers({ search: "TEST-VL-", sort: "asc" });
    const createdTimes = vouchers.map((v) => new Date(v.createdAt).getTime());
    const sorted = [...createdTimes].sort((a, b) => a - b);
    expect(createdTimes).toEqual(sorted);
  });

  it("returns nothing for a search that matches no voucher", async () => {
    const vouchers = await listVouchers({ search: "TEST-VL-DOES-NOT-EXIST" });
    expect(vouchers).toEqual([]);
  });
});
