import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  choicePointerAllowed,
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
    expect(choicePointerAllowed("pen", "touch", false)).toBe(false);
    expect(choicePointerAllowed("eraser", "touch", false)).toBe(false);
    expect(choicePointerAllowed("read", "touch", false)).toBe(true);
    for (const type of ["pen", "mouse", "keyboard"])
      expect(choicePointerAllowed("pen", type, false)).toBe(true);
    expect(choicePointerAllowed("pen", "pen", true)).toBe(false);
    expect(choicePointerAllowed("pen", "pen", false, true)).toBe(false);
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
