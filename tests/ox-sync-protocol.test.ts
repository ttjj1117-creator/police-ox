import { describe, expect, it } from "vitest";
import { defaultSelection, type State } from "../src/domain/schema";
import { initialState } from "../src/fixtures/data";
import { latest, next, startSession, submit } from "../src/domain/engine";
import {
  applyEvents,
  applyLocalEvents,
  buildEvents,
  emptyProjection,
  keyOf,
  mergeMigrationBank,
  reconcileOrder,
  validateState,
} from "../src/ox-sync/protocol";
import { attachHints } from "../src/ox-sync/view";
import type { Context, ReceivedEvent, SyncEvent } from "../src/ox-sync/types";
const context = (id = "pc", extra: Partial<Context> = {}): Context => ({
  deviceId: id,
  nextSequence: 1,
  baseCursor: 0,
  bankVersion: 0,
  ...extra,
});
function bank() {
  const state = initialState(true);
  state.dataset.datasetId = "police-personal";
  return state;
}
function completed(
  response: "O" | "X" | "unknown" = "O",
  id = "pc",
  extra: Partial<Context> = {},
) {
  const previous = bank(),
    state = structuredClone(previous);
  startSession(state, { ...defaultSelection, limit: 10 }, [
    state.dataset.items[0],
  ]);
  const s = state.sessions[0];
  submit(state, s.id, response);
  next(state, s.id);
  return {
    previous,
    state,
    event: buildEvents(previous, state, context(id, extra)).events.find(
      (e): e is Extract<SyncEvent, { kind: "session" }> => e.kind === "session",
    )!,
  };
}
const received = (
  event: SyncEvent,
  seq = 1,
  bankVersion = 0,
): ReceivedEvent => ({ event, seq, bankVersion });
describe("OX immutable event projection", () => {
  it("keeps original snapshots, judgment basis, IDs and timestamps", () => {
    const c = completed();
    const r = applyEvents(bank(), emptyProjection(), [received(c.event)]);
    expect(r.state.sessions[0].items).toEqual(c.state.sessions[0].items);
    expect(r.state.attempts).toEqual(c.state.attempts);
    expect(r.state.sessions[0].cycleKey).toBeNull();
    expect(r.state.attempts[0].basis).toBe("current");
  });
  it("keeps active answers local, then emits a closed session exactly once", () => {
    const previous = bank(),
      state = structuredClone(previous);
    startSession(state, defaultSelection, [state.dataset.items[0]]);
    submit(state, state.sessions[0].id, "O");
    const first = buildEvents(previous, state, context());
    expect(first.events).toHaveLength(0);
    expect(first.order[state.attempts[0].attemptId]).toBeDefined();
    const ended = structuredClone(state);
    next(ended, ended.sessions[0].id);
    const closed = buildEvents(
      state,
      ended,
      context("pc", { order: first.order, nextSequence: first.nextSequence }),
    );
    expect(closed.events.map((e) => e.kind)).toEqual(["session"]);
    expect(buildEvents(ended, ended, context()).events).toHaveLength(0);
  });
  it("replays duplicates without duplicating sessions or attempts", () => {
    const c = completed(),
      r = applyEvents(bank(), emptyProjection(), [received(c.event)]),
      again = applyEvents(r.state, r.projection, [received(c.event)]);
    expect(again.state.attempts).toHaveLength(1);
    expect(again.state.sessions).toHaveLength(1);
  });
  it("quarantines a changed same-ID event and keeps both raw versions", () => {
    const c = completed(),
      r = applyEvents(bank(), emptyProjection(), [received(c.event)]),
      changed = structuredClone(c.event);
    changed.payload.attempts[0].answeredAt = "2000-01-01T00:00:00.000Z";
    const again = applyEvents(r.state, r.projection, [received(changed, 2)]);
    expect(again.state.attempts).toEqual(c.state.attempts);
    expect(again.projection.conflicts[0].event).toEqual(changed);
  });
  it("quarantines conflicting session IDs without partially inserting attempts", () => {
    const c = completed(),
      r = applyEvents(bank(), emptyProjection(), [received(c.event)]),
      changed = structuredClone(c.event);
    changed.eventId = crypto.randomUUID();
    changed.payload.session.createdAt = "2000-01-01T00:00:00.000Z";
    const again = applyEvents(r.state, r.projection, [received(changed, 2)]);
    expect(again.state.attempts).toHaveLength(1);
    expect(again.projection.conflicts[0].kind).toBe("record");
  });
  it("quarantines conflicting attempt IDs from another session", () => {
    const a = completed(),
      b = completed("X", "tab");
    b.event.payload.attempts[0].attemptId =
      a.event.payload.attempts[0].attemptId;
    b.event.payload.order = {
      [a.event.payload.attempts[0].attemptId]: {
        deviceId: "tab",
        deviceSequence: 1,
        baseCursor: 0,
        clock: null,
      },
    };
    const r = applyEvents(bank(), emptyProjection(), [
      received(a.event, 1),
      received(b.event, 2),
    ]);
    expect(r.state.sessions).toHaveLength(1);
    expect(r.projection.conflicts).toHaveLength(1);
  });
  it("never rewrites closed synced records on a local save", () => {
    const c = completed(),
      changed = structuredClone(c.state);
    changed.attempts[0].answeredAt = "2000-01-01T00:00:00.000Z";
    expect(() => buildEvents(c.state, changed, context())).toThrow(
      "변경하거나 삭제",
    );
  });
  it("retains deleted-item historical attempts and snapshots with a tombstone", () => {
    const c = completed(),
      r = applyEvents(bank(), emptyProjection(), [received(c.event)]),
      state = structuredClone(r.state);
    state.dataset.items = [];
    state.marks = {};
    const e = buildEvents(r.state, state, context()).events.find(
      (e) => e.kind === "bank",
    )!;
    const removed = applyEvents(r.state, r.projection, [received(e, 2, 1)]);
    expect(removed.state.dataset.items).toHaveLength(0);
    expect(removed.state.attempts).toHaveLength(1);
    expect(removed.state.sessions[0].items).toHaveLength(1);
    expect(removed.projection.itemTombstones).toContain(
      c.state.dataset.items[0].id,
    );
    expect(validateState(removed.state)).toBeTruthy();
  });
  it("does not resurrect a tombstoned item from an old migration", () => {
    const p = emptyProjection(),
      s = bank();
    p.itemTombstones = [s.dataset.items[0].id];
    const current = structuredClone(s.dataset);
    current.items = current.items.slice(1);
    expect(
      mergeMigrationBank(current, s.dataset, p).items.some(
        (i) => i.id === s.dataset.items[0].id,
      ),
    ).toBe(false);
  });
  it("allows explicit restoration with a newer bank event", () => {
    const initial = bank(),
      state = structuredClone(initial);
    state.dataset.items = [];
    const e = buildEvents(initial, state, context()).events[0],
      deleted = applyEvents(initial, emptyProjection(), [received(e, 1, 1)]);
    const restore = buildEvents(
        state,
        initial,
        context("pc", { bankVersion: 1 }),
      ).events[0],
      restored = applyEvents(deleted.state, deleted.projection, [
        received(restore, 2, 2),
      ]);
    expect(restored.state.dataset.items.length).toBe(
      initial.dataset.items.length,
    );
    expect(restored.projection.itemTombstones).toHaveLength(0);
  });
  it("sends mark removal as false rather than losing the deletion", () => {
    const before = bank(),
      key = keyOf(before.dataset.items[0].id, "current");
    before.marks[key] = true;
    const after = structuredClone(before);
    delete after.marks[key];
    const e = buildEvents(before, after, context()).events[0];
    expect(e).toMatchObject({
      kind: "mark",
      payload: { questionId: key, value: false, baseMarkVersion: 0 },
    });
    expect(
      applyEvents(before, emptyProjection(), [
        { ...received(e), markVersion: 1 },
      ]).state.marks[key],
    ).toBe(false);
  });
  it("does not revive dangling marks when deleting a question", () => {
    const before = bank(),
      key = keyOf(before.dataset.items[0].id, "current");
    before.marks[key] = true;
    const after = structuredClone(before);
    after.dataset.items = after.dataset.items.slice(1);
    delete after.marks[key];
    expect(
      buildEvents(before, after, context()).events.map((e) => e.kind),
    ).toEqual(["bank"]);
  });
  it("uses causal cursor order even when the later device clock is old", () => {
    const a = completed("O", "pc"),
      b = completed("X", "tab", { baseCursor: 1 });
    b.event.payload.attempts[0].answeredAt = "2000-01-01T00:00:00.000Z";
    const r = applyEvents(bank(), emptyProjection(), [
        received(a.event, 1),
        received(b.event, 2),
      ]),
      hinted = attachHints(r.state, r.projection);
    expect(latest(hinted, hinted.dataset.items[0], "current")?.attemptId).toBe(
      b.event.payload.attempts[0].attemptId,
    );
    expect(r.projection.responseConflicts).toHaveLength(0);
  });
  it("does not choose a winner from untrusted cross-device timestamps", () => {
    const a = completed("O", "pc"),
      b = completed("X", "tab");
    a.event.payload.attempts[0].answeredAt = "2099-01-01T00:00:00.000Z";
    const r = applyEvents(bank(), emptyProjection(), [
        received(a.event, 1),
        received(b.event, 2),
      ]),
      hinted = attachHints(r.state, r.projection);
    expect(r.projection.responseConflicts).toHaveLength(1);
    expect(latest(hinted, hinted.dataset.items[0], "current")).toBeUndefined();
    expect(r.state.attempts).toHaveLength(2);
  });
  it("keeps current and exam judgment bases independent", () => {
    const a = completed("O", "pc"),
      b = completed("X", "tab");
    b.event.payload.session.selection.basis = "exam";
    b.event.payload.attempts[0].basis = "exam";
    const r = applyEvents(bank(), emptyProjection(), [
      received(a.event, 1),
      received(b.event, 2),
    ]);
    expect(r.projection.responseConflicts).toHaveLength(0);
    expect(Object.keys(r.projection.representatives)).toHaveLength(2);
  });
  it("resolves ambiguous order only to an actual candidate without deleting originals", () => {
    const a = completed("O", "pc"),
      b = completed("X", "tab"),
      r = applyEvents(bank(), emptyProjection(), [
        received(a.event, 1),
        received(b.event, 2),
      ]),
      id = keyOf(r.state.dataset.items[0].id, "current"),
      conflict = r.projection.responseConflicts[0],
      event: SyncEvent = {
        protocolVersion: 1,
        eventId: crypto.randomUUID(),
        deviceId: "pc",
        deviceSequence: 100,
        baseCursor: 2,
        createdAt: new Date().toISOString(),
        kind: "resolution",
        payload: {
          questionId: id,
          gradingRevision: 1,
          attemptId: a.event.payload.attempts[0].attemptId,
          candidateAttemptIds: conflict.attemptIds!,
        },
      },
      resolved = applyLocalEvents(r.state, r.projection, [event]);
    expect(resolved.projection.responseConflicts).toHaveLength(0);
    expect(resolved.state.attempts).toHaveLength(2);
    expect(resolved.projection.representatives[id]).toBe(
      event.payload.attemptId,
    );
  });
  it("invalidates an old choice when another concurrent response arrives", () => {
    const a = completed("O", "pc"),
      b = completed("X", "tab"),
      c = completed("unknown", "phone"),
      r = applyEvents(bank(), emptyProjection(), [
        received(a.event, 1),
        received(b.event, 2),
      ]),
      key = keyOf(r.state.dataset.items[0].id, "current");
    r.projection.resolutions[key] = {
      questionId: key,
      gradingRevision: 1,
      attemptId: a.event.payload.attempts[0].attemptId,
      candidateAttemptIds: r.projection.responseConflicts[0].attemptIds!,
      serverSequence: 3,
    };
    const resolved = reconcileOrder(r.state, r.projection);
    expect(resolved.projection.responseConflicts).toHaveLength(0);
    expect(
      applyEvents(resolved.state, resolved.projection, [received(c.event, 4)])
        .projection.responseConflicts,
    ).toHaveLength(1);
  });
  it("defers remote bank and sessions until the local active session ends", () => {
    const local = bank();
    startSession(local, defaultSelection, [local.dataset.items[0]]);
    const remote = completed("X", "tab"),
      changed = bank();
    changed.dataset.items = changed.dataset.items.slice(1);
    const e = buildEvents(bank(), changed, context("tab")).events[0],
      r = applyEvents(local, emptyProjection(), [
        received(e, 1, 1),
        received(remote.event, 2, 1),
      ]);
    expect(r.projection.deferred).toHaveLength(2);
    expect(r.state.dataset.items.length).toBe(local.dataset.items.length);
    r.state.sessions[0].status = "ended";
    const later = applyEvents(r.state, r.projection, []);
    expect(later.projection.deferred).toHaveLength(0);
    expect(later.state.sessions).toHaveLength(2);
    expect(later.state.dataset.items.length).toBe(
      local.dataset.items.length - 1,
    );
  });
  it("preserves both banks when same revision contains different text", () => {
    const original = bank(),
      changed = structuredClone(original);
    changed.dataset.items[0].displayText += " changed";
    const e = buildEvents(original, changed, context()).events[0],
      r = applyEvents(original, emptyProjection(), [received(e, 1, 1)]);
    expect(r.state.dataset).toEqual(original.dataset);
    expect(r.projection.conflicts[0].event).toEqual(e);
    expect(r.projection.bankVersion).toBe(1);
  });
});
