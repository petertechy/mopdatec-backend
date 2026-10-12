import { describe, it, expect } from "vitest";
import { buildSessions, SnapshotRow } from "../src/services/usageDetailService";

function snap(sessionId: string, bytesIn: number, bytesOut: number, minute: number): SnapshotRow {
  return { sessionId, ipAddress: "10.0.0.5", bytesIn, bytesOut, recordedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() };
}

describe("buildSessions", () => {
  it("returns nothing for no snapshots", () => {
    expect(buildSessions([])).toEqual({ sessions: [], timeline: [], totalBytes: 0 });
  });

  it("tracks growth within one session", () => {
    const r = buildSessions([snap("*1", 10, 10, 0), snap("*1", 50, 50, 1)]);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].bytesTotal).toBe(100);
    expect(r.totalBytes).toBe(100);
  });

  it("banks the previous session when the session id changes", () => {
    const r = buildSessions([snap("*1", 0, 100, 0), snap("*2", 0, 40, 5)]);
    expect(r.sessions.map((s) => s.bytesTotal)).toEqual([100, 40]);
    expect(r.totalBytes).toBe(140);
    expect(r.timeline.map((t) => t.cumulativeBytes)).toEqual([100, 140]);
  });

  it("treats a lower counter under the same session id as a new session", () => {
    const r = buildSessions([snap("*1", 0, 120, 0), snap("*1", 0, 1, 2)]);
    expect(r.sessions).toHaveLength(2);
    expect(r.totalBytes).toBe(121);
  });
});
