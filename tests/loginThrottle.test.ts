import { describe, it, expect } from "vitest";
import { checkLockout, recordFailedAttempt, clearAttempts } from "../src/services/loginThrottle";

// A fresh username per test avoids cross-test interference — the module
// keeps its lockout state in a single process-wide Map with no reset hook,
// same as it does in the real running server.
function uniqueUsername(): string {
  return `test-user-${Math.random().toString(36).slice(2)}`;
}

describe("loginThrottle", () => {
  it("does not lock out a username with no recorded attempts", () => {
    expect(checkLockout(uniqueUsername())).toEqual({ locked: false });
  });

  it("does not lock out after fewer than 5 failed attempts", () => {
    const username = uniqueUsername();
    for (let i = 0; i < 4; i++) recordFailedAttempt(username);
    expect(checkLockout(username)).toEqual({ locked: false });
  });

  it("locks out after 5 failed attempts, with a positive retryAfterSeconds", () => {
    const username = uniqueUsername();
    for (let i = 0; i < 5; i++) recordFailedAttempt(username);

    const status = checkLockout(username);
    expect(status.locked).toBe(true);
    expect(status.retryAfterSeconds).toBeGreaterThan(0);
    expect(status.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it("is case-insensitive on username", () => {
    const username = uniqueUsername();
    for (let i = 0; i < 5; i++) recordFailedAttempt(username.toUpperCase());
    expect(checkLockout(username.toLowerCase()).locked).toBe(true);
  });

  it("clearAttempts lifts a lockout immediately (e.g. after a successful login)", () => {
    const username = uniqueUsername();
    for (let i = 0; i < 5; i++) recordFailedAttempt(username);
    expect(checkLockout(username).locked).toBe(true);

    clearAttempts(username);
    expect(checkLockout(username)).toEqual({ locked: false });
  });
});
