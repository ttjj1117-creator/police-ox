import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
test("기존 필기 DB는 읽거나 삭제하지 않고 이전 문제·답안을 보존한 채 새 임시 필기를 사용한다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?view=original&mode=demo");
  const fixture = JSON.parse(
    readFileSync(
      resolve("tests/fixtures/explanations/legacy-ink.demo.json"),
      "utf8",
    ),
  );
  await page.evaluate(async (fixture) => {
    const put = (name: string, store: string, values: any[]) =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains(store))
            r.result.createObjectStore(store);
        };
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            t = db.transaction(store, "readwrite"),
            s = t.objectStore(store);
          for (const [key, value] of values) s.put(value, key);
          t.oncomplete = () => {
            db.close();
            resolve();
          };
          t.onabort = () => reject(t.error);
        };
      });
    await put("police-ox-storage", "states", [
      ["original:demo", fixture.envelope],
    ]);
    await put(
      "police-original-ink",
      "documents",
      fixture.documents.map((d: any) => [
        JSON.stringify([
          d.identity.ownerKey,
          d.identity.namespace,
          d.identity.sessionId,
          d.identity.questionId,
          d.identity.contentVersion,
        ]),
        d,
      ]),
    );
  }, fixture);
  await page.addInitScript(() => {
    (window as any).__inkOperations = [];
    (window as any).__allowInkInspection = false;
    const open = IDBFactory.prototype.open,
      remove = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.open = function (name, version) {
      if (
        name === "police-original-ink" &&
        !(window as any).__allowInkInspection
      ) {
        (window as any).__inkOperations.push("open");
        throw new DOMException("test ink read denied", "SecurityError");
      }
      return version === undefined
        ? open.call(this, name)
        : open.call(this, name, version);
    };
    IDBFactory.prototype.deleteDatabase = function (name) {
      if (name === "police-original-ink") {
        (window as any).__inkOperations.push("delete");
        throw Error("old ink must remain");
      }
      return remove.call(this, name);
    };
  });
  await page.reload();
  const paper = page.locator('.ink-surface[data-ink-surface="paper"]');
  await expect(paper).toHaveAttribute("data-ink-ready", "true");
  await expect(paper.locator("g[data-ink-stroke]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "이전 필기 배치 보기", exact: true }),
  ).toHaveCount(0);
  const box = (await paper.boundingBox())!;
  const e = {
    pointerId: 71,
    pointerType: "pen",
    clientX: box.x + 110,
    clientY: box.y + 25,
    buttons: 1,
    button: 0,
    pressure: 0.5,
    bubbles: true,
  };
  await paper.dispatchEvent("pointerdown", e);
  await paper.dispatchEvent("pointerup", {
    ...e,
    clientX: e.clientX + 100,
    buttons: 0,
    pressure: 0,
  });
  await expect(paper.locator("g[data-ink-stroke]")).toHaveCount(1);
  const inspect = () =>
    page.evaluate(async () => {
      (window as any).__allowInkInspection = true;
      const get = (name: string, store: string, key?: string) =>
        new Promise<any>((resolve, reject) => {
          const r = indexedDB.open(name);
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result,
              t = db.transaction(store),
              s = t.objectStore(store),
              q = key ? s.get(key) : s.getAll();
            t.oncomplete = () => {
              db.close();
              resolve(q.result);
            };
            t.onerror = () => reject(t.error);
          };
        });
      const ink = await get("police-original-ink", "documents");
      const envelope = await get(
        "police-ox-storage",
        "states",
        "original:demo",
      );
      (window as any).__allowInkInspection = false;
      return {
        ink,
        state: envelope.state,
        operations: (window as any).__inkOperations,
      };
    });
  const after = await inspect();
  expect(after.ink).toEqual(fixture.documents);
  expect(after.state.data).toEqual(fixture.envelope.state.data);
  expect(after.state.attempts).toEqual(fixture.envelope.state.attempts);
  expect(after.state.sessions[0].responses).toEqual(
    fixture.envelope.state.sessions[0].responses,
  );
  expect(after.operations).toEqual([]);
  await page.reload();
  await expect(paper).toHaveAttribute("data-ink-ready", "true");
  await expect(paper.locator("g[data-ink-stroke]")).toHaveCount(0);
  expect((await inspect()).ink).toEqual(fixture.documents);
  expect((await inspect()).operations).toEqual([]);
});
