import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const paper = (page: Page) =>
  page.locator('.ink-surface[data-ink-surface="paper"]');
const strokes = (page: Page) => paper(page).locator("g[data-ink-stroke]");
async function begin(page: Page) {
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
}
async function documents(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open("police-original-ink");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("documents", "readonly");
          const read = tx.objectStore("documents").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(read.result);
          };
          tx.onabort = tx.onerror = () => reject(tx.error);
        };
      }),
  );
}
async function draw(page: Page, id: number, yOffset = 0) {
  const area = paper(page);
  await expect(area).toHaveAttribute("data-ink-ready", "true");
  await page.evaluate(() => scrollTo(0, 0));
  const box = (await area.boundingBox())!;
  const contact = {
    pointerId: id,
    pointerType: "pen",
    clientX: box.x + 100,
    clientY: box.y + 20 + yOffset,
    button: 0,
    buttons: 1,
    pressure: 0.5,
    bubbles: true,
    cancelable: true,
  };
  await area.dispatchEvent("pointerdown", contact);
  await area.dispatchEvent("pointermove", {
    ...contact,
    clientX: contact.clientX + 60,
  });
  await area.dispatchEvent("pointerup", {
    ...contact,
    clientX: contact.clientX + 100,
    buttons: 0,
    pressure: 0,
  });
  await expect(
    page
      .locator(".ink-tools")
      .getByText("필기 이 기기에 저장됨", { exact: true }),
  ).toBeVisible();
}
const paths = (page: Page) =>
  strokes(page)
    .locator("path")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));

test("일시적으로 측정할 수 없는 종이는 기존 획을 빈 문서로 저장하지 않고 같은 배치를 복원한다", async ({
  page,
}) => {
  await begin(page);
  await draw(page, 801);
  await expect(strokes(page)).toHaveCount(1);
  const before = JSON.stringify(await documents(page));
  const originalPaths = await paths(page);
  const content = paper(page).locator(":scope > .ink-content");
  await content.evaluate((element) => (element.style.display = "none"));
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "false");
  await expect(paper(page).locator(".ink-layer")).toHaveAttribute(
    "data-layout-pending",
    "true",
  );
  // Input arriving while the box is unavailable must not create an empty layout.
  await paper(page).dispatchEvent("pointerdown", {
    pointerId: 802,
    pointerType: "pen",
    clientX: 200,
    clientY: 300,
    buttons: 1,
    button: 0,
    pressure: 0.5,
    bubbles: true,
  });
  await paper(page).dispatchEvent("pointerup", {
    pointerId: 802,
    pointerType: "pen",
    clientX: 240,
    clientY: 300,
    buttons: 0,
    button: 0,
    pressure: 0,
    bubbles: true,
  });
  expect(JSON.stringify(await documents(page))).toBe(before);
  await content.evaluate((element) => element.style.removeProperty("display"));
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
  await expect(paper(page).locator(".ink-layer")).not.toHaveAttribute(
    "data-layout-pending",
    "true",
  );
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(originalPaths);
  expect(JSON.stringify(await documents(page))).toBe(before);
});

test("폭·높이가 같은 글자 배치 변경도 별도로 보관하고 원래 스타일의 획·실행 취소를 복원한다", async ({
  page,
}) => {
  await begin(page);
  await draw(page, 811);
  const originalPaths = await paths(page);
  const before = JSON.stringify(await documents(page));
  const content = paper(page).locator(":scope > .ink-content");
  const sizeBefore = await content.evaluate((element) => [
    element.clientWidth,
    element.clientHeight,
  ]);
  // This first-node style is part of the existing exact signature. Even if the
  // outer box is unchanged, a content/style invalidation must re-read it.
  await content.evaluate(
    (element) => (element.style.letterSpacing = "0.001px"),
  );
  await expect(strokes(page)).toHaveCount(0);
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
  expect(
    await content.evaluate((element) => [
      element.clientWidth,
      element.clientHeight,
    ]),
  ).toEqual(sizeBefore);
  expect(JSON.stringify(await documents(page))).toBe(before);
  await draw(page, 812, 20);
  await expect(strokes(page)).toHaveCount(1);
  const differentPaths = await paths(page);
  expect(differentPaths).not.toEqual(originalPaths);
  await content.evaluate((element) =>
    element.style.removeProperty("letter-spacing"),
  );
  await expect(strokes(page)).toHaveCount(1);
  await expect.poll(() => paths(page)).toEqual(originalPaths);
  await page
    .getByRole("button", { name: "필기 실행 취소", exact: true })
    .click();
  await expect(strokes(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "필기 다시 실행", exact: true })
    .click();
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(originalPaths);
  await content.evaluate(
    (element) => (element.style.letterSpacing = "0.001px"),
  );
  await expect.poll(() => paths(page)).toEqual(differentPaths);
});

test("외부 스타일로 종이 폭이 바뀌면 같은 ResizeObserver 처리 안에서 이전 획을 숨긴다", async ({
  page,
}) => {
  await begin(page);
  await draw(page, 821);
  const before = JSON.stringify(await documents(page));
  const originalPaths = await paths(page);
  // A head stylesheet changes the box without mutating any observed paper or
  // ancestor attribute. The second observer sees the application's prepaint
  // decision in the same delivery, before another animation frame can run.
  const hiddenBeforePaint = await page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const content = document.querySelector<HTMLElement>(
          '.ink-surface[data-ink-surface="paper"] > .ink-content',
        )!;
        const width = content.getBoundingClientRect().width;
        const layer = content.parentElement!.querySelector(".ink-layer")!;
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(Error("외부 스타일의 종이 크기 변경을 받지 못했습니다."));
        }, 3000);
        const observer = new ResizeObserver((entries) => {
          if (entries[0].contentRect.width >= width - 10) return;
          clearTimeout(timeout);
          observer.disconnect();
          resolve(layer.getAttribute("data-layout-pending") === "true");
        });
        observer.observe(content);
        const style = document.createElement("style");
        style.id = "v13-external-paper-width";
        style.textContent =
          '.ink-surface[data-ink-surface="paper"] > .ink-content { width: calc(100% - 32px) !important; }';
        document.head.append(style);
      }),
  );
  expect(hiddenBeforePaint).toBe(true);
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
  await expect(strokes(page)).toHaveCount(0);
  expect(JSON.stringify(await documents(page))).toBe(before);
  await page.evaluate(() =>
    document.getElementById("v13-external-paper-width")!.remove(),
  );
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(originalPaths);
  expect(JSON.stringify(await documents(page))).toBe(before);
});
