import { describe, expect, it } from "vitest";
import { holdSuccessors, nextSendable } from "../src/original/sync/queue";
import type { SyncEvent } from "../src/original/sync/types";
const bank = (id: string, base: number) =>
  ({ eventId: id, kind: "bank", payload: { baseVersion: base } }) as SyncEvent;
const mark = (id: string, key: string, base: number) =>
  ({
    eventId: id,
    kind: "mark",
    payload: { questionId: key, baseMarkVersion: base, value: true },
  }) as SyncEvent;
describe("CAS queue dependency preservation", () => {
  it("never sends a predicted future bank version after its predecessor conflicts", () => {
    const first = bank("first", 1),
      second = bank("second", 2),
      meta = {
        outbox: [first, second],
        failures: { first: "version_conflict" },
      };
    expect(nextSendable(meta)).toBeUndefined();
  });
  it("keeps same-key later toggles blocked while independent marks can sync", () => {
    const first = mark("first", "q", 0),
      second = mark("second", "q", 1),
      other = mark("other", "r", 0);
    const meta = {
      outbox: [first, second, other],
      failures: { first: "version_conflict" },
    };
    expect(nextSendable(meta)).toBe(other);
  });
  it("requires review of all successors added before a predecessor is explicitly rebased", () => {
    const meta = {
      outbox: [bank("first", 1), bank("second", 2), bank("later", 3)],
      failures: { first: "version_conflict" } as Record<string, string>,
    };
    holdSuccessors(meta, "first", "선행 버전 충돌 확인 필요");
    meta.outbox[0] = bank("reviewed", 2);
    delete meta.failures.first;
    expect(nextSendable(meta)?.eventId).toBe("reviewed");
    meta.outbox.shift();
    expect(nextSendable(meta)).toBeUndefined();
    expect(Object.keys(meta.failures)).toEqual(["second", "later"]);
  });
  it("keeping a remote mark does not silently release old later local toggles", () => {
    const meta = {
      outbox: [mark("first", "q", 0), mark("later", "q", 1)],
      failures: { first: "version_conflict" } as Record<string, string>,
    };
    holdSuccessors(meta, "first", "원격 표시 선택 후 확인 필요");
    meta.outbox.shift();
    delete meta.failures.first;
    expect(nextSendable(meta)).toBeUndefined();
    expect(meta.outbox[0].eventId).toBe("later");
  });
});
