import { test, expect, type Page, type Locator } from "@playwright/test";

// Every browser context is empty and uses only the app's synthetic demo data.
// Dispatching PointerEvents verifies the standard event contract, not physical S Pen latency or palm rejection.
test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const surface = (page: Page, id = "body") =>
  page.locator(`.ink-surface[data-ink-surface="${id}"]`);
const strokes = (page: Page, id?: string) =>
  (id ? surface(page, id) : page.locator(".original-question")).locator(
    "g[data-ink-stroke]",
  );
async function state(page: Page) {
  return page.evaluate(
    () =>
      new Promise<any>((resolve, reject) => {
        const req = indexedDB.open("police-ox-storage", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction("states", "readonly"),
            get = tx.objectStore("states").get("original:demo");
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            resolve(get.result.state);
            db.close();
          };
        };
      }),
  );
}
async function active(page: Page) {
  return (await state(page)).sessions.find((s: any) => s.status === "active");
}
async function inkDocuments(page: Page) {
  return page.evaluate(
    () =>
      new Promise<any[]>((resolve, reject) => {
        const req = indexedDB.open("police-original-ink", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction("documents", "readonly"),
            get = tx.objectStore("documents").getAll();
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
        };
      }),
  );
}
async function begin(page: Page, waitInk = true) {
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "모의고사", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "1번 선택", exact: true }),
  ).toBeVisible();
  if (waitInk)
    await expect(surface(page)).toHaveAttribute("data-ink-ready", "true");
}
async function tool(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
}
async function saved(page: Page) {
  await expect(
    page
      .locator(".ink-tools")
      .getByText("필기 이 기기에 저장됨", { exact: true }),
  ).toBeVisible();
}
async function penStroke(
  page: Page,
  options: {
    id?: string;
    type?: string;
    pointerId?: number;
    end?: string;
    y?: number;
  } = {},
) {
  const id = options.id ?? "body",
    layer = surface(page, id).locator(".ink-layer");
  await expect(surface(page, id)).toHaveAttribute("data-ink-ready", "true");
  await layer.scrollIntoViewIfNeeded();
  const box = (await layer.boundingBox())!;
  const y = Math.max(
    5,
    Math.min(box.height - 5, box.height * (options.y ?? 0.35)),
  );
  const from = { x: box.x + box.width * 0.25, y: box.y + y };
  const to = {
    x: box.x + box.width * 0.65,
    y: box.y + y + Math.min(8, box.height * 0.08),
  };
  const common = {
    pointerId: options.pointerId ?? 1,
    pointerType: options.type ?? "pen",
    isPrimary: true,
    buttons: 1,
    button: 0,
    bubbles: true,
  };
  await layer.dispatchEvent("pointerdown", {
    ...common,
    clientX: from.x,
    clientY: from.y,
    pressure: 0.4,
  });
  await layer.dispatchEvent("pointermove", {
    ...common,
    clientX: (from.x + to.x) / 2,
    clientY: (from.y + to.y) / 2,
    pressure: 0.7,
  });
  await layer.dispatchEvent("pointermove", {
    ...common,
    clientX: to.x,
    clientY: to.y,
    pressure: 0.5,
  });
  await layer.dispatchEvent(options.end ?? "pointerup", {
    ...common,
    clientX: to.x,
    clientY: to.y,
    pressure: 0,
    buttons: 0,
  });
  return { layer, from, to };
}
async function penNumber(button: Locator, moved = false) {
  const box = (await button.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const to = { x: from.x + (moved ? 22 : 0), y: from.y + (moved ? 18 : 0) };
  const common = {
    pointerId: 31,
    pointerType: "pen",
    isPrimary: true,
    button: 0,
    buttons: 1,
    bubbles: true,
  };
  await button.dispatchEvent("pointerdown", {
    ...common,
    clientX: from.x,
    clientY: from.y,
    pressure: 0.5,
  });
  if (moved)
    await button.dispatchEvent("pointermove", {
      ...common,
      clientX: to.x,
      clientY: to.y,
      pressure: 0.5,
    });
  await button.dispatchEvent("pointerup", {
    ...common,
    clientX: to.x,
    clientY: to.y,
    pressure: 0,
    buttons: 0,
  });
  await button.evaluate(
    (element, p) =>
      element.dispatchEvent(
        new PointerEvent("click", {
          pointerId: 31,
          pointerType: "pen",
          clientX: p.x,
          clientY: p.y,
          detail: 1,
          bubbles: true,
          cancelable: true,
        }),
      ),
    to,
  );
}

test("연필·획 지우기·실행 취소·다시 실행과 번호의 touch/pen/mouse/keyboard 입력 경계를 유지한다", async ({
  page,
}) => {
  await begin(page);
  await expect(
    page.getByRole("button", { name: "이동·읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await surface(page)
      .locator(".ink-layer")
      .evaluate((el) => getComputedStyle(el).pointerEvents),
  ).toBe("none");
  await penStroke(page);
  await expect(strokes(page)).toHaveCount(0);
  await tool(page, "연필");
  expect(
    await surface(page)
      .locator(".ink-layer")
      .evaluate((el) => getComputedStyle(el).touchAction),
  ).toBe("none");
  await penStroke(page);
  await expect(strokes(page, "body")).toHaveCount(1);
  await penStroke(page, { id: "choice-1", pointerId: 2 });
  await expect(strokes(page, "choice-1")).toHaveCount(1);
  await saved(page);
  expect(
    Object.values((await active(page)).responses).filter((x) => x != null),
  ).toHaveLength(0);
  const one = page.getByRole("button", { name: "1번 선택", exact: true });
  const two = page.getByRole("button", { name: "2번 선택", exact: true });
  await two.tap();
  await expect(two).toHaveAttribute("aria-pressed", "false");
  await penNumber(one);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await penNumber(two, true);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await expect(two).toHaveAttribute("aria-pressed", "false");
  await two.click();
  await expect(two).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("3");
  await expect(
    page.getByRole("button", { name: "3번 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await tool(page, "지우개");
  const layer = surface(page).locator(".ink-layer");
  // Erase through the middle of the known body stroke, without touching the choice's surface.
  // Scrolling to the number controls may have moved the page: convert the original local stroke back to the current surface.
  const box = (await layer.boundingBox())!;
  const common = {
    pointerId: 5,
    pointerType: "pen",
    isPrimary: true,
    buttons: 1,
    button: 0,
    bubbles: true,
    pressure: 0.5,
  };
  await layer.dispatchEvent("pointerdown", {
    ...common,
    clientX: box.x + box.width * 0.45,
    clientY: box.y + box.height * 0.35 + Math.min(4, box.height * 0.04),
  });
  await layer.dispatchEvent("pointerup", {
    ...common,
    clientX: box.x + box.width * 0.45,
    clientY: box.y + box.height * 0.35 + Math.min(4, box.height * 0.04),
    buttons: 0,
    pressure: 0,
  });
  await expect(strokes(page, "body")).toHaveCount(0);
  await expect(strokes(page, "choice-1")).toHaveCount(1);
  await tool(page, "필기 실행 취소");
  await expect(strokes(page, "body")).toHaveCount(1);
  await tool(page, "필기 다시 실행");
  await expect(strokes(page, "body")).toHaveCount(0);
  await tool(page, "현재 문항 필기 지우기");
  await expect(strokes(page)).toHaveCount(0);
  await tool(page, "필기 실행 취소");
  await expect(strokes(page, "choice-1")).toHaveCount(1);
  await tool(page, "이동·읽기");
  expect(
    await surface(page)
      .locator(".ink-layer")
      .evaluate((el) => getComputedStyle(el).pointerEvents),
  ).toBe("none");
  expect(
    await page.evaluate(() => [
      getComputedStyle(document.documentElement).touchAction,
      getComputedStyle(document.body).touchAction,
    ]),
  ).not.toContain("none");
  await page.getByRole("button", { name: "4번 선택", exact: true }).tap();
  await expect(
    page.getByRole("button", { name: "4번 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await state(page)).attempts).toHaveLength(0);
});

test("coalesced events 미지원·pressure0 fallback과 pointercancel/lostcapture 뒤 붙은 펜 없이 저장한다", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(PointerEvent.prototype, "getCoalescedEvents", {
      configurable: true,
      value: undefined,
    });
  });
  await begin(page);
  await tool(page, "연필");
  const first = await penStroke(page, { end: "pointercancel" });
  await expect(strokes(page, "body")).toHaveCount(1);
  await saved(page);
  const originalPath = await strokes(page, "body")
    .first()
    .locator("path")
    .getAttribute("d");
  await first.layer.dispatchEvent("pointermove", {
    pointerId: 1,
    pointerType: "pen",
    buttons: 1,
    pressure: 0.8,
    clientX: first.to.x + 100,
    clientY: first.to.y + 100,
  });
  await first.layer.dispatchEvent("pointerup", {
    pointerId: 1,
    pointerType: "pen",
    buttons: 0,
    pressure: 0,
    clientX: first.to.x + 100,
    clientY: first.to.y + 100,
  });
  expect(
    await strokes(page, "body").first().locator("path").getAttribute("d"),
  ).toBe(originalPath);
  await penStroke(page, { pointerId: 3, end: "lostpointercapture", y: 0.6 });
  await expect(strokes(page, "body")).toHaveCount(2);
  await saved(page);
  const documents = await inkDocuments(page);
  const current = (Object.values(documents[0].layouts) as any[]).find(
    (h) => h.strokes.length === 2,
  )!;
  expect(current.strokes).toHaveLength(2);
  for (const stroke of current.strokes) {
    expect(stroke.points.length).toBeGreaterThanOrEqual(3);
    expect(
      stroke.points.every(
        (p: any) =>
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.pressure > 0 &&
          p.pressure <= 1,
      ),
    ).toBe(true);
  }
  // A fresh gesture is accepted after both capture termination paths.
  await penStroke(page, { pointerId: 4, id: "choice-2" });
  await expect(strokes(page, "choice-2")).toHaveCount(1);
});

test("문항 왕복·새로고침·스크롤은 획을 복원하고 재배치별 필기·실행 취소를 섞지 않는다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await begin(page);
  await tool(page, "연필");
  await penStroke(page);
  await saved(page);
  const original = await strokes(page, "body")
    .first()
    .locator("path")
    .getAttribute("d");
  const before = await surface(page).evaluate((el) => ({
    surface: el.getBoundingClientRect().top,
    layer: el.querySelector("svg")!.getBoundingClientRect().top,
    scroll: scrollY,
  }));
  await page.evaluate(() => scrollBy(0, 150));
  const after = await surface(page).evaluate((el) => ({
    surface: el.getBoundingClientRect().top,
    layer: el.querySelector("svg")!.getBoundingClientRect().top,
    scroll: scrollY,
  }));
  expect(after.scroll).toBeGreaterThan(before.scroll);
  expect(after.layer - before.layer).toBeCloseTo(
    after.surface - before.surface,
    1,
  );
  await expect(strokes(page, "body").first().locator("path")).toHaveAttribute(
    "d",
    original!,
  );
  await tool(page, "다음 문항");
  await expect(surface(page)).toHaveAttribute("data-ink-ready", "true");
  await expect(strokes(page)).toHaveCount(0);
  await tool(page, "이전 문항");
  await expect(strokes(page, "body")).toHaveCount(1);
  await page.reload();
  await expect(surface(page)).toHaveAttribute("data-ink-ready", "true");
  await expect(strokes(page, "body")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "이동·읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(strokes(page, "body").first().locator("path")).toHaveAttribute(
    "d",
    original!,
  );
  await tool(page, "글씨 키우기");
  await expect(strokes(page)).toHaveCount(0);
  await expect(
    page.getByText("다른 글씨 크기·화면 배치의 필기가 보관되어 있습니다.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "필기 실행 취소", exact: true }),
  ).toBeDisabled();
  await tool(page, "연필");
  await penStroke(page, { pointerId: 5, y: 0.7 });
  await saved(page);
  const enlarged = await strokes(page, "body")
    .first()
    .locator("path")
    .getAttribute("d");
  await tool(page, "글씨 줄이기");
  await expect(strokes(page, "body")).toHaveCount(1);
  await expect(strokes(page, "body").first().locator("path")).toHaveAttribute(
    "d",
    original!,
  );
  await tool(page, "글씨 키우기");
  await expect(strokes(page, "body")).toHaveCount(1);
  await expect(strokes(page, "body").first().locator("path")).toHaveAttribute(
    "d",
    enlarged!,
  );
  await page.setViewportSize({ width: 960, height: 500 });
  await expect(strokes(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "필기 실행 취소", exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 500 });
  await expect(strokes(page, "body")).toHaveCount(1);
  await expect(strokes(page, "body").first().locator("path")).toHaveAttribute(
    "d",
    enlarged!,
  );
  expect(
    Object.values((await inkDocuments(page))[0].layouts).filter(
      (h: any) => h.strokes.length > 0,
    ),
  ).toHaveLength(2);
});

test("새 세션에는 이전 필기가 보이지 않고 필기 중 타이머·답안 내구 저장과 namespace 경계를 유지한다", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
  await begin(page);
  const first = await active(page);
  await tool(page, "연필");
  await penStroke(page);
  await saved(page);
  await page.getByRole("button", { name: "2번 선택", exact: true }).click();
  await expect
    .poll(async () => (await active(page)).responses[first.questions[0].id])
    .toBe(2);
  await page.clock.runFor(3000);
  expect((await active(page)).deadlineAt).toBe(first.deadlineAt);
  await page.reload();
  await expect(strokes(page, "body")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "2번 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  page.once("dialog", (dialog) => dialog.accept());
  await tool(page, "시험 제출");
  await page.getByRole("button", { name: "모의고사", exact: true }).click();
  await tool(page, "시작하기");
  await expect(surface(page)).toHaveAttribute("data-ink-ready", "true");
  expect((await active(page)).id).not.toBe(first.id);
  await expect(strokes(page)).toHaveCount(0);
  await tool(page, "연필");
  await penStroke(page);
  await saved(page);
  const documents = await inkDocuments(page);
  expect(new Set(documents.map((d) => d.identity.sessionId)).size).toBe(2);
  expect(documents.every((d) => d.identity.namespace === "demo")).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await tool(page, "시험 제출");
  await page.getByLabel("저장 영역", { exact: true }).selectOption("real");
  await expect(page.locator(".ink-layer")).toHaveCount(0);
  expect(
    (await inkDocuments(page)).filter((d) => d.identity.sessionId === first.id),
  ).toHaveLength(1);
});

test("필기 저장 실패를 별도 표시하고 답안·타이머·기존 기록은 저장하며 거짓 저장 완료를 표시하지 않는다", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      if (this.transaction.db.name === "police-original-ink")
        throw new DOMException("TEST ONLY: ink quota", "QuotaExceededError");
      return key === undefined
        ? put.call(this, value)
        : put.call(this, value, key);
    };
  });
  await begin(page);
  const first = await active(page);
  await tool(page, "연필");
  await penStroke(page);
  await expect(strokes(page, "body")).toHaveCount(1);
  await expect(page.locator(".ink-tools").getByRole("alert")).toContainText(
    "필기를 저장하지 못했습니다",
  );
  await expect(
    page.getByText("필기 이 기기에 저장됨", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "1번 선택", exact: true }).click();
  await expect
    .poll(async () => (await active(page)).responses[first.questions[0].id])
    .toBe(1);
  expect((await active(page)).deadlineAt).toBe(first.deadlineAt);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "1번 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(strokes(page)).toHaveCount(0);
  expect((await active(page)).deadlineAt).toBe(first.deadlineAt);
});
