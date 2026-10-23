import { describe, expect, it } from "vitest";
import {
  answer,
  defaultSelection,
  finish,
  initialOriginalState,
  selectQuestions,
  startSession,
} from "../src/original/engine";
import type { OriginalState } from "../src/original/engine";
import { demoData } from "../src/original/demo";
import { validateOriginalState } from "../src/original/storage";
import {
  applyEvents,
  applyLocalEvents,
  buildEvents,
  createResolutionEvent,
  emptyProjection,
  getOrderConflictIds,
  mergeMigrationBank,
  reconcileOrder,
} from "../src/original/sync/protocol";
import type {
  BuildContext,
  ReceivedEvent,
  SyncEvent,
  SyncProjection,
} from "../src/original/sync/types";
const t0 = Date.parse("2026-10-23T00:00:00Z");
function bank(): OriginalState {
  const state = initialOriginalState("real"),
    q = structuredClone(demoData().questions[0]);
  q.id = "const_2026_1_1";
  q.source.examCode = "po";
  q.officialAnswer.status = "final";
  q.source.questionPdf = { fileName: "test-question.pdf", pages: [1] };
  q.source.answerPdf = {
    fileName: "test-answer.pdf",
    pages: [1],
    subjectColumn: "헌법",
  };
  q.officialAnswer.acceptedChoices = [1];
  state.data.questions = [q];
  return state;
}
const context = (
  deviceId = "device-a",
  override: Partial<BuildContext> = {},
): BuildContext => ({
  deviceId,
  nextSequence: 1,
  baseCursor: 0,
  bankVersion: 0,
  clock: { offsetMs: 0, uncertaintyMs: 10 },
  ...override,
});
function complete(
  response: 1 | 2 | "unknown" = 1,
  at = t0,
  deviceId = "device-a",
  ctx: Partial<BuildContext> = {},
) {
  const previous = bank(),
    state = structuredClone(previous);
  const s = startSession(
    state,
    "real",
    { ...defaultSelection, limit: 1 },
    "study",
    at,
  );
  answer(state, s.id, response, at + 1000);
  finish(state, s.id, at + 2000);
  const built = buildEvents(previous, state, context(deviceId, ctx));
  return {
    previous,
    state,
    built,
    event: built.events.find((e) => e.kind === "session")!,
  };
}
function received(
  event: SyncEvent,
  seq: number,
  bankVersion = event.kind === "bank" ? event.payload.baseVersion + 1 : 0,
): ReceivedEvent {
  return { event, seq, bankVersion };
}
const apply = (
  events: ReceivedEvent[],
  projection: SyncProjection = emptyProjection(),
  state = bank(),
) => applyEvents(state, projection, events);
describe("immutable local outbox generation", () => {
  it("connects a partial old bank additively and never treats an empty source as cloud deletion", () => {
    const current = bank().data,
      incoming = bank().data;
    incoming.questions[0].id = "const_2026_1_2";
    incoming.questions[0].source.questionNumber = 2;
    expect(
      mergeMigrationBank(current, incoming, emptyProjection()).questions.map(
        (q) => q.id,
      ),
    ).toEqual(["const_2026_1_1", "const_2026_1_2"]);
    expect(
      mergeMigrationBank(
        current,
        initialOriginalState("real").data,
        emptyProjection(),
      ),
    ).toEqual(current);
  });
  it("preserves newer cloud revisions and refuses changed same-revision records", () => {
    const current = bank().data,
      incoming = bank().data;
    current.questions[0].revision = 2;
    expect(
      mergeMigrationBank(current, incoming, emptyProjection()).questions[0]
        .revision,
    ).toBe(2);
    incoming.questions[0].revision = 2;
    incoming.questions[0].qa.notes.push("changed");
    expect(() =>
      mergeMigrationBank(current, incoming, emptyProjection()),
    ).toThrow("같은 revision");
  });
  it("does not reattach tombstoned source packages or revive deleted questions during migration", () => {
    const incoming = bank().data,
      projection = emptyProjection();
    projection.questionTombstones = [incoming.questions[0].id];
    expect(
      mergeMigrationBank(
        initialOriginalState("real").data,
        incoming,
        projection,
      ).questions,
    ).toEqual([]);
  });
  it("creates a bank event without syncing settings or OX state", () => {
    const before = initialOriginalState("real"),
      next = bank();
    next.settings.fontScale = 2;
    const built = buildEvents(before, next, context());
    expect(built.events.map((e) => e.kind)).toEqual(["bank"]);
    expect(built.events[0]).not.toHaveProperty("payload.settings");
    expect(built.events[0]).not.toHaveProperty("ox");
  });
  it("does not mistake an empty unchanged local bank for a cloud delete", () => {
    const state = initialOriginalState("real");
    expect(buildEvents(state, state, context()).events).toEqual([]);
  });
  it("assigns durable local order to active answers but never uploads their active session", () => {
    const previous = bank(),
      state = structuredClone(previous),
      s = startSession(state, "real", defaultSelection, "study", t0);
    answer(state, s.id, 1, t0 + 1000);
    const built = buildEvents(previous, state, context());
    expect(built.events).toEqual([]);
    expect(built.order[state.attempts[0].attemptId]).toMatchObject({
      deviceId: "device-a",
      deviceSequence: 1,
    });
    const ended = structuredClone(state);
    finish(ended, s.id, t0 + 2000);
    const close = buildEvents(
      state,
      ended,
      context("device-a", {
        order: built.order,
        nextSequence: built.nextSequence,
      }),
    );
    expect(close.events.map((e) => e.kind)).toEqual(["session"]);
    expect(close.order).toEqual(built.order);
  });
  it("exports ended partial study sessions without inventing unanswered attempts", () => {
    const previous = bank(),
      state = structuredClone(previous);
    const s = startSession(state, "real", defaultSelection, "study", t0);
    finish(state, s.id, t0 + 1000);
    const event = buildEvents(previous, state, context()).events[0];
    expect(event.kind).toBe("session");
    if (event.kind === "session") {
      expect(event.payload.session.status).toBe("ended");
      expect(event.payload.attempts).toEqual([]);
    }
  });
  it("retains IDs/timestamps and assigns original equal-time commit order", () => {
    const first = complete(2),
      next = structuredClone(first.state);
    const s = startSession(next, "real", defaultSelection, "study", t0);
    answer(next, s.id, 1, t0 + 1000);
    finish(next, s.id, t0 + 2000);
    const b = buildEvents(initialOriginalState("real"), next, context());
    expect(b.order[next.attempts[0].attemptId].deviceSequence).toBeLessThan(
      b.order[next.attempts[1].attemptId].deviceSequence,
    );
    const e = b.events.filter((e) => e.kind === "session");
    expect(e).toHaveLength(2);
    if (e[0].kind === "session")
      expect(e[0].payload.attempts[0]).toEqual(next.attempts[0]);
  });
  it("records mark unset and chains pending mark and bank CAS versions", () => {
    const prev = bank();
    prev.marks[prev.data.questions[0].id] = true;
    const next = structuredClone(prev);
    next.marks[next.data.questions[0].id] = false;
    next.data.questions[0].revision++;
    const one = buildEvents(
      prev,
      next,
      context("device-a", {
        bankVersion: 3,
        markVersions: { [prev.data.questions[0].id]: 7 },
      }),
    );
    const later = structuredClone(next);
    later.marks[next.data.questions[0].id] = true;
    later.data.questions[0].revision++;
    const two = buildEvents(
      next,
      later,
      context("device-a", {
        bankVersion: 3,
        markVersions: { [prev.data.questions[0].id]: 7 },
        pendingEvents: one.events,
        nextSequence: one.nextSequence,
      }),
    );
    expect(one.events.find((e) => e.kind === "mark")!.payload).toMatchObject({
      value: false,
      baseMarkVersion: 7,
    });
    expect(two.events.find((e) => e.kind === "mark")!.payload).toMatchObject({
      value: true,
      baseMarkVersion: 8,
    });
    expect(two.events.find((e) => e.kind === "bank")!.payload).toMatchObject({
      baseVersion: 4,
    });
  });
  it("records question/package tombstones and explicit intentional restoration", () => {
    const previous = bank(),
      next = initialOriginalState("real");
    const removed = buildEvents(previous, next, context()).events[0];
    expect(removed.payload).toMatchObject({
      questionTombstones: [previous.data.questions[0].id],
    });
    const restored = buildEvents(next, previous, context()).events[0];
    expect(restored.payload).toMatchObject({
      restoredQuestionIds: [previous.data.questions[0].id],
    });
  });
  it("previews local migration without fabricating server acknowledgement or causal sequence", () => {
    const a = complete(2),
      local = applyLocalEvents(bank(), emptyProjection(), [a.event]);
    expect(local.state.attempts).toHaveLength(1);
    expect(local.projection.bankVersion).toBe(0);
    expect(local.projection.seenEvents).toEqual({});
    expect(
      local.projection.order[a.state.attempts[0].attemptId].serverSequence,
    ).toBeUndefined();
  });
  it("reconciles new offline local answers without marking their outbox as transmitted", () => {
    const a = complete(2),
      projection = emptyProjection();
    projection.order = a.built.order;
    const r = reconcileOrder(a.state, projection);
    expect(r.state.attempts).toEqual(a.state.attempts);
    expect(r.projection.seenEvents).toEqual({});
    expect(r.projection.bankVersion).toBe(0);
  });
});
describe("atomic completed session merge", () => {
  it("applies a whole bundle once despite event retry and lost acknowledgement", () => {
    const a = complete(2);
    const first = apply([received(a.event, 1)]);
    const again = applyEvents(first.state, first.projection, [
      received(a.event, 1),
    ]);
    expect(again.state.sessions).toHaveLength(1);
    expect(again.state.attempts).toHaveLength(1);
    expect(again.state.attempts[0]).toEqual(a.state.attempts[0]);
  });
  it("deduplicates the same completed session sent with another event ID", () => {
    const a = complete(2),
      event = structuredClone(a.event);
    event.eventId = crypto.randomUUID();
    const r = apply([received(a.event, 1), received(event, 2)]);
    expect(r.state.attempts).toHaveLength(1);
    expect(r.state.sessions).toHaveLength(1);
  });
  it("preserves independent sessions from two devices", () => {
    const a = complete(2),
      b = complete(1, t0 + 10000, "device-b");
    const r = apply([received(a.event, 1), received(b.event, 2)]);
    expect(r.state.sessions).toHaveLength(2);
    expect(r.state.attempts).toHaveLength(2);
  });
  it("keeps both snapshots available by preserving rejected same-ID different content as conflict", () => {
    const a = complete(2),
      changed = structuredClone(a.event);
    changed.eventId = crypto.randomUUID();
    if (changed.kind === "session")
      changed.payload.session.review[a.state.data.questions[0].id] = true;
    const r = apply([received(a.event, 1), received(changed, 2)]);
    expect(r.state.sessions).toHaveLength(1);
    expect(r.projection.recordConflicts[0].event).toEqual(changed);
  });
  it("does not partially add a bundle when any required attempt is missing", () => {
    const a = complete(),
      bad = structuredClone(a.event);
    if (bad.kind === "session") bad.payload.attempts = [];
    const r = apply([received(bad, 1)]);
    expect(r.state.sessions).toEqual([]);
    expect(r.state.attempts).toEqual([]);
    expect(r.projection.recordConflicts).toHaveLength(1);
  });
  it("rejects active remote sessions and broken mandatory asset references", () => {
    const a = complete(),
      active = structuredClone(a.event);
    if (active.kind === "session") active.payload.session.status = "active";
    expect(
      apply([received(active, 1)]).projection.recordConflicts,
    ).toHaveLength(1);
    const image = structuredClone(a.event);
    if (image.kind === "session")
      image.payload.session.questions[0].body.push({
        type: "image",
        assetId: "missing",
        alt: "표",
      });
    expect(apply([received(image, 1)]).state.sessions).toEqual([]);
  });
  it("can receive a closed historical snapshot before its bank without exposing it as a new eligible question", () => {
    const a = complete(2),
      r = apply(
        [received(a.event, 1)],
        emptyProjection(),
        initialOriginalState("real"),
      );
    expect(r.state.data.questions[0].id).toBe(a.state.data.questions[0].id);
    expect(r.state.removedQuestionIds).toContain(a.state.data.questions[0].id);
    expect(r.state.attempts).toHaveLength(1);
  });
  it("stages a newer session snapshot until its bank arrives instead of permanently acknowledging a conflict", () => {
    const a = complete(2),
      event = structuredClone(a.event);
    if (event.kind !== "session") throw new Error("fixture");
    event.payload.session.questions[0].revision = 2;
    event.payload.attempts[0].revision = 2;
    const held = apply([received(event, 1)]);
    expect(held.state.sessions).toEqual([]);
    expect(held.projection.deferred).toHaveLength(1);
    expect(held.projection.seenEvents[event.eventId]).toBeUndefined();
    const fresh = bank();
    fresh.data.questions[0].revision = 2;
    const bankEvent = buildEvents(bank(), fresh, context()).events[0];
    const withBank = applyEvents(held.state, held.projection, [
      received(bankEvent, 2, 1),
    ]);
    const ready = applyEvents(withBank.state, withBank.projection, []);
    expect(ready.state.sessions).toHaveLength(1);
    expect(ready.projection.deferred).toEqual([]);
    expect(ready.projection.recordConflicts).toEqual([]);
  });
  it("retains referenced raster assets when a historical image session arrives before its bank", async () => {
    const a = complete(2),
      event = structuredClone(a.event);
    if (event.kind !== "session") throw new Error("fixture");
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQsUn5DwAC0AG0vqck9wAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const sha256 = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    event.payload.session.questions[0].body.push({
      type: "image",
      assetId: "history-image",
      alt: "기능 검증용 점",
    });
    event.payload.session.assets.push({
      assetId: "history-image",
      mimeType: "image/png",
      base64,
      sha256,
    });
    const r = apply(
      [received(event, 1)],
      emptyProjection(),
      initialOriginalState("real"),
    );
    expect(r.state.data.assets).toHaveLength(1);
    await expect(validateOriginalState(r.state, "real")).resolves.toBeDefined();
  });
});
describe("original response ordering and explicit K resolution", () => {
  it("does not let a late old offline wrong answer displace a later calibrated correct answer", () => {
    const old = complete(2, t0, "device-a"),
      newer = complete(1, t0 + 86400000, "device-b");
    const r = apply([received(newer.event, 1), received(old.event, 2)]);
    expect(r.state.attempts.at(-1)!.result).toBe("correct");
    expect(getOrderConflictIds(r.projection)).toEqual([]);
    expect(
      r.state.attempts.find((a) => a.result === "incorrect")!.answeredAt,
    ).toBe(old.state.attempts[0].answeredAt);
  });
  it("preserves same-device equal-time and backwards-clock local commit ordering", () => {
    const old = complete(2, t0 + 86400000, "device-a", { nextSequence: 1 }),
      newer = complete(1, t0, "device-a", { nextSequence: 10 });
    const r = apply([received(newer.event, 1), received(old.event, 2)]);
    expect(r.state.attempts.at(-1)!.result).toBe("correct");
    expect(getOrderConflictIds(r.projection)).toEqual([]);
  });
  it("holds uncertain concurrent cross-device responses as K instead of choosing the last arrival", () => {
    const a = complete(2, t0, "device-a", { clock: null }),
      b = complete(1, t0 + 86400000, "device-b", { clock: null });
    const r = apply([received(a.event, 1), received(b.event, 2)]);
    expect(getOrderConflictIds(r.projection)).toEqual([
      a.state.data.questions[0].id,
    ]);
    expect(r.projection.responseConflicts[0].attemptIds).toHaveLength(2);
    expect(r.state.attempts).toHaveLength(2);
  });
  it("also holds overlapping calibrated clock intervals as uncertain", () => {
    const a = complete(2, t0, "device-a", {
        clock: { offsetMs: 0, uncertaintyMs: 5000 },
      }),
      b = complete(1, t0 + 1000, "device-b", {
        clock: { offsetMs: 0, uncertaintyMs: 5000 },
      });
    expect(
      getOrderConflictIds(
        apply([received(a.event, 1), received(b.event, 2)]).projection,
      ),
    ).toHaveLength(1);
  });
  it("does not trust a month-old calibration to decide offline device chronology", () => {
    const sample = {
      offsetMs: 0,
      uncertaintyMs: 1,
      sampledAt: "2026-09-01T00:00:00Z",
    };
    const a = complete(2, t0, "device-a", { clock: sample }),
      b = complete(1, t0 + 86400000, "device-b", { clock: sample });
    expect(
      getOrderConflictIds(
        apply([received(a.event, 1), received(b.event, 2)]).projection,
      ),
    ).toHaveLength(1);
  });
  it("uses observed server cursor causality even if a later device clock goes backwards", () => {
    const a = complete(2, t0 + 86400000, "device-a", { clock: null }),
      b = complete(1, t0, "device-b", { clock: null, baseCursor: 1 });
    const r = apply([received(a.event, 1), received(b.event, 2)]);
    expect(getOrderConflictIds(r.projection)).toEqual([]);
    expect(r.state.attempts.at(-1)!.result).toBe("correct");
  });
  it("does not lose known causality when an old completed bundle is imported again", () => {
    const a = complete(2, t0, "device-a", { clock: null }),
      b = complete(1, t0, "device-b", { clock: null, baseCursor: 1 });
    const first = apply([received(a.event, 1), received(b.event, 2)]),
      duplicate = structuredClone(a.event);
    duplicate.eventId = crypto.randomUUID();
    const again = applyEvents(first.state, first.projection, [
      received(duplicate, 3),
    ]);
    expect(
      again.projection.order[a.state.attempts[0].attemptId].serverSequence,
    ).toBe(1);
    expect(getOrderConflictIds(again.projection)).toEqual([]);
    expect(again.state.attempts.at(-1)!.result).toBe("correct");
  });
  it("resolves to a user-chosen actual record while retaining both original attempts", () => {
    const a = complete(2, t0, "device-a", { clock: null }),
      b = complete(1, t0, "device-b", { clock: null });
    const r = apply([received(a.event, 1), received(b.event, 2)]),
      c = r.projection.responseConflicts[0];
    const resolution = createResolutionEvent(
      context("device-a", { nextSequence: 30, baseCursor: 2 }),
      c.questionId,
      c.gradingRevision,
      a.state.attempts[0].attemptId,
      c.attemptIds,
    );
    const resolved = applyEvents(r.state, r.projection, [
      received(resolution, 3),
    ]);
    expect(getOrderConflictIds(resolved.projection)).toEqual([]);
    expect(resolved.state.attempts.at(-1)!.result).toBe("incorrect");
    expect(resolved.state.attempts).toHaveLength(2);
    expect(new Set(resolved.state.attempts.map((a) => a.attemptId))).toEqual(
      new Set(r.state.attempts.map((a) => a.attemptId)),
    );
  });
  it("invalidates an old resolution when a new concurrent candidate arrives", () => {
    const a = complete(2, t0, "device-a", { clock: null }),
      b = complete(1, t0, "device-b", { clock: null });
    let r = apply([received(a.event, 1), received(b.event, 2)]),
      c = r.projection.responseConflicts[0];
    const resolution = createResolutionEvent(
      context(),
      c.questionId,
      c.gradingRevision,
      a.state.attempts[0].attemptId,
      c.attemptIds,
    );
    r = applyEvents(r.state, r.projection, [received(resolution, 3)]);
    const third = complete("unknown", t0, "device-c", { clock: null });
    expect(
      getOrderConflictIds(
        applyEvents(r.state, r.projection, [received(third.event, 4)])
          .projection,
      ),
    ).toHaveLength(1);
  });
  it("rejects a fabricated representative attempt ID", () => {
    expect(() =>
      createResolutionEvent(context(), "q", 1, "not-a-record", [
        "actual-record",
      ]),
    ).toThrow("실제 충돌 응답");
  });
  it("converges independent arrival order to the same attempt order and conflict set", () => {
    const a = complete(2, t0, "device-a", { clock: null }),
      b = complete(1, t0, "device-b", { clock: null });
    const first = apply([received(a.event, 1), received(b.event, 2)]),
      second = apply([received(b.event, 2), received(a.event, 1)]);
    expect(first.state.attempts).toEqual(second.state.attempts);
    expect(first.projection.responseConflicts).toEqual(
      second.projection.responseConflicts,
    );
  });
  it("ignores old grading revisions and blank submissions when deciding response conflicts", () => {
    const a = complete(2),
      b = complete(1, t0, "device-b", { clock: null });
    const local = bank();
    local.data.questions[0].revision = 2;
    local.data.questions[0].gradingRevision = 2;
    const r = apply(
      [received(a.event, 1), received(b.event, 2)],
      emptyProjection(),
      local,
    );
    expect(getOrderConflictIds(r.projection)).toEqual([]);
  });
});
describe("bank versions, tombstones, marks and active-session staging", () => {
  it("propagates mark unset and ignores older mark versions", () => {
    const q = bank().data.questions[0],
      base = context();
    const set: SyncEvent = {
      protocolVersion: 1,
      eventId: "mark-set",
      deviceId: base.deviceId,
      deviceSequence: 1,
      baseCursor: 0,
      createdAt: new Date(t0).toISOString(),
      kind: "mark",
      payload: { questionId: q.id, value: true, baseMarkVersion: 0 },
    };
    const unset = structuredClone(set);
    unset.eventId = "mark-unset";
    unset.payload = { questionId: q.id, value: false, baseMarkVersion: 1 };
    const r = apply([
      { ...received(unset, 2), markVersion: 2 },
      { ...received(set, 1), markVersion: 1 },
    ]);
    expect(r.state.marks[q.id]).toBe(false);
    expect(r.projection.markVersions[q.id]).toBe(2);
  });
  it("does not resurrect a deleted question from an older bank event", () => {
    const original = bank(),
      initial = initialOriginalState("real");
    const add = buildEvents(initial, original, context()).events[0],
      remove = buildEvents(
        original,
        initial,
        context("device-a", { bankVersion: 1, nextSequence: 10 }),
      ).events[0];
    const r = apply(
      [
        received(add, 1, 1),
        received(remove, 2, 2),
        received({ ...add, eventId: "stale-new-id" }, 3, 1),
      ],
      emptyProjection(),
      initial,
    );
    expect(r.state.data.questions).toEqual([]);
    expect(r.projection.questionTombstones).toContain(
      original.data.questions[0].id,
    );
  });
  it("permits explicit re-registration only at the fresh CAS bank version", () => {
    const original = bank(),
      initial = initialOriginalState("real");
    const add = buildEvents(initial, original, context()).events[0],
      remove = buildEvents(
        original,
        initial,
        context("device-a", { bankVersion: 1, nextSequence: 10 }),
      ).events[0];
    const restore = buildEvents(
      initial,
      original,
      context("device-a", { bankVersion: 2, nextSequence: 20 }),
    ).events[0];
    const r = apply(
      [received(add, 1, 1), received(remove, 2, 2), received(restore, 3, 3)],
      emptyProjection(),
      initial,
    );
    expect(r.state.data.questions).toHaveLength(1);
    expect(r.projection.questionTombstones).toEqual([]);
  });
  it("keeps a wrong-base bank in conflict instead of overwriting current content", () => {
    const next = bank();
    next.data.questions[0].revision++;
    const event = buildEvents(
      bank(),
      next,
      context("device-a", { bankVersion: 9 }),
    ).events[0];
    const r = apply([received(event, 1, 10)]);
    expect(r.state.data.questions[0].revision).toBe(1);
    expect(r.projection.bankConflicts).toHaveLength(1);
  });
  it("advances observed CAS version for a held bank so the next valid bank can recover", () => {
    const local = bank();
    local.data.questions[0].revision = 2;
    const old = buildEvents(initialOriginalState("real"), bank(), context())
      .events[0];
    const held = apply([received(old, 1, 1)], emptyProjection(), local);
    expect(held.projection.bankVersion).toBe(1);
    expect(held.state.data.questions[0].revision).toBe(2);
    const newer = bank();
    newer.data.questions[0].revision = 3;
    const next = buildEvents(
      bank(),
      newer,
      context("device-b", { bankVersion: 1 }),
    ).events[0];
    const recovered = applyEvents(held.state, held.projection, [
      received(next, 2, 2),
    ]);
    expect(recovered.projection.bankVersion).toBe(2);
    expect(recovered.state.data.questions[0].revision).toBe(3);
    expect(recovered.projection.bankConflicts).toHaveLength(1);
  });
  it("rejects answer/body changes that forgot gradingRevision even when revision increased", () => {
    const next = bank();
    next.data.questions[0].revision++;
    next.data.questions[0].body = [
      { type: "text", text: "중립 테스트 문장 변경" },
    ];
    const event = buildEvents(bank(), next, context()).events[0];
    const r = apply([received(event, 1, 1)]);
    expect(r.projection.bankConflicts[0].reason).toContain("gradingRevision");
    expect(r.state.data.questions[0].revision).toBe(1);
  });
  it("defers remote bank and record bundles while an exam is active and leaves deadline/settings intact", () => {
    const state = bank(),
      exam = startSession(state, "real", defaultSelection, "study", t0);
    exam.mode = "exam";
    exam.deadlineAt = new Date(t0 + 6000000).toISOString();
    state.settings.fontScale = 1.5;
    const remote = complete(2),
      changed = bank();
    changed.data.questions[0].revision++;
    const bankEvent = buildEvents(bank(), changed, context()).events[0];
    const staged = apply(
      [received(bankEvent, 1, 1), received(remote.event, 2, 1)],
      emptyProjection(),
      state,
    );
    expect(staged.projection.deferred).toHaveLength(2);
    expect(staged.state.sessions).toHaveLength(1);
    expect(staged.state.sessions[0].deadlineAt).toBe(exam.deadlineAt);
    expect(staged.state.settings.fontScale).toBe(1.5);
    staged.state.sessions[0].status = "ended";
    staged.state.sessions[0].finishedAt = new Date(t0 + 1000).toISOString();
    const applied = applyEvents(staged.state, staged.projection, []);
    expect(applied.projection.deferred).toEqual([]);
    expect(applied.state.sessions).toHaveLength(2);
    expect(applied.state.data.questions[0].revision).toBe(2);
    expect(applied.state.settings.fontScale).toBe(1.5);
  });
  it("does not mutate the caller's durable state, event objects or projection", () => {
    const a = complete(),
      original = bank(),
      projection = emptyProjection(),
      incoming = [received(a.event, 1)];
    const before = JSON.stringify({ original, projection, incoming });
    applyEvents(original, projection, incoming);
    expect(JSON.stringify({ original, projection, incoming })).toBe(before);
  });
  it("keeps a deleted image question's historical asset after the active device finishes and flushes a remote bank", async () => {
    const local = bank(), imageQuestion = structuredClone(local.data.questions[0]);
    imageQuestion.id = "const_2026_1_2";
    imageQuestion.source.questionNumber = 2;
    imageQuestion.body.push({ type: "image", assetId: "deleted-question-image", alt: "기능 검증용 점" });
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQsUn5DwAC0AG0vqck9wAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    local.data.questions.push(imageQuestion);
    local.data.assets.push({ assetId: "deleted-question-image", mimeType: "image/png", base64, sha256 });
    const beforeStudy = structuredClone(local);
    const study = startSession(local, "real", { ...defaultSelection, limit: 1 }, "study", t0, [imageQuestion]);
    answer(local, study.id, 1, t0 + 1000);

    // The other device removes the unique image question and its bank asset.
    const remoteDeleted = bank();
    const deletion = buildEvents(beforeStudy, remoteDeleted, context("device-b")).events.find((event) => event.kind === "bank")!;
    const staged = applyEvents(local, emptyProjection(), [received(deletion, 1, 1)]);
    expect(staged.projection.deferred).toHaveLength(1);
    expect(staged.state.data.assets).toHaveLength(1);

    finish(staged.state, study.id, t0 + 2000);
    const flushed = applyEvents(staged.state, staged.projection, []);
    expect(flushed.projection.deferred).toEqual([]);
    expect(flushed.projection.bankConflicts).toEqual([]);
    expect(flushed.state.removedQuestionIds).toContain(imageQuestion.id);
    expect(flushed.state.data.assets).toEqual(beforeStudy.data.assets);
    expect(flushed.state.sessions[0].assets).toEqual(beforeStudy.data.assets);
    expect(flushed.state.attempts[0].answeredAt).toBe(new Date(t0 + 1000).toISOString());
    expect(selectQuestions(flushed.state, "real", defaultSelection).map((question) => question.id)).toEqual(["const_2026_1_1"]);
    await expect(validateOriginalState(flushed.state, "real")).resolves.toBeDefined();
  });
});
