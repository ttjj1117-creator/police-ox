import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
test("이전 배포 버전에서 저장한 body/choice 획을 같은 배치에서 읽기 전용 복원하고 새 연속 좌표와 섞지 않는다", async ({
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
  await page.reload();
  await expect(
    page.locator('.ink-surface[data-ink-surface="paper"]'),
  ).toHaveAttribute("data-ink-ready", "true");
  await expect(page.locator("g[data-ink-stroke]")).toHaveCount(0);
  await page
    .getByRole("button", { name: "이전 필기 배치 보기", exact: true })
    .click();
  const old = Object.values<any>(fixture.documents[0].layouts).flatMap(
    (h) => h.strokes,
  );
  await expect(page.locator("g[data-ink-stroke]")).toHaveCount(2);
  for (const stroke of old) {
    const actual = page.locator(`[data-ink-stroke="${stroke.id}"] path`);
    await expect(actual).toHaveAttribute(
      "d",
      `M${stroke.points.map((p: any) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L")}`,
    );
  }
  await expect(page.getByText(/이전 필기 보관 보기 · 읽기 전용/)).toBeVisible();
  await page
    .getByRole("button", { name: "연속 필기로 돌아가기", exact: true })
    .click();
  await expect(page.locator("g[data-ink-stroke]")).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("button", { name: "이전 필기 배치 보기", exact: true })
    .click();
  await expect(page.locator("g[data-ink-stroke]")).toHaveCount(2);
});
