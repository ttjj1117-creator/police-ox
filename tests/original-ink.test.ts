import { describe, expect, it } from "vitest";
import {
  choicePointerAllowed,
  InkInputCoordinator,
  InkFingerPan,
  editInk,
  emptyInkHistory,
  eraseInk,
  inkIdentityKey,
  inkPressure,
  inkWidth,
  isDrawingPointer,
  localInkPoint,
  redoInk,
  undoInk,
  type InkIdentity,
  type InkStroke,
} from "../src/original/ink/model";
import { InkSessionMemory } from "../src/original/ink/memory";

const identity: InkIdentity = {
  ownerKey: "project|user-a",
  namespace: "real",
  sessionId: "s1",
  questionId: "q1",
  contentVersion: "render-v1:revision1",
};
const stroke = (id = "a", surfaceId = "body"): InkStroke => ({
  id,
  surfaceId,
  points: [
    { x: 2, y: 10, pressure: 0.4 },
    { x: 100, y: 10, pressure: 0.8 },
  ],
});
describe("local pencil history and input boundary", () => {
  it("keeps content-coordinate points and retains pressure on a zero-pressure pointerup", () => {
    const point = localInkPoint(
      { clientX: 37, clientY: 270, pressure: 0.7 },
      { left: 17, top: 220 },
    );
    expect(point).toEqual({ x: 20, y: 50, pressure: 0.7 });
    expect(
      localInkPoint(
        { clientX: 38, clientY: 271, pressure: 0 },
        { left: 17, top: 220 },
        point.pressure,
      ).pressure,
    ).toBe(0.7);
    expect(inkPressure(NaN)).toBe(0.5);
    expect(inkPressure(-1)).toBe(0.5);
    expect(inkWidth(0.1)).toBeGreaterThanOrEqual(1.4);
    expect(inkWidth(1)).toBeLessThanOrEqual(2.2);
  });
  it("allows only pen strokes and rejects palm choice input while keeping explicit controls", () => {
    expect(isDrawingPointer("pen")).toBe(true);
    expect(isDrawingPointer("touch")).toBe(false);
    expect(isDrawingPointer("mouse")).toBe(false);
    for (const type of ["pen", "touch", "mouse", "keyboard"])
      expect(choicePointerAllowed(type, false)).toBe(true);
    expect(choicePointerAllowed("pen", true)).toBe(false);
    expect(choicePointerAllowed("pen", false, true)).toBe(false);
    expect(choicePointerAllowed("touch", false, false, true)).toBe(false);
    expect(choicePointerAllowed("mouse", false, false, true)).toBe(true);
  });
  it("a pen contact turns existing and new touches into palms until each lifts", () => {
    let now = 100;
    const input = new InkInputCoordinator(() => now);
    input.touchDown(1);
    expect(input.canPan(1)).toBe(true);
    input.penDown(9);
    expect(input.canPan(1)).toBe(false);
    input.touchDown(2);
    expect(input.touchBlocked(2)).toBe(true);
    input.penUp(9);
    expect(input.canPan(1)).toBe(false);
    // The old palms remain invalid, but must not poison a newly started finger.
    input.touchDown(3);
    expect(input.palmBlocked(3)).toBe(false);
    expect(input.touchBlocked(3)).toBe(false);
    expect(input.canPan(3)).toBe(true);
    input.touchUp(3);
    input.touchUp(1);
    expect(input.touchBlocked(1)).toBe(true);
    input.touchUp(2);
    input.touchDown(4);
    expect(input.canPan(4)).toBe(true);
    input.touchUp(4);
    now += 1001;
    expect(input.touchBlocked(1)).toBe(false);
  });
  it("multiple fingers invalidate those gestures without poisoning a fresh finger", () => {
    const input = new InkInputCoordinator();
    input.touchDown(1);
    input.touchDown(2);
    expect(input.canPan(1)).toBe(false);
    expect(input.hasPalmTouch).toBe(false);
    expect(input.palmBlocked(2)).toBe(false);
    expect(input.touchBlocked(2)).toBe(true);
    input.touchUp(2);
    expect(input.touchBlocked(2)).toBe(true);
    expect(input.canPan(1)).toBe(false);
    input.touchDown(3);
    expect(input.canPan(3)).toBe(true);
    expect(input.palmBlocked(3)).toBe(false);
    input.touchUp(1);
    expect(input.canPan(3)).toBe(true);
  });
  it("recent ink suppresses an old stroke click without delaying fresh finger movement", () => {
    const input = new InkInputCoordinator();
    input.penDown(9);
    input.markInkGesture();
    input.penUp(9);
    expect(input.recentInkGesture()).toBe(true);
    input.touchDown(11);
    expect(input.canPan(11)).toBe(true);
    expect(input.touchBlocked(11)).toBe(false);
    input.touchUp(11);
  });
  it("a reused pointer ID starts cleanly after an invalid contact has ended", () => {
    const input = new InkInputCoordinator();
    input.penDown(9);
    input.touchDown(2);
    input.penUp(9);
    input.touchUp(2);
    expect(input.touchBlocked(2)).toBe(true);
    input.touchDown(2);
    expect(input.canPan(2)).toBe(true);
    expect(input.touchBlocked(2)).toBe(false);
  });
  it("contact reset releases pen/palm/multitouch gates and recent ink click suppression", () => {
    const input = new InkInputCoordinator();
    input.penDown(1);
    input.touchDown(2);
    input.touchDown(3);
    input.markInkGesture();
    expect(input.hasContacts).toBe(true);
    expect(input.recentInkGesture()).toBe(true);
    input.reset();
    expect(input.hasContacts).toBe(false);
    expect(input.touchBlocked(2)).toBe(false);
    expect(input.recentInkGesture()).toBe(false);
    input.touchDown(4);
    expect(input.canPan(4)).toBe(true);
  });
  it("finger movement ignores slop, locks the dominant axis, and cancels when contacts are blocked", () => {
    const pan = new InkFingerPan();
    pan.start(1, 100, 200);
    expect(pan.move(1, 102, 196, true)).toEqual({ x: 0, y: 0 });
    expect(pan.move(2, 102, 150, true)).toEqual({ x: 0, y: 0 });
    expect(pan.move(1, 104, 180, true)).toEqual({ x: 0, y: 20 });
    expect(pan.move(1, 160, 175, true)).toEqual({ x: 0, y: 5 });
    expect(pan.move(1, 160, 140, false)).toEqual({ x: 0, y: 0 });
    expect(pan.pointerId).toBeUndefined();
    expect(pan.move(1, 160, 110, true)).toEqual({ x: 0, y: 0 });
    pan.start(2, 100, 100);
    expect(pan.move(2, 70, 101, true)).toEqual({ x: 30, y: 0 });
    pan.end(2);
    expect(pan.pointerId).toBeUndefined();
  });
  it("undoes erasing and clearing without changing the original snapshots", () => {
    const initial = emptyInkHistory();
    const first = editInk(initial, [stroke()]);
    const second = editInk(first, [...first.strokes, stroke("b", "choice-1")]);
    const erased = editInk(
      second,
      eraseInk(
        second.strokes,
        "body",
        { x: 40, y: 0, pressure: 0.5 },
        { x: 40, y: 20, pressure: 0.5 },
        2,
      ),
    );
    expect(erased.strokes.map((s) => s.id)).toEqual(["b"]);
    expect(undoInk(erased).strokes).toEqual(second.strokes);
    expect(redoInk(undoInk(erased)).strokes).toEqual(erased.strokes);
    const cleared = editInk(erased, []);
    expect(undoInk(cleared).strokes).toEqual(erased.strokes);
    expect(initial.strokes).toEqual([]);
    expect(first.strokes).toEqual([stroke()]);
  });
  it("erases a whole crossed stroke even when a quick eraser segment skips its endpoints", () => {
    const initial = [stroke(), stroke("other", "choice-2")];
    const erased = eraseInk(
      initial,
      "body",
      { x: 50, y: -20, pressure: 0.5 },
      { x: 50, y: 40, pressure: 0.5 },
      2,
    );
    expect(erased.map((s) => s.id)).toEqual(["other"]);
    expect(
      eraseInk(
        initial,
        "body",
        { x: 50, y: 40, pressure: 0.5 },
        { x: 70, y: 40, pressure: 0.5 },
        2,
      ),
    ).toBe(initial);
  });
});

describe("current-learning temporary ink memory", () => {
  it("keeps the same question history and undo/redo through provider remounts", () => {
    const memory = new InkSessionMemory();
    memory.update(identity, (h) => editInk(h, [stroke()]));
    memory.update(identity, (h) => editInk(h, [...h.strokes, stroke("b")]));
    const other = { ...identity, questionId: "q2" };
    memory.update(other, (h) => editInk(h, [stroke("other")]));
    memory.update(identity, undoInk);
    expect(memory.read(identity).strokes.map((s) => s.id)).toEqual(["a"]);
    expect(memory.read(identity).redo).toHaveLength(1);
    memory.update(identity, redoInk);
    expect(memory.read(identity).strokes.map((s) => s.id)).toEqual(["a", "b"]);
    expect(memory.read(other).strokes.map((s) => s.id)).toEqual(["other"]);
  });
  it("isolates owner, real/demo, session, question and content version", () => {
    const memory = new InkSessionMemory();
    memory.update(identity, (h) => editInk(h, [stroke()]));
    for (const other of [
      { ...identity, ownerKey: "project|other" },
      { ...identity, namespace: "demo" as const },
      { ...identity, sessionId: "s2" },
      { ...identity, questionId: "q2" },
      { ...identity, contentVersion: "render-v2:revision2" },
    ]) {
      expect(inkIdentityKey(other)).not.toBe(inkIdentityKey(identity));
      expect(memory.read(other)).toEqual(emptyInkHistory());
    }
    expect(memory.read(identity).strokes).toEqual([stroke()]);
  });
  it("releases only a successfully completed session's question histories", () => {
    const memory = new InkSessionMemory();
    const sameSession = { ...identity, questionId: "q2" };
    const remaining = [
      { ...identity, sessionId: "s2" },
      { ...identity, ownerKey: "project|other" },
      { ...identity, namespace: "demo" as const },
    ];
    for (const key of [identity, sameSession, ...remaining])
      memory.update(key, (h) => editInk(h, [stroke()]));
    memory.discardSession(
      identity.ownerKey,
      identity.namespace,
      identity.sessionId,
    );
    expect(memory.read(identity)).toEqual(emptyInkHistory());
    expect(memory.read(sameSession)).toEqual(emptyInkHistory());
    for (const key of remaining)
      expect(memory.read(key).strokes).toEqual([stroke()]);
  });
  it("a page restart starts empty without importing a previous controller", () => {
    const first = new InkSessionMemory();
    first.update(identity, (h) => editInk(h, [stroke()]));
    expect(new InkSessionMemory().read(identity)).toEqual(emptyInkHistory());
    expect(first.read(identity).strokes).toEqual([stroke()]);
  });
  it("owner/area clearing drops strokes and undo/redo without depending on storage", () => {
    const memory = new InkSessionMemory();
    memory.update(identity, (h) => editInk(h, [stroke()]));
    memory.update(identity, undoInk);
    memory.clear();
    expect(memory.read(identity)).toEqual(emptyInkHistory());
    memory.update(identity, (h) => editInk(h, [stroke("fresh")]));
    expect(memory.read(identity).strokes.map((s) => s.id)).toEqual(["fresh"]);
  });
  it("does not silently evict current question ink after visiting many other questions", () => {
    const memory = new InkSessionMemory();
    memory.update(identity, (h) => editInk(h, [stroke()]));
    for (let n = 0; n < 1200; n++)
      memory.update({ ...identity, questionId: "visited-" + n }, (h) =>
        editInk(h, [stroke(String(n))]),
      );
    expect(memory.read(identity).strokes).toEqual([stroke()]);
    memory.update(identity, (h) => editInk(h, []));
    expect(memory.read(identity).strokes).toHaveLength(0);
    memory.update(identity, undoInk);
    expect(memory.read(identity).strokes).toEqual([stroke()]);
  });
});

describe("retired temporary ink callbacks", () => {
  it("late pending strokes cannot resurrect a successfully finished session", () => {
    const memory = new InkSessionMemory();
    const handle = memory.capture(identity);
    handle.update((h) => editInk(h, [stroke()]));
    memory.discardSession(
      identity.ownerKey,
      identity.namespace,
      identity.sessionId,
    );
    handle.update((h) => editInk(h, [stroke("late")]));
    expect(handle.history).toEqual(emptyInkHistory());
    expect(memory.read(identity)).toEqual(emptyInkHistory());
  });
  it("late callbacks from a cleared owner cannot modify its new entry", () => {
    const memory = new InkSessionMemory();
    const old = memory.capture(identity);
    old.update((h) => editInk(h, [stroke("old")]));
    memory.clear();
    memory.update(identity, (h) => editInk(h, [stroke("new")]));
    old.update((h) => editInk(h, [stroke("late")]));
    expect(old.history).toEqual(emptyInkHistory());
    expect(memory.read(identity).strokes.map((s) => s.id)).toEqual(["new"]);
  });
});
