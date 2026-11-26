import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixture = (name: string) => resolve("tests/fixtures/explanations", name);
const topicTitle = "시연 도형의 모양과 표시 비교";
const reviewedNote =
  "도형의 이름과 표시를 같은 시연 지문에서 직접 대조한 기록입니다. 실제 법률 쟁점이 아닙니다.";
const excerptText = "시연 도형의 색깔과 모양을 차례로 살펴봅니다.";

/** Only the existing nonlegal demo fixtures are used; no actual exam payloads. */
function syntheticHandoff() {
  const questions = JSON.parse(
    readFileSync(fixture("questions.demo.json"), "utf8"),
  );
  const legacy = JSON.parse(readFileSync(fixture("valid.demo.json"), "utf8"));
  const byId = new Map<string, any>(
    questions.questions.map((question: any) => [question.id, question]),
  );
  const legacyVerifiedLinks = legacy.explanations
    .filter((record: any) => record.verification.status === "verified")
    .map((record: any) => {
      const { id, explanation: _explanation, ...fields } = record;
      const question = byId.get(record.questionId)!;
      return {
        ...fields,
        explanationId: id,
        sourceKey: [
          question.source.examCode,
          question.subjectId,
          question.source.year,
          question.source.round,
          question.source.questionNumber,
        ],
      };
    });
  const reviewed = legacyVerifiedLinks.filter((record: any) =>
    ["demo-explanation-1", "demo-explanation-2", "demo-explanation-4"].includes(
      record.explanationId,
    ),
  );
  return {
    format: "police-frequent-issues-handoff",
    schemaVersion: "1.0.0",
    dataKind: "demo",
    inputPackages: {
      questions: {
        packageId: questions.packageId,
        packageVersion: questions.packageVersion,
        schemaVersion: "1.0.0",
      },
      legacy: {
        packageId: legacy.packageId,
        packageVersion: legacy.packageVersion,
        schemaVersion: "1.0.0",
      },
      instructor: {
        packageId: "TEST_ONLY_unused_instructor",
        packageVersion: 1,
        schemaVersion: "1.0.0",
      },
    },
    questionIndex: questions.questions.slice(0, 2).map((question: any) => ({
      questionId: question.id,
      sourceKey: [
        question.source.examCode,
        question.subjectId,
        question.source.year,
        question.source.round,
        question.source.questionNumber,
      ],
      subjectId: question.subjectId,
      questionRevision: question.revision,
      gradingRevision: question.gradingRevision,
      questionFingerprint: legacyVerifiedLinks.find(
        (record: any) => record.questionId === question.id,
      ).questionFingerprint,
      eligible: true,
      classification: question.classification,
    })),
    legacyVerifiedLinks,
    legacyCatalog: {
      bases: legacy.bases.map(
        ({ originalText: _text, archivedAt: _archivedAt, ...basis }: any) =>
          basis,
      ),
      issues: legacy.issues.map(
        ({ excerpt: _excerpt, ...issue }: any) => issue,
      ),
    },
    authorityCatalog: [],
    sourceCitationOccurrences: [],
    reviewedLearningTopics: [
      {
        id: "TEST_ONLY_reviewed_shapes",
        title: topicTitle,
        subjectId: "constitution",
        basis: "context_review_of_existing_explanation_and_target",
        frequency: {
          questions: 2,
          rounds: 2,
          targets: 3,
          latest: "2026년 1차",
          questionIds: ["demo_const_1", "demo_const_2"],
        },
        links: reviewed.map((record: any) => ({
          ...record,
          evidenceLane: "legacy_verified",
          reviewedIssueIds: ["demo-issue-A1"],
          semanticReason: reviewedNote,
          instructorEvidence: [],
        })),
      },
    ],
  };
}

async function navigate(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  const menu = page.getByRole("button", { name: "메뉴", exact: true });
  if (!(await button.isVisible()) && (await menu.isVisible()))
    await menu.click();
  await button.click();
}

async function setup(page: Page) {
  await page.goto("/?view=original&mode=demo");
  await navigate(page, "데이터·설정");
  await page
    .getByLabel("문제 JSON 가져오기", { exact: true })
    .setInputFiles(fixture("questions.demo.json"));
  await page
    .getByRole("button", { name: "확인하고 적용", exact: true })
    .click();
  await expect(
    page.getByText("검증한 데이터를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByText("이전 형식 해설 관리·복구", { exact: true }).click();
  await page
    .getByLabel("해설 JSON 가져오기", { exact: true })
    .setInputFiles(fixture("valid.demo.json"));
  await page
    .getByRole("button", { name: "해설 확인하고 적용", exact: true })
    .click();
  await expect(
    page.getByText("검증한 해설 자료를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("쟁점 연결 JSON 가져오기", { exact: true })
    .setInputFiles({
      name: "TEST_ONLY_shapes.frequent-issues.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(syntheticHandoff())),
    });
  await expect(
    page.getByText("쟁점 연결 자료를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await navigate(page, "근거·출제 빈도");
  await expect(
    page.getByRole("heading", { name: "빈출 쟁점", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".frequent-topic-card")).toHaveCount(1);
}

async function stored(page: Page) {
  return page.evaluate(
    () =>
      new Promise<any>((resolveValue, reject) => {
        const request = indexedDB.open("police-ox-storage", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db
            .transaction("states")
            .objectStore("states")
            .get("original:demo");
          get.onsuccess = () => {
            resolveValue(get.result.state);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

test.use({ viewport: { width: 1280, height: 800 } });

test("단원·연도 범위의 쟁점 집계에서 읽기·원문 왕복·기존 풀이·오답 연습을 이어간다", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page);
  const beforeData = (await stored(page)).data;
  const card = page
    .locator(".frequent-topic-card")
    .filter({ hasText: topicTitle });
  expect(await card.locator("dd").allTextContents()).toEqual([
    "2문항",
    "2회",
    "3개",
    "0문항",
  ]);
  await page.getByLabel("과목", { exact: true }).selectOption("constitution");
  await page.getByLabel("기존 단원", { exact: true }).selectOption("CONST-04");
  await expect(
    page.getByText("이 범위의 연결이 없습니다", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("기존 단원", { exact: true }).selectOption("CONST-01");
  await page.getByLabel("연도", { exact: true }).selectOption("2026");
  await expect(card).toBeVisible();
  expect(await card.locator("dd").allTextContents()).toEqual([
    "1문항",
    "1회",
    "2개",
    "0문항",
  ]);
  await card.getByRole("button", { name: "읽기 자료", exact: true }).click();
  const detail = page.locator(".frequent-detail");
  await expect(
    detail.getByRole("heading", { name: topicTitle, exact: true }),
  ).toBeVisible();
  await expect(
    detail.locator(".frequent-excerpt blockquote").first(),
  ).toHaveText(excerptText);
  await expect(
    detail.getByText("정리 본문 미등록", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("별도 정리 미등록", { exact: true }),
  ).toBeVisible();
  await expect(detail.locator(".frequent-review-notes")).toContainText(
    reviewedNote,
  );
  await expect(detail.locator(".frequent-variants > li")).toHaveCount(2);

  const original = detail
    .locator(".frequent-variants")
    .getByRole("button", { name: "관련 원문 보기", exact: true })
    .last();
  await original.scrollIntoViewIfNeeded();
  const readingScroll = await page.evaluate(() => window.scrollY);
  expect(readingScroll).toBeGreaterThan(100);
  await original.click();
  await expect(
    page.getByRole("region", { name: "쟁점 관련 기출 원문", exact: true }),
  ).toBeVisible();
  const preview = page.getByRole("region", {
    name: "쟁점 관련 기출 원문",
    exact: true,
  });
  await expect(preview).toContainText(
    "정답·해설은 이 기출 풀이에서 답안을 제출한 뒤 확인할 수 있습니다.",
  );
  await expect(preview.getByText(/^(시연 정답|공식 최종 정답)/)).toHaveCount(0);
  await expect(
    preview.locator(".explanation-panel, .instructor-explanation-panel"),
  ).toHaveCount(0);
  await expect(
    page
      .getByText("이번 화면의 안내 도형: 파란 네모", { exact: false })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "빈출 쟁점으로 돌아가기", exact: true })
    .click();
  await expect(detail.locator(".frequent-reading")).toBeVisible();
  await expect(page.getByLabel("기존 단원", { exact: true })).toHaveValue(
    "CONST-01",
  );
  await expect(page.getByLabel("연도", { exact: true })).toHaveValue("2026");
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - readingScroll),
    )
    .toBeLessThan(10);

  await detail
    .getByRole("button", { name: "관련 기출 1문항 풀기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "1번 선택", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".explanation-panel")).toHaveCount(0);
  let state = await stored(page);
  expect(state.sessions.at(-1).mode).toBe("study");
  expect(
    state.sessions.at(-1).questions.map((question: any) => question.id),
  ).toEqual(["demo_const_1"]);
  await page.getByRole("button", { name: "1번 선택", exact: true }).click();
  await page.getByRole("button", { name: "답 제출", exact: true }).click();
  await expect.poll(async () => (await stored(page)).attempts.length).toBe(1);
  await page.getByRole("button", { name: "학습 종료", exact: true }).click();
  await page
    .getByRole("button", { name: "학습 종료 확정", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "학습 결과", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "빈출 쟁점으로 돌아가기", exact: true })
    .click();
  await expect(detail.locator(".frequent-reading")).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "오답만 1문항 풀기", exact: true }),
  ).toBeEnabled();
  expect(await card.locator("dd").allTextContents()).toEqual([
    "1문항",
    "1회",
    "2개",
    "1문항",
  ]);
  state = await stored(page);
  expect(state.attempts[0].result).toBe("incorrect");
  expect(state.data).toEqual(beforeData);
  await detail
    .getByRole("button", { name: "오답만 1문항 풀기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "2번 선택", exact: true }),
  ).toBeEnabled();
  state = await stored(page);
  expect(
    state.sessions.at(-1).questions.map((question: any) => question.id),
  ).toEqual(["demo_const_1"]);
  expect(state.attempts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("모의고사 중에는 선택해 둔 읽기·출처·원문 미리보기와 새 풀이를 숨긴다", async ({
  page,
}) => {
  await setup(page);
  await page
    .locator(".frequent-topic-card")
    .getByRole("button", { name: "읽기 자료", exact: true })
    .click();
  await expect(page.locator(".frequent-reading")).toContainText(excerptText);
  await navigate(page, "모의고사");
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(page.locator(".explanation-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await page.getByRole("button", { name: "학습 홈", exact: true }).click();
  await navigate(page, "근거·출제 빈도");
  await expect(
    page.getByText(
      "진행 중인 모의고사의 쟁점·근거·해설은 제출 뒤 확인할 수 있습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      ".frequent-reading, .frequent-topic-list, .frequent-sources, .frequent-practice-actions",
    ),
  ).toHaveCount(0);
  await expect(page.getByText(reviewedNote, { exact: true })).toHaveCount(0);
  await expect(page.getByText(excerptText, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "관련 원문 보기", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "진행 중 시험 이어 풀기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "시험 제출", exact: true }),
  ).toBeVisible();
});

test("태블릿 가로·세로에서 선택 범위와 읽기 자료가 가로로 넘치지 않는다", async ({
  page,
}, testInfo) => {
  await setup(page);
  await page.getByLabel("과목", { exact: true }).selectOption("constitution");
  await page.getByLabel("기존 단원", { exact: true }).selectOption("CONST-01");
  await page.getByLabel("연도", { exact: true }).selectOption("2026");
  await page
    .locator(".frequent-topic-card")
    .getByRole("button", { name: "읽기 자료", exact: true })
    .click();
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 800, height: 1100 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator(".frequent-reading")).toContainText(excerptText);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      await page
        .locator(".frequent-reading")
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await page.screenshot({
      path: testInfo.outputPath(
        `frequent-reading-${viewport.width}x${viewport.height}.png`,
      ),
      fullPage: true,
    });
  }
});
