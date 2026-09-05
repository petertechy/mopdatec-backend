import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../src/db/pool";
import { ingestUsageEvent, getUsageForVoucher } from "../src/services/usageService";

// Real integration test — same rationale as the other tests in this
// directory. Covers the exact bug reported live: RouterOS's own
// bytes-in/bytes-out on an active session reset to 0 whenever that session
// gets recycled (WiFi drop, phone sleep, manual logout+login), so reading
// them directly as "total usage" made a voucher's usage appear to reset on
// every reconnect. ingestUsageEvent now banks each session's last known
// total into vouchers.usage_banked_bytes the moment a different session_id
// shows up for the same voucher — these tests stay well under LS's 3GB cap
// so the backup-disable path (a real RouterOS call) never fires.
const TEST_PIN = "TEST-USG-VOUCHER";

async function cleanup() {
  await pool.query("DELETE FROM usage_snapshots WHERE voucher_pin = $1", [TEST_PIN]);
  await pool.query("DELETE FROM vouchers WHERE pin = $1", [TEST_PIN]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO vouchers (pin, plan_key, expires_at, disabled, router_synced) VALUES
       ($1, 'LS', now() + interval '1 day', false, true)`,
    [TEST_PIN],
  );
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("usageService cumulative usage tracking", () => {
  it("starts a fresh voucher's usage at its first session's raw bytes", async () => {
    const row = await ingestUsageEvent({
      user: TEST_PIN,
      sessionId: "*SESSION-1",
      address: "10.5.50.100",
      bytesIn: 1_000_000,
      bytesOut: 500_000,
    });
    expect(row?.bytesUsed).toBe(1_500_000);

    const usage = await getUsageForVoucher(TEST_PIN);
    expect(usage?.bytesUsed).toBe(1_500_000);
  });

  it("does not double-count repeated events within the same session", async () => {
    // RouterOS's own counter only grows within one session — a later,
    // larger reading for the SAME session_id should just replace, not add.
    const row = await ingestUsageEvent({
      user: TEST_PIN,
      sessionId: "*SESSION-1",
      address: "10.5.50.100",
      bytesIn: 2_000_000,
      bytesOut: 800_000,
    });
    expect(row?.bytesUsed).toBe(2_800_000);
  });

  it("preserves the running total across a reconnect (new session_id), instead of resetting it", async () => {
    // This is the exact bug: a new session_id means RouterOS itself now
    // reports bytes starting back near 0 for the new session — but the
    // voucher's cumulative total must still include everything from the
    // just-ended session on top.
    const row = await ingestUsageEvent({
      user: TEST_PIN,
      sessionId: "*SESSION-2",
      address: "10.5.50.101",
      bytesIn: 50_000,
      bytesOut: 10_000,
    });
    // 2,800,000 banked from session 1, plus session 2's own 60,000 so far.
    expect(row?.bytesUsed).toBe(2_860_000);

    const usage = await getUsageForVoucher(TEST_PIN);
    expect(usage?.bytesUsed).toBe(2_860_000);
  });

  it("keeps accumulating correctly through a third session", async () => {
    const row = await ingestUsageEvent({
      user: TEST_PIN,
      sessionId: "*SESSION-3",
      address: "10.5.50.102",
      bytesIn: 100_000,
      bytesOut: 0,
    });
    // 2,860,000 banked (sessions 1+2's final totals) + session 3's 100,000.
    expect(row?.bytesUsed).toBe(2_960_000);
  });
});
