import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stampClock, usableClock } from "../src/original/sync/clock";
import type { ClockSample } from "../src/original/sync/types";

const baseline = Date.parse("2026-10-23T00:00:00.000Z");
let monotonic = 1000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(baseline);
  monotonic = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function advance(wallMs: number, monotonicMs = wallMs): void {
  vi.setSystemTime(baseline + wallMs);
  monotonic = 1000 + monotonicMs;
}

describe("runtime-bound synchronization clock samples", () => {
  it("stamps the server offset with matching UTC and monotonic runtime observations", () => {
    const sample = stampClock(-1250, 80);
    expect(sample).toMatchObject({
      offsetMs: -1250,
      uncertaintyMs: 80,
      sampledAt: "2026-10-23T00:00:00.000Z",
      monotonicMs: 1000,
    });
    expect(sample.runtimeId).toEqual(expect.any(String));
    expect(sample.runtimeId!.length).toBeGreaterThan(0);
    expect(usableClock(sample)).toBe(sample);
    advance(60_000);
    expect(usableClock(sample)).toBe(sample);
  });

  it.each([60_000, -60_000])(
    "rejects a wall-clock change of %i ms while the monotonic clock advances normally",
    (jump) => {
      const sample = stampClock(0, 30);
      advance(120_000 + jump, 120_000);
      expect(usableClock(sample)).toBeNull();
    },
  );

  it.each([-1, 1])(
    "allows a 2-second drift but rejects a drift beyond the boundary (direction %i)",
    (direction) => {
      const sample = stampClock(0, 30);
      advance(20_000 + direction * 2000, 20_000);
      expect(usableClock(sample)).toBe(sample);
      advance(20_000 + direction * 2001, 20_000);
      expect(usableClock(sample)).toBeNull();
    },
  );

  it("expires a sample after 24 hours even when the two clocks continue to agree", () => {
    const sample = stampClock(0, 30);
    advance(86_400_000);
    expect(usableClock(sample)).toBe(sample);
    advance(86_400_001);
    expect(usableClock(sample)).toBeNull();
  });

  it("rejects future wall-clock samples and backwards monotonic time", () => {
    const sample = stampClock(0, 30);
    advance(-1, 0);
    expect(usableClock(sample)).toBeNull();
    advance(0, -1);
    expect(usableClock(sample)).toBeNull();
  });

  it("requires a fresh sample after a runtime reload instead of trusting persisted wall time", async () => {
    const persisted = structuredClone(stampClock(12, 40));
    vi.resetModules();
    const reloaded = await import("../src/original/sync/clock");
    expect(reloaded.usableClock(persisted)).toBeNull();
    const fresh = reloaded.stampClock(12, 40);
    expect(fresh.runtimeId).not.toBe(persisted.runtimeId);
    expect(reloaded.usableClock(fresh)).toBe(fresh);
  });

  it("rejects legacy samples without runtime proof and a sample from another runtime", () => {
    expect(usableClock(null)).toBeNull();
    expect(usableClock({ offsetMs: 0, uncertaintyMs: 10 })).toBeNull();
    expect(
      usableClock({ ...stampClock(0, 10), runtimeId: "previous-tab-runtime" }),
    ).toBeNull();
    expect(
      usableClock({ ...stampClock(0, 10), monotonicMs: undefined }),
    ).toBeNull();
  });

  it.each<Partial<ClockSample>>([
    { sampledAt: "not-a-date" },
    { sampledAt: "" },
    { monotonicMs: Number.NaN },
    { monotonicMs: Infinity },
    { offsetMs: Number.NaN },
    { offsetMs: Infinity },
    { uncertaintyMs: Number.NaN },
    { uncertaintyMs: Infinity },
    { uncertaintyMs: -1 },
  ])(
    "rejects malformed or non-finite persisted sample fields: %j",
    (overrides) => {
      expect(usableClock({ ...stampClock(0, 10), ...overrides })).toBeNull();
    },
  );
});
