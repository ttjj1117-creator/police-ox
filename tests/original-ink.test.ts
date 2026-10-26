import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  choicePointerAllowed,
  InkInputCoordinator,
  InkFingerPan,
  editInk,
  emptyInkDocument,
  emptyInkHistory,
  eraseInk,
  inkIdentityKey,
  inkPressure,
  inkWidth,
  isDrawingPointer,
  localInkPoint,
  redoInk,
  undoInk,
  validInkDocument,
  type InkIdentity,
  type InkStroke,
} from "../src/original/ink/model";
import { InkRecoveryError, InkStore } from "../src/original/ink/store";

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

describe("separate durable local pencil store", () => {
  it("keeps a failed old-question draft for the same identity to retry after remount", async () => {
    const factory = new IDBFactory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class FailingStore extends InkStore {
      protected override async writeNow() {
        await gate;
        throw new DOMException("Quota", "QuotaExceededError");
      }
    }
    const oldProvider = new FailingStore(factory),
      newProvider = new InkStore(factory);
    const document = emptyInkDocument(identity);
    document.layouts.current = editInk(emptyInkHistory(), [stroke("unsaved")]);
    const saving = oldProvider.write(document).catch((error: unknown) => error);
    const reading = newProvider.read(identity).catch((error: unknown) => error);
    release();
    expect(await saving).toBeInstanceOf(InkRecoveryError);
    const recovery = await reading;
    expect(recovery).toBeInstanceOf(InkRecoveryError);
    expect((recovery as InkRecoveryError).document).toEqual(document);
    expect(
      await newProvider.read({ ...identity, ownerKey: "project|other" }),
    ).toBeUndefined();
    expect(
      await newProvider.read({ ...identity, sessionId: "other-session" }),
    ).toBeUndefined();
    await newProvider.write((recovery as InkRecoveryError).document);
    expect(await newProvider.read(identity)).toEqual(document);
    await newProvider.close();
  });
  it("a new question provider waits for all old-provider strokes before reading", async () => {
    const factory = new IDBFactory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowStore extends InkStore {
      protected override async writeNow(
        document: ReturnType<typeof emptyInkDocument>,
      ) {
        await gate;
        await super.writeNow(document);
      }
    }
    const oldProvider = new SlowStore(factory),
      newProvider = new InkStore(factory);
    const first = emptyInkDocument(identity);
    first.layouts.current = editInk(emptyInkHistory(), [stroke()]);
    const second = {
      ...first,
      layouts: {
        current: editInk(first.layouts.current, [
          ...first.layouts.current.strokes,
          stroke("b"),
        ]),
      },
    };
    const writes = [oldProvider.write(first), oldProvider.write(second)];
    let readFinished = false;
    const reading = newProvider.read(identity).then((value) => {
      readFinished = true;
      return value;
    });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release();
    await Promise.all(writes);
    expect((await reading)?.layouts.current.strokes.map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
    await oldProvider.close();
    await newProvider.close();
  });
  it("restores strokes and undo/redo per exact layout without changing another layout", async () => {
    const factory = new IDBFactory(),
      store = new InkStore(factory);
    const document = emptyInkDocument(identity);
    document.layouts["22px;1280;content-a"] = editInk(emptyInkHistory(), [
      stroke(),
    ]);
    document.layouts["33px;1280;content-a"] = editInk(emptyInkHistory(), [
      stroke("large"),
    ]);
    await store.write(document);
    await store.close();
    const reopened = new InkStore(factory);
    expect(await reopened.read(identity)).toEqual(document);
    const changed = {
      ...document,
      layouts: {
        ...document.layouts,
        "33px;1280;content-a": undoInk(document.layouts["33px;1280;content-a"]),
      },
    };
    await reopened.write(changed);
    expect(
      (await reopened.read(identity))?.layouts["22px;1280;content-a"].strokes,
    ).toEqual([stroke()]);
    expect(
      (await reopened.read(identity))?.layouts["33px;1280;content-a"].redo,
    ).toHaveLength(1);
    await reopened.close();
  });
  it("isolates owner, namespace, session, question and content versions", async () => {
    const store = new InkStore(new IDBFactory());
    const document = emptyInkDocument(identity);
    document.layouts.original = editInk(emptyInkHistory(), [stroke()]);
    await store.write(document);
    for (const alternate of [
      { ...identity, ownerKey: "project|user-b" },
      { ...identity, namespace: "demo" as const },
      { ...identity, sessionId: "s2" },
      { ...identity, questionId: "q2" },
      { ...identity, contentVersion: "render-v2:revision1" },
    ]) {
      expect(inkIdentityKey(alternate)).not.toBe(inkIdentityKey(identity));
      expect(await store.read(alternate)).toBeUndefined();
    }
    expect(await store.read(identity)).toEqual(document);
    await store.close();
  });
  it("rejects malformed drawing data while preserving the last durable document", async () => {
    const store = new InkStore(new IDBFactory());
    const document = emptyInkDocument(identity);
    document.layouts.current = editInk(emptyInkHistory(), [stroke()]);
    await store.write(document);
    const invalid = structuredClone(document);
    invalid.layouts.current.strokes[0].points[0].x = NaN;
    expect(validInkDocument(invalid, identity)).toBe(false);
    await expect(store.write(invalid)).rejects.toThrow("필기 형식");
    expect(await store.read(identity)).toEqual(document);
    expect(validInkDocument(document, { ...identity, ownerKey: "other" })).toBe(
      false,
    );
    await store.close();
  });
  it("reports unavailable storage as failure rather than acknowledging a save", async () => {
    const failed = new InkStore({
      open: () => {
        throw new DOMException("Denied", "SecurityError");
      },
    } as unknown as IDBFactory);
    await expect(failed.write(emptyInkDocument(identity))).rejects.toThrow(
      "필기를 저장하지 못했습니다",
    );
    await expect(failed.read(identity)).rejects.toThrow(
      "필기를 저장하지 못했습니다",
    );
  });
});
