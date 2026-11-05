import { test, expect, type Page } from "@playwright/test";
test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const paper = (p: Page) => p.locator('.ink-surface[data-ink-surface="paper"]');
const strokes = (p: Page) => paper(p).locator("g[data-ink-stroke]");
const paths = (p: Page) =>
  strokes(p)
    .locator("path")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("d")));
async function begin(p: Page) {
  await p.goto("/?view=original&mode=demo");
  await p.getByRole("button", { name: "일반 학습", exact: true }).click();
  await p.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(paper(p)).toHaveAttribute("data-ink-ready", "true");
}
async function draw(p: Page, id: number, yOffset = 0) {
  await p.evaluate(() => scrollTo(0, 0));
  const area = paper(p),
    box = (await area.boundingBox())!;
  const event = {
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
  await area.dispatchEvent("pointerdown", event);
  await area.dispatchEvent("pointermove", {
    ...event,
    clientX: event.clientX + 60,
  });
  await area.dispatchEvent("pointerup", {
    ...event,
    clientX: event.clientX + 100,
    buttons: 0,
    pressure: 0,
  });
}
test("일시적 지면 크기 변화는 임시 획을 비우거나 배치 대기 상태로 숨기지 않는다", async ({
  page,
}) => {
  await begin(page);
  await draw(page, 801);
  await expect(strokes(page)).toHaveCount(1);
  const original = await paths(page);
  const content = paper(page).locator(":scope > .ink-content");
  await content.evaluate((el) => (el.style.display = "none"));
  await expect(strokes(page)).toHaveCount(1);
  await expect(paper(page).locator(".ink-layer")).not.toHaveAttribute(
    "data-layout-pending",
    "true",
  );
  expect(await paths(page)).toEqual(original);
  await content.evaluate((el) => el.style.removeProperty("display"));
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(original);
  await page
    .getByRole("button", { name: "필기 실행 취소", exact: true })
    .click();
  await expect(strokes(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "필기 다시 실행", exact: true })
    .click();
  expect(await paths(page)).toEqual(original);
});
test("같은 크기의 스타일·글씨·줄바꿈 변화는 하나의 임시 획 이력과 실행 취소를 유지한다", async ({
  page,
}) => {
  await begin(page);
  await draw(page, 811);
  const original = await paths(page);
  const content = paper(page).locator(":scope > .ink-content");
  await content.evaluate((el) => (el.style.letterSpacing = "0.001px"));
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(original);
  await draw(page, 812, 20);
  await expect(strokes(page)).toHaveCount(2);
  const both = await paths(page);
  await page.getByRole("button", { name: "글씨 키우기", exact: true }).click();
  await expect(strokes(page)).toHaveCount(2);
  expect(await paths(page)).toEqual(both);
  await page
    .getByRole("button", { name: "줄바꿈 방식 전환", exact: true })
    .click();
  await expect(strokes(page)).toHaveCount(2);
  expect(await paths(page)).toEqual(both);
  await content.evaluate((el) => el.style.removeProperty("letter-spacing"));
  await page
    .getByRole("button", { name: "필기 실행 취소", exact: true })
    .click();
  expect(await paths(page)).toEqual(original);
  await page
    .getByRole("button", { name: "필기 다시 실행", exact: true })
    .click();
  expect(await paths(page)).toEqual(both);
});
test("외부 stylesheet와 폭·viewport 변화 중에도 필기 레이어를 숨기지 않고 지면 좌표를 유지한다", async ({
  page,
}) => {
  await begin(page);
  await draw(page, 821);
  const original = await paths(page);
  const visibleBeforePaint = await page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const content = document.querySelector<HTMLElement>(
          '.ink-surface[data-ink-surface="paper"] > .ink-content',
        )!;
        const width = content.getBoundingClientRect().width;
        const layer = content.parentElement!.querySelector(".ink-layer")!;
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(Error("종이 크기 변경 없음"));
        }, 3000);
        const observer = new ResizeObserver((entries) => {
          if (entries[0].contentRect.width >= width - 10) return;
          clearTimeout(timeout);
          observer.disconnect();
          resolve(
            layer.getAttribute("data-layout-pending") !== "true" &&
              getComputedStyle(layer).visibility !== "hidden" &&
              layer.querySelectorAll("g[data-ink-stroke]").length === 1,
          );
        });
        observer.observe(content);
        const style = document.createElement("style");
        style.id = "temporary-paper-width";
        style.textContent =
          '.ink-surface[data-ink-surface="paper"] > .ink-content { width: calc(100% - 32px) !important; }';
        document.head.append(style);
      }),
  );
  expect(visibleBeforePaint).toBe(true);
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(original);
  await page.setViewportSize({ width: 960, height: 600 });
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(original);
  await page.evaluate(() =>
    document.getElementById("temporary-paper-width")!.remove(),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(strokes(page)).toHaveCount(1);
  expect(await paths(page)).toEqual(original);
});
