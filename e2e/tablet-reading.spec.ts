import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

// Product requirement: the text the user reads is 22 CSS px at fontScale=1.
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
      body: size(".original-question .original-content"),
      passage: size(".original-question .original-statements p"),
      choice: size(".original-choice-text .original-content"),
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
const ordinaryStem =
  "중립적인 화면 확인 자료입니다. 안내판에는 파란 상자와 노란 원이 나란히 있습니다. 아래 네 설명을 읽고 보인 표시와 같은 구성을 고르세요. 실제 시험이나 법률에 관한 문항은 아닙니다.";
const ordinaryChoice =
  "파란 상자의 오른쪽에 노란 원이 있고 그 아래에는 작은 초록 삼각형이 있습니다. 세 표시의 순서와 모양을 확인해 보세요.";
function layoutPackage(ordinary = false) {
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
  if (ordinary) {
    for (const q of questions) {
      q.body = [
        { type: "text", text: ordinaryStem },
        {
          type: "statements",
          entries: [
            { label: "㉠", text: "표시 순서는 파란 상자, 노란 원입니다." },
          ],
        },
      ];
      for (const c of q.choices)
        c.blocks = [{ type: "text", text: ordinaryChoice }];
    }
  }
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
async function beginLongDemo(page: Page, fontScale = 1, ordinary = false) {
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByLabel("문제 JSON 가져오기", { exact: true }).setInputFiles({
    name: "TABLET_LAYOUT_ONLY.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(layoutPackage(ordinary))),
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

async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}
async function activeSession(page: Page) {
  return (await stored(page)).state.sessions.find(
    (s: any) => s.status === "active",
  );
}

test("실제 읽기 글씨 22px·단일 열·기본 접힘 답안표와 48px 번호를 7개 화면에서 유지한다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await beginDemo(page);
  const measured: unknown[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const metrics = await fontMetrics(page);
    measured.push({ viewport, ...metrics });
    for (const value of Object.values(metrics)) {
      expect(value).toBeGreaterThanOrEqual(viewport.width >= 800 ? 21 : 20);
      expect(value).toBeLessThanOrEqual(23);
    }
    expect(metrics.choice).toBeCloseTo(metrics.body, 2);
    expect(metrics.passage).toBeCloseTo(metrics.body, 2);
    await expect(page.locator(".original-header")).toBeHidden();
    await expect(page.locator(".original-nav")).toBeHidden();
    const sheet = page.locator(".quiz-answer-shell");
    await expect(sheet).toHaveAttribute("data-overlay", "true");
    await expect(sheet).toBeHidden();
    await noPageOverflow(page);
    const cardBefore = (await page
      .locator(".original-question")
      .boundingBox())!;
    if (viewport.width === 1280 || viewport.width === 1536)
      expect(cardBefore.width / viewport.width).toBeGreaterThanOrEqual(0.94);
    for (const selector of [
      ".original-choice-button",
      ".original-movement button",
      ".original-finish button",
      ".quiz-reading-menu > button",
    ]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    const trigger = page.getByRole("button", { name: /^답안표 \d+\/\d+$/ });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(sheet).toBeVisible();
    expect(
      (await page.locator(".original-question").boundingBox())!.width,
    ).toBeCloseTo(cardBefore.width, 1);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  expect((await stored(page)).state.settings.fontScale).toBe(1);
  console.log("TABLET_PATCH_COMPUTED", JSON.stringify(measured));
});

test("보통 분량 중립 fixture의 발문·네 선택지를 가로 화면의 넓은 읽기 열에서 함께 확인한다", async ({
  page,
}) => {
  expect(ordinaryStem.length).toBeGreaterThanOrEqual(80);
  expect(ordinaryStem.length).toBeLessThanOrEqual(120);
  expect(ordinaryChoice.length).toBeGreaterThanOrEqual(60);
  expect(ordinaryChoice.length).toBeLessThanOrEqual(80);
  await page.setViewportSize({ width: 1280, height: 800 });
  await beginLongDemo(page, 1, true);
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(
      page.locator(".original-question .original-content").first(),
    ).toHaveText(ordinaryStem);
    await expect(page.locator(".original-choice-text")).toHaveCount(4);
    for (const row of await page.locator(".original-choice-text").all())
      await expect(row).toHaveText(ordinaryChoice);
    const bounds = await page
      .locator(".original-choice-row")
      .last()
      .boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await noPageOverflow(page);
    await page.screenshot({
      path: `test-results/tablet-patch-ordinary-${viewport.width}.png`,
      fullPage: true,
    });
  }
});

test.describe("터치·긴 문제·회전", () => {
  test.use({ hasTouch: true });
  test("번호만 답 선택하고 문장 탭·드래그는 선택하지 않으며 일반 학습 제출·잠금을 유지한다", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await beginLongDemo(page, 1, true);
    const buttons = page.locator(".original-choice-button");
    const firstText = page.locator(".original-choice-text").first();
    await expect(firstText.locator("button,input,label")).toHaveCount(0);
    for (const button of await buttons.all()) {
      expect((await button.innerText()).trim().length).toBeLessThanOrEqual(2);
      await expect(button.locator(".original-content,img")).toHaveCount(0);
      await expect(button).toHaveAttribute("aria-pressed", "false");
    }
    await firstText.tap();
    const textBox = (await firstText.boundingBox())!;
    await page.mouse.move(textBox.x + 10, textBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(textBox.x + 100, textBox.y + 35, { steps: 8 });
    await page.mouse.up();
    await page.locator(".original-statements").first().tap();
    for (const button of await buttons.all())
      await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("button", { name: "답 제출", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("2");
    await expect(
      page.getByRole("button", { name: "2번 선택", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect((await stored(page)).state.attempts).toHaveLength(0);
    await page.getByRole("button", { name: "4번 선택", exact: true }).tap();
    await expect(
      page.getByRole("button", { name: "4번 선택", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await firstText.tap();
    await expect(
      page.getByRole("button", { name: "4번 선택", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "답 제출", exact: true }).click();
    await expect
      .poll(async () => (await stored(page)).state.attempts.length)
      .toBe(1);
    expect((await stored(page)).state.attempts[0].response).toBe(4);
    for (const button of await buttons.all())
      await expect(button).toBeDisabled();
    await page.keyboard.press("1");
    expect((await stored(page)).state.attempts[0].response).toBe(4);
    await page.getByRole("button", { name: "다음 문항", exact: true }).click();
    await page
      .getByRole("button", { name: "모르겠음 제출", exact: true })
      .click();
    await expect
      .poll(async () => (await stored(page)).state.attempts.length)
      .toBe(2);
    expect((await stored(page)).state.attempts[1].result).toBe("unknown");
  });

  test("긴 중립 문장·의미 있는 줄바꿈·보기·넓은 그림과 마지막 선택지·피드백을 가리지 않는다", async ({
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
    await image.tap();
    await expect(
      page.getByRole("button", { name: "1번 선택", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    const stem = page.locator(".original-question .original-content").first();
    await expect(stem).toContainText("㉠·㉡");
    await expect(stem).toContainText(
      "TEST_REFERENCE_2026_01234567890123456789",
    );
    expect(
      await stem.evaluate((el) => getComputedStyle(el).whiteSpace),
    ).toMatch(/pre/);
    await page.screenshot({
      path: "test-results/tablet-long-reading-800.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "4번 선택", exact: true }).click();
    await page
      .getByRole("button", { name: "답 제출", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "답 제출", exact: true }),
    ).toBeInViewport();
    await page.getByRole("button", { name: "답 제출", exact: true }).click();
    await expect(page.locator(".original-feedback")).toContainText("오답");
    await page.locator(".original-feedback").scrollIntoViewIfNeeded();
    expect(
      await page.locator(".original-feedback").evaluate((element) => {
        const r = element.getBoundingClientRect();
        return r.bottom <= innerHeight && r.top >= 0;
      }),
    ).toBe(true);
    await page.getByRole("button", { name: "다음 문항", exact: true }).click();
    await expect(
      page.locator(".original-question .original-content").first(),
    ).toContainText("202");
    await noPageOverflow(page);
    await page.screenshot({
      path: "test-results/tablet-short-reading-800.png",
      fullPage: true,
    });
  });

  for (const fontScale of [1.25, 1.5, 2]) {
    test(`${fontScale * 100}% 저장값은 유지되고 한 번만 적용하며 가로·분할창·작은 화면에서 끝까지 읽는다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await beginLongDemo(page, fontScale);
      const metrics = await fontMetrics(page);
      for (const size of Object.values(metrics))
        expect(size).toBeCloseTo(22 * fontScale, 2);
      expect((await stored(page)).state.settings.fontScale).toBe(fontScale);
      await expect(page.locator(".quiz-answer-shell")).toBeHidden();
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 640, height: 900 },
        { width: 360, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        await noPageOverflow(page);
        const values = await fontMetrics(page);
        const expected = (viewport.width <= 480 ? 20 : 22) * fontScale;
        for (const size of Object.values(values))
          expect(size).toBeCloseTo(expected, 2);
        await page
          .getByRole("button", { name: "4번 선택", exact: true })
          .scrollIntoViewIfNeeded();
        await expect(
          page.getByRole("button", { name: "4번 선택", exact: true }),
        ).toBeInViewport();
        await page
          .getByRole("button", { name: "답 제출", exact: true })
          .scrollIntoViewIfNeeded();
        await expect(
          page.getByRole("button", { name: "답 제출", exact: true }),
        ).toBeInViewport();
      }
      await page.reload();
      await expect(
        page.getByRole("button", { name: "1번 선택", exact: true }),
      ).toBeVisible();
      expect((await stored(page)).state.settings.fontScale).toBe(fontScale);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screenshot({
        path: `test-results/tablet-reading-${fontScale * 100}-1280.png`,
        fullPage: true,
      });
    });
  }

  test("100문항 답안표의 이동·검토·닫기·포커스와 회전·글씨 조절이 답안·마감 시각을 보존한다", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-23T01:00:00.000Z") });
    await page.setViewportSize({ width: 800, height: 1280 });
    await beginDemo(page, true);
    await page.getByRole("button", { name: "1번 선택", exact: true }).click();
    await expect
      .poll(
        async () =>
          Object.values((await activeSession(page)).responses).filter(
            (x) => x != null,
          ).length,
      )
      .toBe(1);
    const first = await activeSession(page);
    await page.getByRole("button", { name: "검토 표시", exact: true }).click();
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
    await expect(answerButtons.first()).toHaveClass(/filled/);
    await expect(answerButtons.first()).toContainText("◇");
    for (const box of await answerButtons.evaluateAll((buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }),
    )) {
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    await page.keyboard.press("Shift+Tab");
    await expect(answerButtons.last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await sheet
      .getByRole("button", { name: "2번 문항으로 이동", exact: true })
      .click();
    await expect(sheet).toBeHidden();
    await expect.poll(async () => (await activeSession(page)).index).toBe(1);
    await page.getByRole("button", { name: "2번 선택", exact: true }).click();
    await page.getByRole("button", { name: "3번 선택", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "3번 선택", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const beforeTypeChange = await activeSession(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(".quiz-answer-shell")).toHaveAttribute(
      "data-overlay",
      "true",
    );
    await expect(page.locator(".quiz-answer-shell")).toBeHidden();
    await page
      .getByRole("button", { name: "글씨 키우기", exact: true })
      .click();
    await expect
      .poll(async () => (await stored(page)).state.settings.fontScale)
      .toBe(1.25);
    await expect(page.getByLabel("현재 글씨 크기", { exact: true })).toHaveText(
      "125%",
    );
    expect((await fontMetrics(page)).body).toBeCloseTo(27.5, 2);
    await expect(
      page.getByRole("button", { name: "3번 선택", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect((await activeSession(page)).deadlineAt).toBe(first.deadlineAt);
    expect((await activeSession(page)).responses).toEqual(
      beforeTypeChange.responses,
    );
    await page
      .getByRole("button", { name: "글씨 줄이기", exact: true })
      .click();
    await expect
      .poll(async () => (await stored(page)).state.settings.fontScale)
      .toBe(1);
    const timer = page.getByRole("timer", { name: "남은 시간", exact: true });
    const remainingBefore = timerSeconds(await timer.innerText());
    await page.clock.runFor(60000);
    await page.setViewportSize({ width: 800, height: 1280 });
    const remainingAfter = timerSeconds(await timer.innerText());
    expect(remainingBefore - remainingAfter).toBeGreaterThanOrEqual(59);
    expect(remainingBefore - remainingAfter).toBeLessThanOrEqual(62);
    const after = await activeSession(page);
    expect(after.deadlineAt).toBe(first.deadlineAt);
    expect(after.index).toBe(1);
    expect(after.responses).toEqual(beforeTypeChange.responses);
    expect(after.questions.map((q: any) => q.id)).toEqual(
      first.questions.map((q: any) => q.id),
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
    expect((await activeSession(page)).deadlineAt).toBe(first.deadlineAt);
    expect((await stored(page)).state.settings.fontScale).toBe(1);
  });
});
