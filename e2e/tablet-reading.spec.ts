import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

// Frozen from isolated Chromium before any tablet CSS, settings.fontScale = 1.
const baseline = { body: 15.2, passage: 14.4, choice: 13.92 };
const viewports = [
  { width: 800, height: 1280 },
  { width: 960, height: 1536 },
  { width: 1280, height: 800 },
  { width: 1536, height: 960 },
  { width: 640, height: 900 },
  { width: 1440, height: 900 },
  { width: 360, height: 800 },
];
function timerSeconds(text: string) {
  const match = text.match(/(\d+):(\d{2})/);
  if (!match) throw new Error(`남은 시간 표시를 읽을 수 없습니다: ${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

async function stored(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<any>((resolve, reject) => {
        const request = indexedDB.open("police-ox-storage", 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("states", "readonly"),
            get = tx.objectStore("states").get("original:demo");
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
}
async function fontMetrics(page: Page) {
  return page.evaluate(() => {
    const size = (selector: string) =>
      parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize);
    return {
      body: size(".original-question > .original-content"),
      passage: size(".original-question > .original-statements p"),
      choice: size(".original-choices button .original-content"),
    };
  });
}
async function beginDemo(page: Page, exam = false) {
  await page.goto("/?view=original&mode=demo");
  await page
    .getByRole("button", { name: exam ? "모의고사" : "일반 학습", exact: true })
    .click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "1번 선택", exact: true }),
  ).toBeVisible();
}
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Buffer) {
  const type = Buffer.from(kind),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
function wideTestPng() {
  const width = 1600,
    height = 200,
    header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const index = row * (width * 4 + 1) + 1 + column * 4;
      pixels[index] = column % 200 < 100 ? 125 : 225;
      pixels[index + 1] = row % 40 < 20 ? 185 : 225;
      pixels[index + 2] = 200;
      pixels[index + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function layoutPackage() {
  const image = wideTestPng();
  const questions = [201, 202].map((number) => ({
    id: `demo_const_${number}`,
    revision: 1,
    gradingRevision: 1,
    subjectId: "constitution",
    source: {
      examCode: "demo",
      year: 2099,
      round: "9",
      examName: "자동화 화면 확인용 가상 자료 · 실제 기출 아님",
      questionNumber: number,
      questionPdf: null,
      answerPdf: null,
    },
    body: [
      {
        type: "text",
        text: `자동화 화면 확인용 가상 문항 ${number}. 법률 내용이 아닙니다.\n${"파란 상자 안의 표시를 읽고 같은 모양을 고릅니다. 긴 한국어 문장과 공백, 괄호 (안내), 기호 ㉠·㉡, TEST_REFERENCE_2026_01234567890123456789를 보존합니다. ".repeat(number === 201 ? 12 : 1)}`,
      },
      {
        type: "statements",
        entries: [
          {
            label: "㉠",
            text: "가상 제시문입니다. 파란 상자와 노란 원을 확인합니다.\n두 번째 문단도 그대로 읽을 수 있어야 합니다.",
          },
          { label: "㉡", text: "개별 보기의 순서와 문구를 바꾸지 않습니다." },
        ],
      },
      {
        type: "image",
        assetId: "tablet-layout-wide-png",
        alt: "자동화 확인용 1600픽셀 가상 표 이미지",
      },
    ],
    choices: [1, 2, 3, 4].map((choice) => ({
      number: choice,
      blocks: [
        {
          type: "text",
          text: `${choice}번 가상 표시 — ${"파란 상자와 노란 원이 나란히 있습니다. ".repeat(number === 201 ? 6 : 1)}`,
        },
      ],
    })),
    officialAnswer: { status: "demo", kind: "single", acceptedChoices: [1] },
    classification: {
      studyUnitCode: "CONST-01",
      relatedStudyUnitCodes: [],
      studyStatus: "confirmed",
      bookUnitIds: [],
      blueprintAreaCode: "CONST-THEORY",
      blueprintStatus: "confirmed",
    },
    qa: {
      textStatus: "checked",
      answerStatus: "checked",
      notes: ["중립적 자동화 레이아웃 자료이며 실제 시험·법률 내용이 아님"],
    },
    lifecycle: "active",
  }));
  return {
    format: "police-original-questions",
    schemaVersion: "1.0.0",
    packageId: "tablet-layout-only",
    packageVersion: 1,
    exportedAt: "2026-10-23T00:00:00.000Z",
    dataKind: "demo",
    stage: "classified",
    unitRegistryVersion: "1.0.0",
    questions,
    assets: [
      {
        assetId: "tablet-layout-wide-png",
        mimeType: "image/png",
        sha256: createHash("sha256").update(image).digest("hex"),
        base64: image.toString("base64"),
      },
    ],
  };
}
async function beginLongDemo(page: Page, fontScale = 1) {
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByLabel("문제 JSON 가져오기", { exact: true }).setInputFiles({
    name: "TABLET_LAYOUT_ONLY.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(layoutPackage())),
  });
  await page
    .getByRole("button", { name: "확인하고 적용", exact: true })
    .click();
  await expect(
    page.getByText("검증한 데이터를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  if (fontScale !== 1)
    await page
      .getByRole("combobox", { name: /^글자 크기/ })
      .selectOption(String(fontScale));
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("combobox", { name: /^연도/ }).selectOption("2099");
  await page.getByRole("combobox", { name: /^회차/ }).selectOption("9");
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "1번 선택", exact: true }),
  ).toBeVisible();
}

test("읽기 글씨는 측정 기준 대비 8~12% 확대되고 7개 화면에서 단일/이중 영역·48px 조작을 유지한다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await beginDemo(page);
  const values: unknown[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const metrics = await fontMetrics(page);
    values.push({ viewport, ...metrics });
    for (const key of ["body", "passage", "choice"] as const) {
      expect(metrics[key] / baseline[key]).toBeGreaterThanOrEqual(1.08);
      expect(metrics[key] / baseline[key]).toBeLessThanOrEqual(1.12);
    }
    await expect(page.locator(".original-header")).toBeHidden();
    await expect(page.locator(".original-nav")).toBeHidden();
    await expect(page.locator(".quiz-answer-shell")).toHaveAttribute(
      "data-overlay",
      viewport.width >= 1024 ? "false" : "true",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const selector of [
      ".original-choices button",
      ".original-movement button",
      ".original-finish button",
      ".quiz-reading-menu > button",
    ]) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(48);
      expect(box!.height).toBeGreaterThanOrEqual(48);
    }
  }
  expect((await stored(page)).state.settings.fontScale).toBe(1);
  console.log("TABLET_COMPUTED_FONT_SIZES", JSON.stringify(values));
});

test.describe("터치·긴 문제·회전", () => {
  test.use({ hasTouch: true });
  test("긴 중립 문장·보기·넓은 그림과 마지막 선택지·피드백을 가리지 않는다", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 1280 });
    await beginLongDemo(page);
    const image = page.getByAltText("자동화 확인용 1600픽셀 가상 표 이미지", {
      exact: true,
    });
    expect(
      await image.evaluate(
        (element: HTMLImageElement) =>
          element.complete &&
          element.naturalWidth === 1600 &&
          element.width <= element.parentElement!.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/tablet-long-reading-800.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "4번 선택", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "답 제출", exact: true }),
    ).toBeInViewport();
    await page.getByRole("button", { name: "답 제출", exact: true }).click();
    await expect(page.locator(".original-feedback")).toContainText("오답");
    await page.locator(".original-feedback").scrollIntoViewIfNeeded();
    expect(
      await page.locator(".original-feedback").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom <= innerHeight && rect.top >= 0;
      }),
    ).toBe(true);
    await page.getByRole("button", { name: "다음 문항", exact: true }).click();
    await expect(
      page.locator(".original-question > .original-content"),
    ).toContainText("202");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/tablet-short-reading-800.png",
      fullPage: true,
    });
  });
  test("200% 사용자 설정은 유지되고 가로에서도 접는 답안표와 전체 문장을 사용할 수 있다", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await beginLongDemo(page, 2);
    await expect(page.locator(".quiz-answer-shell")).toHaveAttribute(
      "data-overlay",
      "true",
    );
    await expect(
      page.getByRole("button", { name: "답안표 0/2", exact: true }),
    ).toBeVisible();
    const metrics = await fontMetrics(page);
    for (const key of ["body", "passage", "choice"] as const)
      expect(metrics[key]).toBeCloseTo(baseline[key] * 1.1 * 2, 2);
    expect((await stored(page)).state.settings.fontScale).toBe(2);
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 640, height: 900 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "4번 선택", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", { name: "4번 선택", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "답 제출", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", { name: "답 제출", exact: true }),
      ).toBeInViewport();
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({
      path: "test-results/tablet-reading-200-1280.png",
      fullPage: true,
    });
  });
  test("100문항 답안표의 열기·포커스·문항 이동·닫기와 화면 회전이 답안·마감 시각을 보존한다", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-23T01:00:00.000Z") });
    await page.setViewportSize({ width: 800, height: 1280 });
    await beginDemo(page, true);
    await page.getByRole("button", { name: "1번 선택", exact: true }).click();
    const first = (await stored(page)).state.sessions.find(
      (session: any) => session.status === "active",
    );
    const toggle = page.getByRole("button", {
      name: "답안표 1/100",
      exact: true,
    });
    await toggle.click();
    const sheet = page.getByRole("dialog", { name: "답안표", exact: true });
    await expect(sheet).toBeVisible();
    await expect(
      page.getByRole("button", { name: "답안표 닫기", exact: true }),
    ).toBeFocused();
    const answerButtons = sheet.locator(".original-answer-map button");
    await expect(answerButtons).toHaveCount(100);
    const answerBoxes = await answerButtons.evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    for (const box of answerBoxes) {
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    await page.keyboard.press("Shift+Tab");
    await expect(
      sheet.locator(".original-answer-map button").last(),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await sheet
      .getByRole("button", { name: "2번 문항으로 이동", exact: true })
      .click();
    await expect(sheet).toBeHidden();
    await expect
      .poll(
        async () =>
          (await stored(page)).state.sessions.find(
            (session: any) => session.id === first.id,
          ).index,
      )
      .toBe(1);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(".quiz-answer-shell")).toHaveAttribute(
      "data-overlay",
      "false",
    );
    const timer = page.getByRole("timer", { name: "남은 시간", exact: true });
    await expect(timer).toContainText(/100:00|99:5\d/);
    const remainingBefore = timerSeconds(await timer.innerText());
    await page.clock.runFor(60000);
    await page.setViewportSize({ width: 800, height: 1280 });
    await expect(timer).toContainText(/99:0\d|98:5\d/);
    const remainingAfter = timerSeconds(await timer.innerText());
    expect(remainingBefore - remainingAfter).toBeGreaterThanOrEqual(59);
    expect(remainingBefore - remainingAfter).toBeLessThanOrEqual(62);
    const after = (await stored(page)).state.sessions.find(
      (session: any) => session.id === first.id,
    );
    expect(after.deadlineAt).toBe(first.deadlineAt);
    expect(after.index).toBe(1);
    expect(after.responses).toEqual(first.responses);
    expect(after.questions.map((question: any) => question.id)).toEqual(
      first.questions.map((question: any) => question.id),
    );
    await page.reload();
    await expect(timer).toContainText(/99:0\d|98:5\d/);
    const remainingReloaded = timerSeconds(await timer.innerText());
    expect(remainingReloaded).toBeLessThanOrEqual(remainingAfter);
    const expectedReloaded = await page.evaluate(
      (deadlineAt) => Math.ceil((Date.parse(deadlineAt) - Date.now()) / 1000),
      first.deadlineAt,
    );
    expect(Math.abs(remainingReloaded - expectedReloaded)).toBeLessThanOrEqual(
      1,
    );
    expect(
      (await stored(page)).state.sessions.find(
        (session: any) => session.id === first.id,
      ).deadlineAt,
    ).toBe(first.deadlineAt);
    expect((await stored(page)).state.settings.fontScale).toBe(1);
  });
});
