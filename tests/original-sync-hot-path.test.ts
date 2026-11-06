import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  SyncAccountStore,
  emptySyncLocal,
  syncMetaKey,
} from "../src/original/sync/local";
import {
  initialOriginalState,
  startSession,
  defaultSelection,
  answer,
  finish,
} from "../src/original/engine";
import {
  applyEvents,
  emptyProjection,
  reconcileOrder,
} from "../src/original/sync/protocol";

describe("restricted metadata commits", () => {
  it("commits sync acknowledgements without replacing study state or advancing its generation", async () => {
    const store = new SyncAccountStore(crypto.randomUUID()),
      owner = "test|owner";
    const state = initialOriginalState("real");
    state.settings.fontScale = 1.5;
    const saved = await store.write(
      owner,
      { state, generation: 0, meta: emptySyncLocal() },
      0,
    );
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    const meta = await store.writeMetadata(
      owner,
      { ...saved.meta, lastSuccess: "2026-11-05T00:00:00Z" },
      saved.generation,
      saved.meta.revision ?? 0,
    );
    expect(put.mock.calls.map((args) => args[1])).toEqual([syncMetaKey(owner)]);
    put.mockRestore();
    const after = await store.read(owner);
    expect(after.state).toEqual(state);
    expect(after.generation).toBe(saved.generation);
    expect(after.meta).toEqual(meta);
    expect(meta.revision).toBe((saved.meta.revision ?? 0) + 1);
    expect((await store.read("test|other")).generation).toBe(0);
    await store.close();
  });
  it("rejects stale state and metadata generations without losing a newer answer/settings state", async () => {
    const store = new SyncAccountStore(crypto.randomUUID()),
      owner = "test|owner";
    const first = await store.read(owner);
    await store.writeMetadata(owner, first.meta, 0, 0);
    await expect(store.writeMetadata(owner, first.meta, 0, 0)).rejects.toThrow(
      "다른 탭",
    );
    const current = await store.read(owner),
      next = structuredClone(current);
    next.state.settings.fontScale = 1.25;
    const saved = await store.write(owner, next, current.generation);
    await expect(
      store.writeMetadata(
        owner,
        current.meta,
        current.generation,
        saved.meta.revision ?? 0,
      ),
    ).rejects.toThrow("다른 탭");
    expect((await store.read(owner)).state.settings.fontScale).toBe(1.25);
    await store.close();
  });
  it("reports transaction failure and keeps the previous durable metadata", async () => {
    const store = new SyncAccountStore(crypto.randomUUID()),
      owner = "test|owner";
    const before = await store.read(owner),
      original = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, value, key) {
        if (key === syncMetaKey(owner))
          throw new DOMException("test quota", "QuotaExceededError");
        return original.call(this, value, key);
      });
    try {
      await expect(
        store.writeMetadata(
          owner,
          { ...before.meta, lastSuccess: "unsaved" },
          0,
          0,
        ),
      ).rejects.toThrow("test quota");
    } finally {
      spy.mockRestore();
    }
    const after = await store.read(owner);
    expect(after.generation).toBe(before.generation);
    expect(after.meta.lastSuccess).toBeNull();
    expect(after.meta.revision).toBe(0);
    await store.close();
  });
});

describe("empty pull ordering without copying immutable banks", () => {
  it("still attributes actual answers and resolves causal order without mutating input snapshots", () => {
    const state = initialOriginalState("demo"),
      at = Date.parse("2026-11-05T00:00:00Z");
    for (let i = 0; i < 2; i++) {
      const session = startSession(
        state,
        "demo",
        defaultSelection,
        "study",
        at + i * 10,
        [state.data.questions[0]],
      );
      answer(state, session.id, (i + 1) as 1 | 2, at + i * 10 + 1);
      finish(state, session.id, at + i * 10 + 2);
    }
    const original = structuredClone(state),
      projection = emptyProjection();
    const ordered = reconcileOrder(state, projection);
    expect(Object.keys(ordered.projection.order)).toHaveLength(2);
    expect(state).toEqual(original);
    expect(projection).toEqual(emptyProjection());
    const copy = vi.spyOn(globalThis, "structuredClone");
    const repeated = applyEvents(ordered.state, ordered.projection, []);
    expect(
      copy.mock.calls.some(
        (args) => args[0] === ordered.state || args[0] === ordered.state.data,
      ),
    ).toBe(false);
    copy.mockRestore();
    expect(repeated.state).toEqual(ordered.state);
    expect(repeated.projection).toEqual(ordered.projection);
    expect(repeated.state.sessions).toEqual(original.sessions);
  });
  it("keeps existing cycle and conflict checks in an empty pull", () => {
    const state = initialOriginalState("demo"),
      at = Date.parse("2026-11-05T00:00:00Z");
    for (let i = 0; i < 2; i++) {
      const session = startSession(
        state,
        "demo",
        defaultSelection,
        "study",
        at + i * 10,
        [state.data.questions[0]],
      );
      answer(state, session.id, (i + 1) as 1 | 2, at + i * 10 + 1);
      finish(state, session.id, at + i * 10 + 2);
    }
    const projection = emptyProjection();
    state.attempts.forEach(
      (a, i) =>
        (projection.order[a.attemptId] = {
          deviceId: "device-" + i,
          deviceSequence: 1,
          baseCursor: 0,
          clock: null,
        }),
    );
    const result = applyEvents(state, projection, []);
    expect(result.projection.responseConflicts).toHaveLength(1);
    expect(result.projection.responseConflicts[0].attemptIds.sort()).toEqual(
      state.attempts.map((a) => a.attemptId).sort(),
    );
    expect(result.state.attempts.map((a) => a.result)).toEqual(
      state.attempts.map((a) => a.result),
    );
  });
});
