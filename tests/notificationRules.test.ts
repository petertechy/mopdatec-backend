import { describe, it, expect } from "vitest";
import { pickDataThreshold, pickExpiryThreshold } from "../src/services/notificationRules";

const GB = 1_000_000_000;
const DAY = 86_400_000;

describe("pickDataThreshold", () => {
  it("does nothing while more than 20% remains", () => {
    expect(pickDataThreshold(2 * GB, 3 * GB)).toBeNull(); // 33% left
    expect(pickDataThreshold(0, 3 * GB)).toBeNull();
  });

  it("fires the 20% alert at exactly 20% remaining", () => {
    expect(pickDataThreshold(2.4 * GB, 3 * GB)).toEqual({ crossedKinds: ["data_20"], targetKind: "data_20", targetValue: 20 });
  });

  it("targets the tightest threshold and records all crossed ones", () => {
    // 4% left: one alert (5%), but 20 and 10 are marked sent too
    const hit = pickDataThreshold(2.88 * GB, 3 * GB)!;
    expect(hit.targetKind).toBe("data_5");
    expect(hit.crossedKinds).toEqual(["data_20", "data_10", "data_5"]);
  });

  it("treats a fully used or overshot cap as the 5% tier", () => {
    expect(pickDataThreshold(3 * GB, 3 * GB)!.targetKind).toBe("data_5");
    expect(pickDataThreshold(3.2 * GB, 3 * GB)!.targetKind).toBe("data_5");
  });

  it("ignores a zero/invalid limit", () => {
    expect(pickDataThreshold(5, 0)).toBeNull();
  });
});

describe("pickExpiryThreshold", () => {
  it("does nothing with more than 5 days left", () => {
    expect(pickExpiryThreshold(6 * DAY)).toBeNull();
  });

  it("fires the 5-day alert inside 5 days", () => {
    expect(pickExpiryThreshold(4.9 * DAY)).toEqual({ crossedKinds: ["expiry_5d"], targetKind: "expiry_5d", targetValue: 5 });
  });

  it("fires the 2-day alert inside 2 days, marking the 5-day one sent too", () => {
    const hit = pickExpiryThreshold(1.5 * DAY)!;
    expect(hit.targetKind).toBe("expiry_2d");
    expect(hit.crossedKinds).toEqual(["expiry_5d", "expiry_2d"]);
  });

  it("does nothing once already expired", () => {
    expect(pickExpiryThreshold(0)).toBeNull();
    expect(pickExpiryThreshold(-1000)).toBeNull();
  });
});

import { isAllowedPushEndpoint } from "../src/services/notificationRules";

describe("isAllowedPushEndpoint", () => {
  it("accepts the real browser push services", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
  });

  it("rejects arbitrary hosts, plain http, internal addresses and lookalikes", () => {
    expect(isAllowedPushEndpoint("https://evil.example.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://10.10.10.2/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://googleapis.com.evil.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });
});
