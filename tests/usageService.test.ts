import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../src/db/pool";
import { ingestUsageEvent, getUsageForVoucher } from "../src/services/usageService";

// Real integration test — same rationale as the other tests in this
// directory. Covers two distinct bugs reported live, both around RouterOS's
// own bytes-in/bytes-out resetting on an active session and our code
// needing to bank the prior total instead of silently overwriting it:
//   1. A genuinely new session_id (WiFi drop, phone sleep, reconnect)
//   2. The SAME session_id reporting a lower byte count than before (a
//      rapid logout + immediate re-login reused the same active-session ID
//      — confirmed live on voucher LS-E4MBY)
// These tests stay well under LS's 3GB cap so the backup-disable path (a
// real RouterOS call) never fires.
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

  it("banks and restarts when the SAME session_id reports a lower byte count", async () => {
    // Confirmed live (voucher LS-E4MBY): RouterOS can reuse the same
    // active-session .id across what is actually a fresh connection (e.g. a
    // rapid logout + immediate re-login) — the byte count resets to near
    // zero, but the session_id our code sees never changes. A real active
    // session's own counter can only grow, so a decrease is itself proof
    // this is a new session in disguise.
    const row = await ingestUsageEvent({
      user: TEST_PIN,
      sessionId: "*SESSION-3", // same session_id as the previous event
      address: "10.5.50.102",
      bytesIn: 5_000, // far lower than that session's last known 100,000
      bytesOut: 0,
    });
    // 2,960,000 banked (now including session 3's real peak of 100,000)
    // + the new post-reset reading of 5,000 — NOT dropped back to 5,000.
    expect(row?.bytesUsed).toBe(2_965_000);

    const usage = await getUsageForVoucher(TEST_PIN);
    expect(usage?.bytesUsed).toBe(2_965_000);
  });
});
