import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  initialOriginalState,
  startSession,
  defaultSelection,
  answer,
  move,
  finish,
  type OriginalState,
} from "../src/original/engine";
import type { OriginalPackage } from "../src/original/model";
import { questionFingerprint } from "../src/original/explanations/contract";
import { explanationSyncFixture } from "../tests/fixtures/explanation-sync";

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const paper = (page: Page) =>
  page.locator('.ink-surface[data-ink-surface="paper"]');
const wrongChoice = (q: OriginalState["data"]["questions"][number]) =>
  ([1, 2, 3, 4] as const).find(
    (n) => !q.officialAnswer.acceptedChoices.includes(n),
  )!;

async function seed(
  page: Page,
  state: OriginalState,
  explanations?: { instructor?: unknown; legacy?: unknown },
) {
  await page.goto("/?view=original&mode=demo");
  await page
    .getByRole("heading", { name: "원문 기출 학습", exact: true })
    .waitFor();
  await page.evaluate(
    async ({ state, explanations }) => {
      const put = (
        name: string,
        version: number,
        stores: string[],
        values: { store: string; key: string; value: unknown }[],
      ) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(name, version);
          request.onupgradeneeded = () => {
            for (const name of stores)
              if (!request.result.objectStoreNames.contains(name))
                request.result.createObjectStore(name);
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction(stores, "readwrite");
            for (const item of values)
              tx.objectStore(item.store).put(item.value, item.key);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        });
      await put(
        "police-ox-storage",
        1,
        ["states"],
        [
          {
            store: "states",
            key: "original:demo",
            value: { generation: 1, state },
          },
        ],
      );
      if (explanations)
        await put(
          "police-original-explanations",
          2,
          ["collections", "instructorCollections"],
          [
            {
              store: "collections",
              key: JSON.stringify(["local", "demo"]),
              value: {
                generation: 1,
                packages: explanations.legacy ? [explanations.legacy] : [],
              },
            },
            {
              store: "instructorCollections",
              key: JSON.stringify(["local", "demo"]),
              value: {
                generation: 1,
                packages: explanations.instructor
                  ? [explanations.instructor]
                  : [],
              },
            },
          ],
        );
    },
    { state, explanations },
  );
  await page.reload();
  await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
}

function answerState(exam = false) {
  const state = initialOriginalState("demo"),
    questions = state.data.questions.slice(0, 5);
  const prior = startSession(
    state,
    "demo",
    { ...defaultSelection, limit: 5 },
    "study",
    Date.now(),
    questions,
  );
  for (let i = 0; i < questions.length; i++) {
    move(state, prior.id, i);
    answer(
      state,
      prior.id,
      i === 1
        ? (questions[i].officialAnswer.acceptedChoices[0] as 1 | 2 | 3 | 4)
        : wrongChoice(questions[i]),
    );
  }
  finish(state, prior.id);
  const current = startSession(
    state,
    "demo",
    { ...defaultSelection, subjectId: "", limit: exam ? 100 : 5 },
    exam ? "exam" : "study",
    Date.now(),
    exam ? state.data.questions : questions,
  );
  answer(
    state,
    current.id,
    questions[0].officialAnswer.acceptedChoices[0] as 1 | 2 | 3 | 4,
  );
  move(state, current.id, 1);
  answer(state, current.id, wrongChoice(questions[1]));
  move(state, current.id, 2);
  answer(state, current.id, "unknown");
  move(state, current.id, 1);
  current.review[current.questions[1].id] = true;
  return state;
}

test("답안표는 현재 세션의 저장된 정답·오답·모르겠음만 칠하고 현재 오답의 붉은색을 유지한다", async ({
  page,
}) => {
  const state = answerState();
  await seed(page, state);
  await expect(page.locator(".original-answer-map button")).toHaveCount(0);
  await page.getByRole("button", { name: /^답안표/ }).click();
  const cells = page.locator(".original-answer-map button");
  await expect(cells).toHaveCount(5);
  await expect(cells.nth(0)).toHaveAttribute("data-result", "correct");
  await expect(cells.nth(1)).toHaveAttribute("data-result", "incorrect");
  await expect(cells.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(cells.nth(1)).toHaveAccessibleName(/오답.*현재 문항.*검토 표시/);
  await expect(cells.nth(2)).toHaveAttribute("data-result", "unknown");
  await expect(cells.nth(2)).toHaveAccessibleName(/모르겠음/);
  await expect(cells.nth(3)).toHaveAttribute("data-result", "unsubmitted");
  await expect(cells.nth(4)).toHaveAttribute("data-result", "unsubmitted");
  const colors = await cells.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, outline: style.outlineStyle };
    }),
  );
  expect(colors[0].background).toBe("rgb(223, 235, 216)");
  expect(colors[1]).toEqual({
    background: "rgb(240, 222, 220)",
    outline: "solid",
  });
  expect(colors[2].background).toBe("rgb(237, 233, 223)");
  expect(colors[3].background).toBe("rgb(255, 255, 255)");
  await cells.nth(0).click();
  await page.getByRole("button", { name: /^답안표/ }).click();
  await expect(cells.nth(1)).toHaveCSS(
    "background-color",
    colors[1].background,
  );
});

test("진행 중 모의고사는 과거 정오답을 숨기고 응답·검토를 중립 표시하며 제출 전 Attempt를 만들지 않는다", async ({
  page,
}) => {
  const state = answerState(true),
    session = state.sessions.at(-1)!;
  await seed(page, state);
  await page.getByRole("button", { name: /^답안표/ }).click();
  const cells = page.locator(".original-answer-map button");
  await expect(cells).toHaveCount(100);
  for (let i = 0; i < 4; i++)
    await expect(cells.nth(i)).toHaveAttribute("data-result", "unsubmitted");
  for (const name of await cells.allTextContents())
    expect(name).not.toMatch(/정답|오답/);
  await expect(cells.nth(0)).toHaveCSS(
    "background-color",
    "rgb(231, 236, 238)",
  );
  await expect(cells.nth(1)).toHaveAccessibleName(
    /응답.*미제출.*현재 문항.*검토 표시/,
  );
  await page.getByRole("button", { name: "답안표 닫기", exact: true }).click();
  await expect(page.locator(".original-feedback")).toHaveCount(0);
  await expect(
    page.locator(".instructor-explanation-panel,.explanation-panel"),
  ).toHaveCount(0);
  const currentAttempts = await page.evaluate(
    async (id) =>
      new Promise<unknown[]>((resolve, reject) => {
        const r = indexedDB.open("police-ox-storage");
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("states", "readonly"),
            row = tx.objectStore("states").get("original:demo");
          tx.oncomplete = () => {
            db.close();
            resolve(
              row.result.state.attempts.filter(
                (a: { sessionId: string }) => a.sessionId === id,
              ),
            );
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    session.id,
  );
  expect(currentAttempts).toEqual([]);
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 800, height: 1280 },
])
  test(`해설 앞 이동 버튼의 DOM 순서와 별도 필기 면을 유지한다 ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const source: OriginalPackage = JSON.parse(
      readFileSync(
        resolve("tests/fixtures/explanations/questions.demo.json"),
        "utf8",
      ),
    );
    const legacy = JSON.parse(
      readFileSync(
        resolve("tests/fixtures/explanations/valid.demo.json"),
        "utf8",
      ),
    );
    const instructor = (await explanationSyncFixture()).instructor,
      q = source.questions[0];
    instructor.dataKind = "demo";
    instructor.documents[0].exam = {
      ...instructor.documents[0].exam,
      examCode: "demo",
      subjectId: q.subjectId,
      year: q.source.year,
      round: q.source.round,
    };
    Object.assign(instructor.records[0], {
      questionId: q.id,
      subjectId: q.subjectId,
      questionRevision: q.revision,
      gradingRevision: q.gradingRevision,
      questionFingerprint: await questionFingerprint(q, source.assets),
      scope: { kind: "question", targets: [] },
      officialAnswer: structuredClone(q.officialAnswer),
    });
    instructor.records[0].sourceKey = {
      ...instructor.records[0].sourceKey,
      examCode: "demo",
      year: q.source.year,
      round: q.source.round,
      questionNumber: q.source.questionNumber,
    };
    const state = initialOriginalState("demo");
    state.data = {
      questions: source.questions,
      assets: source.assets,
      packages: [source],
    };
    const session = startSession(
      state,
      "demo",
      { ...defaultSelection, limit: 2 },
      "study",
      Date.now(),
      source.questions,
    );
    answer(state, session.id, 2);
    await seed(page, state, { instructor, legacy });
    await expect(page.locator(".instructor-explanation-panel")).toBeVisible();
    await expect(page.locator(".explanation-panel")).toBeVisible();
    expect(
      await page.evaluate(() => {
        const movement = document.querySelector(".original-movement")!;
        return (
          [
            ...document.querySelectorAll(
              ".instructor-explanation-panel,.explanation-panel",
            ),
          ].every(
            (panel) =>
              !!(
                movement.compareDocumentPosition(panel) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ),
          ) &&
          !document.querySelector(
            ".ink-content .original-movement,.ink-content .instructor-explanation-panel,.ink-content .explanation-panel",
          )
        );
      }),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "다음 문항", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "다음 문항", exact: true }).click();
    await expect(page.locator(".quiz-reading-position")).toContainText("2");
    await expect(
      page.getByRole("button", { name: "다음 문항", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "이전 문항", exact: true }).click();
    await expect(page.locator(".original-feedback")).toContainText("정답");
  });

async function touchPan(
  cdp: CDPSession,
  x: number,
  y: number,
  dx: number,
  dy: number,
) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x, y }],
  });
  for (let n = 1; n <= 8; n++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ id: 1, x: x + (dx * n) / 8, y: y + (dy * n) / 8 }],
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

async function touchPinch(cdp: CDPSession, page: Page, x: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: x - 50, y },
      { id: 2, x: x + 50, y },
    ],
  });
  for (let n = 1; n <= 20; n++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { id: 1, x: x - 50 - n * 7, y },
        { id: 2, x: x + 50 + n * 7, y },
      ],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

test("브라우저 핀치·연속 탭은 화면 scale을 바꾸지 않고 손의 세로·그림 가로 이동과 필기를 보존한다", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage(),
    cdp = await context.newCDPSession(page);
  try {
    // Positive control proves this CDP gesture reaches the browser's zoom path.
    await page.route("http://v13-zoom-control.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=yes"><div style="height:4000px;touch-action:auto">neutral zoom control</div>',
      }),
    );
    await page.goto("http://v13-zoom-control.test/");
    await touchPinch(cdp, page, 600, 400);
    await expect
      .poll(() => page.evaluate(() => visualViewport!.scale))
      .toBeGreaterThan(1.1);
    const state = initialOriginalState("demo"),
      q = state.data.questions[0];
    const png = readFileSync(resolve("public/icons/ox-192.png"));
    state.data.assets = [
      {
        assetId: "v13-neutral-figure",
        mimeType: "image/png",
        sha256: createHash("sha256").update(png).digest("hex"),
        base64: png.toString("base64"),
      },
    ];
    q.body = [
      {
        type: "image",
        assetId: "v13-neutral-figure",
        alt: "중립 가로 이동 확인 그림",
      },
      ...Array.from({ length: 15 }, (_, i) => ({
        type: "text" as const,
        text: `중립 이동 문단 ${i + 1}. 도형과 색상을 비교하는 화면 검사 자료입니다. `.repeat(
          10,
        ),
      })),
    ];
    state.data.packages[0].questions = structuredClone(state.data.questions);
    state.data.packages[0].assets = structuredClone(state.data.assets);
    startSession(
      state,
      "demo",
      { ...defaultSelection, limit: 2 },
      "study",
      Date.now(),
      state.data.questions.slice(0, 2),
    );
    await seed(page, state);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await page
      .getByAltText("중립 가로 이동 확인 그림", { exact: true })
      .evaluate((image) =>
        Object.assign((image as HTMLElement).style, {
          minWidth: "1800px",
          maxWidth: "none",
          height: "90px",
        }),
      );
    await expect(paper(page)).toHaveAttribute("data-ink-ready", "true");
    const figure = page.locator(".original-question figure");
    const box = (await figure.boundingBox())!;
    await touchPan(cdp, box.x + 500, box.y + 35, -250, 0);
    expect(
      await figure.evaluate((element) => element.scrollLeft),
    ).toBeGreaterThan(150);
    expect(await page.evaluate(() => scrollX)).toBe(0);
    await page.evaluate(() => scrollTo(0, 0));
    const ink = paper(page),
      b = (await ink.boundingBox())!;
    await ink.dispatchEvent("pointerdown", {
      pointerId: 77,
      pointerType: "pen",
      clientX: b.x + 100,
      clientY: b.y + 12,
      button: 0,
      buttons: 1,
      pressure: 0.5,
      bubbles: true,
    });
    await ink.dispatchEvent("pointerup", {
      pointerId: 77,
      pointerType: "pen",
      clientX: b.x + 220,
      clientY: b.y + 12,
      button: 0,
      buttons: 0,
      pressure: 0,
      bubbles: true,
    });
    await expect(ink.locator("g[data-ink-stroke]")).toHaveCount(1);
    const path = await ink.locator("g[data-ink-stroke] path").getAttribute("d");
    await touchPinch(cdp, page, 700, 500);
    await expect.poll(() => page.evaluate(() => visualViewport!.scale)).toBe(1);
    for (let tap = 0; tap < 2; tap++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ id: 1, x: 700, y: 500 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(70);
    }
    await expect.poll(() => page.evaluate(() => visualViewport!.scale)).toBe(1);
    // Both contacts stay in the 16px outer gutter, outside the manual-pan guard.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { id: 1, x: 8, y: 370 },
        { id: 2, x: 8, y: 430 },
      ],
    });
    for (let n = 1; n <= 8; n++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { id: 1, x: 8, y: 370 - n * 5 },
          { id: 2, x: 8, y: 430 + n * 5 },
        ],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect.poll(() => page.evaluate(() => visualViewport!.scale)).toBe(1);
    await page.evaluate(() => scrollTo(0, 0));
    await touchPan(cdp, 8, 650, 0, -280);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(150);
    await page.evaluate(() => scrollTo(0, 0));
    await touchPan(cdp, 1000, 650, 0, -280);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(180);
    await expect(ink.locator("g[data-ink-stroke] path")).toHaveAttribute(
      "d",
      path!,
    );
    await expect(
      page.locator(".original-choice-button[aria-pressed=true]"),
    ).toHaveCount(0);
    await expect(page.locator(".original-feedback")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
