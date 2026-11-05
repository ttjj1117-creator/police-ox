import {
  test,
  expect,
  type Page,
  type Locator,
  type CDPSession,
} from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const paper = (page: Page) =>
  page.locator('.ink-surface[data-ink-surface="paper"]');
const choice = (page: Page, n: number) =>
  page.getByRole("button", { name: `${n}번 선택`, exact: true });
async function begin(page: Page) {
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
  return page.context().newCDPSession(page);
}
async function pen(
  cdp: CDPSession,
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  x: number,
  y: number,
) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
    pointerType: "pen",
    force: type === "mouseReleased" ? 0 : 0.5,
  });
}
async function tipTap(cdp: CDPSession, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = (await control.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await pen(cdp, "mousePressed", x, y);
  await pen(cdp, "mouseReleased", x, y);
}
async function ink(page: Page, cdp: CDPSession, end = true) {
  await page.evaluate(() => scrollTo(0, 0));
  const box = (await paper(page).boundingBox())!;
  const x = box.x + 200,
    y = Math.min(500, Math.max(100, box.y + 35));
  await pen(cdp, "mousePressed", x, y);
  await pen(cdp, "mouseMoved", x + 70, y + 8);
  if (end) await pen(cdp, "mouseReleased", x + 100, y + 10);
  return { x, y };
}
async function attempts(page: Page) {
  return page.evaluate(
    () =>
      new Promise<any[]>((resolve, reject) => {
        const request = indexedDB.open("police-ox-storage");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            transaction = db.transaction("states", "readonly"),
            value = transaction.objectStore("states").get("original:demo");
          transaction.oncomplete = () => {
            db.close();
            resolve(value.result.state.attempts);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
}

test("브라우저가 생성한 펜 탭은 필기 직후 번호·제출·이동을 한 번 실행한다", async ({
  page,
}) => {
  const cdp = await begin(page);
  await page.evaluate(() => {
    (window as any).__penClicks = [];
    document.addEventListener(
      "click",
      (event) => {
        const e = event as PointerEvent;
        if (e.pointerType === "pen")
          (window as any).__penClicks.push({
            trusted: e.isTrusted,
            name: (e.target as Element)
              .closest("button")
              ?.getAttribute("aria-label"),
          });
      },
      true,
    );
  });
  for (let n = 1; n <= 4; n++) {
    await tipTap(cdp, choice(page, n));
    await expect(choice(page, n)).toHaveAttribute("aria-pressed", "true");
  }
  await ink(page, cdp);
  await expect(paper(page).locator("g[data-ink-stroke]")).toHaveCount(1);
  await tipTap(cdp, choice(page, 1));
  await expect(choice(page, 1)).toHaveAttribute("aria-pressed", "true");
  await tipTap(cdp, page.getByRole("button", { name: "답 제출", exact: true }));
  await expect(page.locator(".original-feedback")).toBeVisible();
  await expect.poll(async () => (await attempts(page)).length).toBe(1);
  const saved = await attempts(page);
  await tipTap(
    cdp,
    page.getByRole("button", { name: "다음 문항", exact: true }),
  );
  await expect(page.locator(".original-movement")).toContainText("2 /");
  await tipTap(
    cdp,
    page.getByRole("button", { name: "이전 문항", exact: true }),
  );
  await expect(page.locator(".original-feedback")).toBeVisible();
  await expect(paper(page).locator("g[data-ink-stroke]")).toHaveCount(1);
  expect(await attempts(page)).toEqual(saved);
  const clicks = await page.evaluate(() => (window as any).__penClicks);
  expect(clicks.filter((e: any) => e.trusted).length).toBeGreaterThanOrEqual(8);
  await cdp.detach();
});

test("펜 캡처의 작은 경계 이탈·큰 이동·취소·지문에서 버튼을 지난 획은 조작하지 않는다", async ({
  page,
}) => {
  const cdp = await begin(page),
    one = choice(page, 1);
  await one.scrollIntoViewIfNeeded();
  let box = (await one.boundingBox())!,
    x = box.x + 2,
    y = box.y + box.height / 2;
  await pen(cdp, "mousePressed", x, y);
  await pen(cdp, "mouseReleased", box.x - 2, y);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  box = (await one.boundingBox())!;
  x = box.x + box.width / 2;
  await pen(cdp, "mousePressed", x, y);
  await pen(cdp, "mouseMoved", x + 15, y);
  await pen(cdp, "mouseReleased", x, y);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await pen(cdp, "mousePressed", x, y);
  await one.dispatchEvent("pointercancel", {
    pointerId: 2,
    pointerType: "pen",
    clientX: x,
    clientY: y,
    bubbles: true,
  });
  await pen(cdp, "mouseReleased", x, y);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => scrollTo(0, 0));
  const p = (await paper(page).boundingBox())!;
  const q = (await one.boundingBox())!;
  await pen(cdp, "mousePressed", p.x + 230, p.y + 30);
  await pen(cdp, "mouseMoved", q.x + q.width / 2, q.y + q.height / 2);
  await pen(cdp, "mouseReleased", q.x + q.width / 2, q.y + q.height / 2);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await tipTap(cdp, one);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await cdp.detach();
});

test("UA click이 누락된 유효한 펜 탭만 보완하고 후속 click과 손바닥을 중복 실행하지 않는다", async ({
  page,
}) => {
  const cdp = await begin(page);
  await page.evaluate(() => {
    (window as any).__buttonActions = 0;
    // Deliberately suppress the UA click once at the window boundary. The pen
    // down/up remains genuine browser input; the application must fill the gap.
    const suppress = (event: MouseEvent) => {
      if (event.isTrusted && (event as PointerEvent).pointerType === "pen") {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.removeEventListener("click", suppress, true);
      }
    };
    window.addEventListener("click", suppress, true);
    document.addEventListener("click", (event) => {
      if ((event.target as Element).closest('button[aria-label="다시 보기"]'))
        (window as any).__buttonActions++;
    });
  });
  const mark = page.getByRole("button", { name: "다시 보기", exact: true });
  await tipTap(cdp, mark);
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  await mark.dispatchEvent("click", {
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).__buttonActions)).toBe(1);
  await tipTap(cdp, mark);
  await expect(mark).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => (window as any).__buttonActions)).toBe(2);

  const one = choice(page, 1);
  await one.scrollIntoViewIfNeeded();
  const box = (await one.boundingBox())!,
    surface = (await paper(page).boundingBox())!;
  const held = { x: surface.x + 230, y: box.y - 25 };
  await pen(cdp, "mousePressed", held.x, held.y);
  await pen(cdp, "mouseMoved", held.x + 60, held.y + 4);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 91, x: box.x + 20, y: box.y + 20 }],
  });
  await pen(cdp, "mouseReleased", held.x + 100, held.y + 10);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await tipTap(cdp, one);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await one.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "2번 선택", exact: true }).click();
  await expect(choice(page, 2)).toHaveAttribute("aria-pressed", "true");
  await cdp.detach();
});

test("비활성 상태에서 시작하거나 끝난 펜 탭은 보완 대기 중 활성화돼도 실행하지 않는다", async ({ page }) => {
  const cdp = await begin(page);
  const mark = page.getByRole("button", { name: "다시 보기", exact: true });
  await mark.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    (window as any).__disabledTapActions = 0;
    document.addEventListener("click", (event) => {
      if ((event.target as Element).closest('button[aria-label="다시 보기"]'))
        (window as any).__disabledTapActions++;
    });
  });
  const box = (await mark.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  await mark.evaluate((element: HTMLButtonElement) => { element.disabled = true; });
  await pen(cdp, "mousePressed", x, y);
  await pen(cdp, "mouseReleased", x, y);
  await mark.evaluate((element: HTMLButtonElement) => { element.disabled = false; });
  // Let the40ms missing-click grace elapse; this must remain a rejected contact.
  await page.waitForTimeout(80);
  await expect(mark).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => (window as any).__disabledTapActions)).toBe(0);

  await pen(cdp, "mousePressed", x, y);
  await mark.evaluate((element: HTMLButtonElement) => { element.disabled = true; });
  await pen(cdp, "mouseReleased", x, y);
  await mark.evaluate((element: HTMLButtonElement) => { element.disabled = false; });
  await page.waitForTimeout(80);
  await expect(mark).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => (window as any).__disabledTapActions)).toBe(0);

  await tipTap(cdp, mark);
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).__disabledTapActions)).toBe(1);
  await cdp.detach();
});
