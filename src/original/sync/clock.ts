import type { ClockSample } from "./types";
// A persisted wall-clock sample alone cannot prove that a device's clock has
// not changed. Restarted or jumped clocks intentionally fall back to K.
const runtimeId = crypto.randomUUID();
export function stampClock(
  offsetMs: number,
  uncertaintyMs: number,
): ClockSample {
  return {
    offsetMs,
    uncertaintyMs,
    sampledAt: new Date().toISOString(),
    runtimeId,
    monotonicMs: performance.now(),
  };
}
export function usableClock(sample: ClockSample | null): ClockSample | null {
  if (
    !sample ||
    sample.runtimeId !== runtimeId ||
    !Number.isFinite(sample.monotonicMs) ||
    !sample.sampledAt ||
    !Number.isFinite(Date.parse(sample.sampledAt)) ||
    !Number.isFinite(sample.offsetMs) ||
    !Number.isFinite(sample.uncertaintyMs) ||
    sample.uncertaintyMs < 0
  )
    return null;
  const elapsed = Date.now() - Date.parse(sample.sampledAt),
    monotonicElapsed = performance.now() - sample.monotonicMs!;
  if (
    elapsed < 0 ||
    elapsed > 86400000 ||
    monotonicElapsed < 0 ||
    Math.abs(elapsed - monotonicElapsed) > 2000
  )
    return null;
  return sample;
}
