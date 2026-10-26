import { test, expect, type Page } from "@playwright/test";
async function showNavigation(page: Page, label: string) {
  if (
    !(await page.getByRole("button", { name: label, exact: true }).isVisible())
  )
    await page.getByRole("button", { name: "메뉴", exact: true }).click();
}
import {
  answer,
  defaultSelection,
  finish,
  initialOriginalState,
  move,
  startSession,
  type OriginalState,
  type Response,
} from "../src/original/engine";
import type { Question } from "../src/original/model";
import { validateOriginalState } from "../src/original/storage";
import { backup as oxBackup } from "../src/data/transfer";
import { initialState as initialOxState } from "../src/fixtures/data";

const fixtureTime = Date.parse("2026-10-20T00:00:00.000Z");
const examTime = Date.parse("2026-10-23T01:00:00.000Z");
const correct = (q: Question) =>
  q.officialAnswer.acceptedChoices[0] as 1 | 2 | 3 | 4;
const wrong = (q: Question) => ((correct(q) % 4) + 1) as 1 | 2 | 3 | 4;

function learn(
  state: OriginalState,
  questions: Question[],
  responses: Response[],
  now: number,
) {
  const session = startSession(
    state,
    "demo",
    { ...defaultSelection, subjectId: "", limit: 0 },
    "study",
    now,
    questions,
  );
  questions.forEach((_, index) => {
    if (index) move(state, session.id, index, now + index * 1000);
    answer(state, session.id, responses[index], now + index * 1000);
  });
  finish(state, session.id, now + questions.length * 1000);
}

/** Legal content is never generated: these are isolated existing color/shape demo prompts. */
async function summaryFixture(activeExam = false): Promise<OriginalState> {
  const state = initialOriginalState("demo");
  const constitution = state.data.questions.filter(
    (q) => q.subjectId === "constitution",
  );
  constitution.forEach((q, index) => {
    q.classification!.studyUnitCode =
      index < 12 ? "CONST-01" : index < 18 ? "CONST-02" : "CONST-03";
    q.classification!.relatedStudyUnitCodes = index < 12 ? ["CONST-02"] : [];
    q.source.year = index >= 12 && index < 18 ? 2025 : 2026;
    q.source.round = index < 12 ? "1" : "2";
  });
  const pending = state.data.questions.find((q) => q.subjectId === "police")!;
  pending.classification!.studyUnitCode = null;
  pending.classification!.studyStatus = "pending";
  state.data.packages[0].questions = structuredClone(state.data.questions);
  // Two incorrect valid responses make one currently incorrect question repeat, never two W's.
  learn(state, [constitution[6]], [wrong(constitution[6])], fixtureTime);
  const main = constitution.slice(0, 12);
  learn(
    state,
    main,
    main.map((q, i) => (i < 6 ? correct(q) : i < 10 ? wrong(q) : "unknown")),
    fixtureTime + 60_000,
  );
  learn(
    state,
    [constitution[12]],
    [wrong(constitution[12])],
    fixtureTime + 120_000,
  );
  learn(
    state,
    constitution.slice(18),
    ["unknown", "unknown"],
    fixtureTime + 180_000,
  );
  learn(state, [pending], ["unknown"], fixtureTime + 240_000);
  // The final blank exam is deliberately later than every valid response.
  const blank = startSession(
    state,
    "demo",
    { ...defaultSelection, subjectId: "", limit: 0 },
    "exam",
    fixtureTime + 300_000,
  );
  finish(state, blank.id, fixtureTime + 360_000);
  if (activeExam) {
    const current = startSession(
      state,
      "demo",
      { ...defaultSelection, subjectId: "", limit: 0 },
      "exam",
      examTime,
    );
    const index = current.questions.findIndex(
      (q) => q.id === constitution[0].id,
    );
    move(state, current.id, index, examTime);
    answer(state, current.id, wrong(constitution[0]), examTime);
  }
  return validateOriginalState(state, "demo");
}

async function limitFixture(): Promise<OriginalState> {
  const state = initialOriginalState("demo");
  const originals = state.data.questions.filter(
    (q) => q.subjectId === "constitution",
  );
  for (let i = 101; i <= 105; i++) {
    const q = structuredClone(originals[0]);
    q.id = `demo_const_${i}`;
    q.source.questionNumber = i;
    state.data.questions.push(q);
  }
  const primary = state.data.questions.filter(
    (q) => q.subjectId === "constitution",
  );
  primary.forEach((q) => {
    q.classification!.studyUnitCode = "CONST-01";
    q.classification!.relatedStudyUnitCodes = [];
  });
  const relatedOnly = structuredClone(originals[0]);
  relatedOnly.id = "demo_const_200";
  relatedOnly.source.questionNumber = 200;
  relatedOnly.classification!.studyUnitCode = "CONST-02";
  relatedOnly.classification!.relatedStudyUnitCodes = ["CONST-01"];
  state.data.questions.push(relatedOnly);
  state.data.packages[0].questions = structuredClone(state.data.questions);
  learn(
    state,
    [...primary, relatedOnly],
    [...primary, relatedOnly].map(wrong),
    fixtureTime,
  );
  return validateOriginalState(state, "demo");
}

async function readStored(page: Page, namespace = "demo") {
  return page.evaluate(
    async (ns) =>
      new Promise<any>((resolve, reject) => {
        const request = indexedDB.open("police-ox-storage", 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("states", "readonly"),
            get = tx.objectStore("states").get(`original:${ns}`);
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
        request.onerror = () => reject(request.error);
      }),
    namespace,
  );
}

async function restoreFixture(page: Page, state: OriginalState, visit = true) {
  if (visit) await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  const backup = {
    format: "police-learning-backup",
    backupVersion: 2,
    namespace: "demo",
    exportedAt: new Date(examTime).toISOString(),
    original: state,
    ox: oxBackup(initialOxState(true), "demo"),
    generations: { original: 0, ox: 0 },
  };
  await page
    .getByLabel("전체 백업 복구", { exact: true })
    .setInputFiles({
      name: "TEST_ONLY_review-progress.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
  await page
    .getByRole("button", { name: "확인하고 적용", exact: true })
    .click();
  await expect(page.getByText(/전체 백업을 복구했습니다/)).toBeVisible();
  await expect
    .poll(async () => (await readStored(page))?.state.attempts.length)
    .toBe(state.attempts.length);
  await page.getByRole("button", { name: "학습 홈", exact: true }).click();
}

const recommendations = (page: Page) =>
  page.getByRole("region", { name: "복습 단원 추천", exact: true });
const card = (page: Page, code: string) =>
  recommendations(page).locator(`article[data-unit-code="${code}"]`);
const row = (page: Page, code: string) =>
  page.locator(`article[data-unit-code="${code}"][aria-label$=" 현황"]`);
const subject = (page: Page, id: string) =>
  page.locator(`article[data-subject-id="${id}"]`);
const recommendationOrder = (page: Page) =>
  recommendations(page)
    .locator("article[data-unit-code]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-unit-code")),
    );

test.use({ viewport: { width: 1280, height: 720 } });

test("학습 현황은 공란 뒤 유효 응답·주 단원으로 집계하고 조회와 복습 후 갱신한다", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const state = await summaryFixture();
  await restoreFixture(page, state);
  await expect
    .poll(() => recommendationOrder(page))
    .toEqual(["CONST-01", "CONST-03", "CONST-02"]);
  await expect(card(page, "CONST-01")).toContainText(/4\s*\/\s*10/);
  await expect(card(page, "CONST-01")).toContainText("40.0%");
  await page.getByRole("button", { name: /^학습 현황 보기/ }).click();
  await expect
    .poll(() => recommendationOrder(page))
    .toEqual(["CONST-01", "CONST-03", "CONST-02"]);
  await expect(subject(page, "constitution")).toContainText(/15\s*\/\s*20/);
  await expect(
    subject(page, "constitution").getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "75");
  await expect(row(page, "CONST-01")).toContainText(/12\s*\/\s*12/);
  await expect(row(page, "CONST-03")).toContainText("—");
  const summary = await subject(page, "constitution").textContent();
  await page
    .getByRole("combobox", { name: "단원 표시", exact: true })
    .selectOption({ label: "복습 필요" });
  await page
    .getByRole("combobox", { name: "단원 정렬", exact: true })
    .selectOption({ label: "오답률 높은 순" });
  expect(await subject(page, "constitution").textContent()).toBe(summary);
  await expect
    .poll(() => recommendationOrder(page))
    .toEqual(["CONST-01", "CONST-03", "CONST-02"]);
  await page
    .getByRole("combobox", { name: "현황 과목", exact: true })
    .selectOption("constitution");
  await page
    .getByRole("combobox", { name: "현황 시험 연도", exact: true })
    .selectOption("2025");
  await page
    .getByRole("combobox", { name: "현황 회차", exact: true })
    .selectOption("2");
  await expect(subject(page, "constitution")).toContainText(/1\s*\/\s*6/);
  await expect.poll(() => recommendationOrder(page)).toEqual(["CONST-02"]);
  await page
    .getByRole("combobox", { name: "현황 시험 연도", exact: true })
    .selectOption("2026");
  await page
    .getByRole("combobox", { name: "현황 회차", exact: true })
    .selectOption("1");
  await expect(subject(page, "constitution")).toContainText(/12\s*\/\s*12/);
  await expect.poll(() => recommendationOrder(page)).toEqual(["CONST-01"]);
  await page
    .getByRole("combobox", { name: "현황 과목", exact: true })
    .selectOption("");
  await page
    .getByRole("combobox", { name: "현황 시험 연도", exact: true })
    .selectOption("");
  await page
    .getByRole("combobox", { name: "현황 회차", exact: true })
    .selectOption("");
  await page
    .getByRole("combobox", { name: "단원 표시", exact: true })
    .selectOption({ label: "전체" });
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/review-progress-${viewport.width}.png`,
      fullPage: false,
    });
    await recommendations(page).screenshot({
      path: `test-results/review-recommendations-${viewport.width}.png`,
    });
    await row(page, "CONST-01").screenshot({
      path: `test-results/review-unit-${viewport.width}.png`,
    });
  }
  await card(page, "CONST-01")
    .getByRole("button", { name: /이 단원 복습/ })
    .click();
  const active = (await readStored(page)).state.sessions.find(
    (s: any) => s.status === "active",
  );
  expect(active.questions.map((q: any) => q.id)).toEqual(
    [7, 8, 9, 10, 11, 12].map((n) => `demo_const_${n}`),
  );
  await page
    .getByRole("button", {
      name: `${correct(active.questions[0])}번 선택`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "답 제출", exact: true }).click();
  await expect
    .poll(async () => (await readStored(page)).state.attempts.length)
    .toBe(state.attempts.length + 1);
  await showNavigation(page, "학습 현황");
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await expect(card(page, "CONST-01")).toContainText("30.0%");
  await expect(
    card(page, "CONST-01").getByRole("button", { name: /이 단원 복습/ }),
  ).toContainText("5문항");
  await page.getByRole("button", { name: "학습 홈", exact: true }).click();
  await page.getByRole("button", { name: /^이어 풀기/ }).click();
  await page.getByRole("button", { name: "학습 종료", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(시험 제출|학습 종료) 확정$/ })
    .click();
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await row(page, "CRIM-G-01")
    .getByRole("button", { name: /미풀이 풀기/ })
    .click();
  const unread = (await readStored(page)).state.sessions.find(
    (s: any) => s.status === "active",
  );
  expect(unread.questions).toHaveLength(20);
  expect(
    unread.questions.every(
      (q: any) =>
        q.subjectId === "criminal" &&
        q.classification.studyUnitCode === "CRIM-G-01",
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "학습 종료", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(시험 제출|학습 종료) 확정$/ })
    .click();
  await page.getByLabel("저장 영역", { exact: true }).selectOption("real");
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await expect(subject(page, "constitution")).toContainText("문제 등록 필요");
  await expect(recommendations(page)).toContainText(
    "현재 복습할 오답·모르겠음 문항이 없습니다.",
  );
});

test("추천 클릭은 저장소 최신 상태를 다시 읽고 정확한 주 단원의 20문항만 시작한다", async ({
  page,
  context,
}) => {
  const state = await limitFixture();
  await restoreFixture(page, state);
  await expect(
    card(page, "CONST-01").getByRole("button", { name: /이 단원 복습/ }),
  ).toContainText("20문항");
  const updated = structuredClone(state);
  const primary = updated.data.questions.filter(
    (q) => q.classification?.studyUnitCode === "CONST-01",
  );
  learn(updated, primary, primary.map(correct), fixtureTime + 600_000);
  await validateOriginalState(updated, "demo");
  const other = await context.newPage();
  await other.goto("/?view=original&mode=demo");
  // Mimic a second tab's valid committed write, leaving the first tab's card stale.
  await other.evaluate(
    async (next) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("police-ox-storage", 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("states", "readwrite"),
            store = tx.objectStore("states"),
            get = store.get("original:demo");
          get.onsuccess = () =>
            store.put(
              { generation: get.result.generation + 1, state: next },
              "original:demo",
            );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
    updated,
  );
  await card(page, "CONST-01")
    .getByRole("button", { name: /이 단원 복습/ })
    .click();
  await expect(
    page.getByText(
      "현재 조회 범위에 복습할 오답·모르겠음 문항이 없습니다. 현황을 갱신했습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    (await readStored(page)).state.sessions.some(
      (s: any) => s.status === "active",
    ),
  ).toBe(false);
  await expect(card(page, "CONST-01")).toHaveCount(0);
  await other.close();
  await restoreFixture(page, state, false);
  await card(page, "CONST-01")
    .getByRole("button", { name: /이 단원 복습/ })
    .click();
  const active = (await readStored(page)).state.sessions.find(
    (s: any) => s.status === "active",
  );
  expect(active.questions).toHaveLength(20);
  expect(new Set(active.questions.map((q: any) => q.id)).size).toBe(20);
  expect(
    active.questions.every(
      (q: any) => q.classification.studyUnitCode === "CONST-01",
    ),
  ).toBe(true);
  expect(active.questions.some((q: any) => q.id === "demo_const_200")).toBe(
    false,
  );
});

test("현황 화면과 추천을 오가도 진행 중 시험의 임시 답안·종료 시각을 보호한다", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(examTime) });
  await page.clock.pauseAt(new Date(examTime));
  const state = await summaryFixture(true);
  await restoreFixture(page, state);
  const original = state.sessions.find((s) => s.status === "active")!;
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await expect(subject(page, "constitution")).toContainText(/15\s*\/\s*20/);
  await page.clock.fastForward(10 * 60 * 1000);
  await card(page, "CONST-01")
    .getByRole("button", { name: /이 단원 복습/ })
    .click();
  const saved = (await readStored(page)).state;
  expect(saved.sessions.find((s: any) => s.status === "active").id).toBe(
    original.id,
  );
  expect(
    saved.sessions.find((s: any) => s.status === "active").deadlineAt,
  ).toBe(original.deadlineAt);
  expect(saved.attempts).toHaveLength(state.attempts.length);
  await expect(page.getByLabel("남은 시간", { exact: true })).toContainText(
    /90:00|89:59/,
  );
  await showNavigation(page, "학습 현황");
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await page.clock.fastForward(90 * 60 * 1000);
  await expect
    .poll(
      async () =>
        (await readStored(page)).state.sessions.find(
          (s: any) => s.id === original.id,
        ).status,
    )
    .toBe("completed");
  expect((await readStored(page)).state.attempts).toHaveLength(
    state.attempts.length + 100,
  );
});

test("단원 재분류 가져오기·자료 삭제·전체 복구 후 현황과 추천을 다시 계산한다", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const state = await summaryFixture();
  await restoreFixture(page, state);
  await expect(card(page, "CONST-01")).toContainText("40.0%");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  const waitDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "전체 백업 내보내기", exact: true })
    .click();
  const backupPath = (await (await waitDownload).path())!;
  const revised = structuredClone(state.data.packages[0]);
  revised.packageVersion++;
  const moved = revised.questions.find((q) => q.id === "demo_const_7")!;
  moved.revision++;
  moved.classification!.studyUnitCode = "CONST-02";
  moved.classification!.relatedStudyUnitCodes = [];
  await page
    .getByLabel("문제 JSON 가져오기", { exact: true })
    .setInputFiles({
      name: "TEST_ONLY_classification-only.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(revised)),
    });
  await page
    .getByRole("button", { name: "확인하고 적용", exact: true })
    .click();
  await expect(
    page.getByText("검증한 데이터를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await expect(subject(page, "constitution")).toContainText(/15\s*\/\s*20/);
  await expect(card(page, "CONST-01")).toContainText("33.3%");
  await expect(row(page, "CONST-02")).toContainText(/2\s*\/\s*7/);
  expect((await readStored(page)).state.attempts).toEqual(state.attempts);
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: `자료 선택: ${revised.packageId}`,
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "선택한 데이터 삭제", exact: true })
    .click();
  await page.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await expect(
    page.getByText("선택한 문제 데이터를 삭제했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await expect(subject(page, "constitution")).toContainText("문제 등록 필요");
  await expect(recommendations(page)).toContainText(
    "현재 복습할 오답·모르겠음 문항이 없습니다.",
  );
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page
    .getByLabel("전체 백업 복구", { exact: true })
    .setInputFiles(backupPath);
  await page
    .getByRole("button", { name: "확인하고 적용", exact: true })
    .click();
  await expect(page.getByText(/전체 백업을 복구했습니다/)).toBeVisible();
  await page.getByRole("button", { name: "학습 현황", exact: true }).click();
  await expect(subject(page, "constitution")).toContainText(/15\s*\/\s*20/);
  await expect(card(page, "CONST-01")).toContainText("40.0%");
  expect((await readStored(page)).state.attempts).toEqual(state.attempts);
});
