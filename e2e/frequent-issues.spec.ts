import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  frequentContentSha256,
  frequentQuestionText,
} from "../src/original/frequent/contract";

const fixture = (name: string) => resolve("tests/fixtures/explanations", name);
const topicTitle = "시연 도형의 모양과 표시 비교";
const reviewedNote =
  "도형의 이름과 표시를 같은 시연 지문에서 직접 대조한 기록입니다. 실제 법률 쟁점이 아닙니다.";
const excerptText = "시연 도형의 색깔과 모양을 차례로 살펴봅니다.";

/** Only the existing nonlegal demo fixtures are used; no actual exam payloads. */
function syntheticHandoff(topicCount = 1) {
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
    // Extra nonlegal demo rows exercise scrolling/pagination only.
    reviewedLearningTopics: Array.from({ length: topicCount }, (_, index) => ({
      id: `TEST_ONLY_reviewed_shapes_${index}`,
      title:
        topicCount === 1 ? topicTitle : `${topicTitle} · 시연 ${index + 1}`,
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
    })),
  };
}

async function navigate(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  const menu = page.getByRole("button", { name: "메뉴", exact: true });
  if (!(await button.isVisible()) && (await menu.isVisible()))
    await menu.click();
  await button.click();
}

async function setup(
  page: Page,
  topicCount = 1,
  declaredLevels = false,
  wholeQuestion = false,
) {
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
  const legacyHandoff = syntheticHandoff(topicCount);
  const handoff = declaredLevels
    ? {
        ...legacyHandoff,
        schemaVersion: "1.1.0",
        handoffRevision: 1,
        canonicalLearningTopics: legacyHandoff.reviewedLearningTopics.map(
          (topic, index) => ({
            id: topic.id,
            title: topic.title,
            subjectId: topic.subjectId,
            aliases: [`도형별칭${index + 1}`],
            classificationLevel: (["topic", "issue", "subissue"] as const)[
              index % 3
            ],
            studyUnitCodes: [],
            links: [...topic.links],
          }),
        ),
      }
    : legacyHandoff;
  if (declaredLevels && wholeQuestion && "canonicalLearningTopics" in handoff) {
    const topic = handoff.canonicalLearningTopics[0];
    const binding = handoff.questionIndex.find(
      (entry: any) => entry.questionId === topic.links[0].questionId,
    )!;
    const source = JSON.parse(
      readFileSync(fixture("questions.demo.json"), "utf8"),
    );
    const question = source.questions.find(
      (entry: any) => entry.id === binding.questionId,
    );
    const expectedText = frequentQuestionText(question);
    topic.links.push({
      id: "TEST_ONLY_whole_question",
      questionId: binding.questionId,
      sourceKey: binding.sourceKey,
      subjectId: binding.subjectId,
      questionRevision: binding.questionRevision,
      gradingRevision: binding.gradingRevision,
      questionFingerprint: binding.questionFingerprint,
      selector: null,
      expectedText,
      evidenceLane: "semantic_reviewed",
      classificationStatus: "confirmed",
      semanticReason: "도형 문제 전체의 표시를 확인한 합성 의미 연결입니다.",
      legalVerificationStatus: "not_reviewed",
      evidence: [
        {
          kind: "question_text",
          sourceFileName: question.source.questionPdf?.fileName ?? null,
          sourceLocations: question.source.questionPdf
            ? question.source.questionPdf.pages.map((page: number) => ({
                page,
                printedPage: null,
                bbox: null,
                coordinateSystem: null,
              }))
            : [],
          contentSha256: await frequentContentSha256(expectedText),
        },
      ],
    });
  }
  await page
    .getByLabel("쟁점 연결 JSON 가져오기", { exact: true })
    .setInputFiles({
      name: "TEST_ONLY_shapes.frequent-issues.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(handoff)),
    });
  await expect(
    page.getByText("쟁점 연결 자료를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await navigate(page, "근거·출제 빈도");
  await expect(
    page.getByRole("heading", { name: "빈출 쟁점", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".frequent-topic-card")).toHaveCount(
    Math.min(topicCount, 24),
  );
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

test("이전 출처별 선택 상태를 단일 쟁점 목록으로 옮기고 필터를 보존한다", async ({
  page,
}) => {
  await page.goto("/?view=original&mode=demo");
  const migrated = await page.evaluate(async () => {
    const frequent = await new Function(
      "modulePath",
      "return import(modulePath)",
    )("/src/original/frequent/FrequentIssues.tsx");
    const initial = frequent.createFrequentViewState();
    return ["reviewed-topic", "legacy-issue", "legacy-basis", "authority"].map(
      (kind) => {
        const next = frequent.normalizeFrequentViewState({
          ...initial,
          kind,
          filter: {
            ...initial.filter,
            subjectId: "",
            unitId: "CONST-01",
            year: "2026",
          },
          selectedKey:
            kind === "reviewed-topic"
              ? "reviewed-topic:TEST_ONLY_shapes"
              : `${kind}:TEST_ONLY_shapes`,
          search: "시연",
          page: 3,
        });
        return { kind, next };
      },
    );
  });
  for (const { kind, next } of migrated) {
    expect(next).not.toHaveProperty("kind");
    expect(next.filter).toMatchObject({
      subjectId: "",
      unitId: "CONST-01",
      year: "2026",
    });
    expect(next.selectedKey).toBe(
      kind === "reviewed-topic" ? "reviewed-topic:TEST_ONLY_shapes" : "",
    );
    if (kind !== "reviewed-topic") {
      expect(next.search).toBe("");
      expect(next.page).toBe(0);
    }
  }
});

test("현재 과목이 없는 단일 과목 자료에서는 있는 과목을 선택하고 전체 과목 선택은 보존한다", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolveValue, reject) => {
        const request = indexedDB.open("police-ox-storage", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("states", "readwrite");
          const states = transaction.objectStore("states");
          const get = states.get("original:demo");
          get.onsuccess = () => {
            const envelope = get.result;
            envelope.state.data.questions =
              envelope.state.data.questions.filter(
                (question: { subjectId: string }) =>
                  question.subjectId === "criminal",
              );
            states.put(envelope, "original:demo");
          };
          transaction.oncomplete = () => {
            db.close();
            resolveValue();
          };
          transaction.onabort = () => reject(transaction.error);
        };
      }),
  );
  await page.reload();
  await navigate(page, "근거·출제 빈도");
  const subject = page.getByLabel("과목", { exact: true });
  await expect(subject).toHaveValue("criminal");
  await expect(subject.locator('option[value="constitution"]')).toHaveCount(0);
  await expect(page.getByLabel("기존 단원", { exact: true })).toHaveValue("");
  await expect(page.locator(".frequent-semantic-coverage")).toContainText(
    "의미 확인 0 / 40문항",
  );
  await subject.selectOption("");
  await page.getByLabel("연도", { exact: true }).selectOption("2026");
  await expect(subject).toHaveValue("");
});

test("문항 전체 의미 연결은 지문을 늘리지 않고 사람이 읽을 수 있는 안내를 표시한다", async ({
  page,
}) => {
  await setup(page, 1, true, true);
  const card = page.locator(".frequent-topic-card").first();
  await expect(card.locator("dd").first()).toHaveText("2문항");
  await card
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .click();
  const detail = page.locator(".frequent-detail");
  await expect(detail).toContainText("의미 확인 지문 3개");
  await expect(detail).toContainText("문항 전체 연결 1개");
  await detail
    .getByRole("button", { name: "관련 해설·출처", exact: true })
    .click();
  const whole = detail
    .locator(".frequent-variants > li")
    .filter({
      hasText: "도형 문제 전체의 표시를 확인한 합성 의미 연결입니다.",
    });
  await expect(whole).toContainText("문항 전체 연결입니다.");
  await expect(whole.locator("blockquote")).toHaveCount(0);
});

test("별칭으로 canonical 쟁점을 찾고 서로 다른 분류 수준의 순위를 구분한다", async ({
  page,
}) => {
  await setup(page, 3, true);
  const groups = page.locator(".frequent-level-group");
  await expect(groups).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(groups.nth(index).locator(".frequent-topic-card")).toHaveCount(
      1,
    );
    await expect(groups.nth(index).locator(".frequent-rank")).toHaveText("1");
  }
  await page.getByLabel("쟁점·별칭 검색", { exact: true }).fill("도형별칭2");
  await expect(page.locator(".frequent-topic-card")).toHaveCount(1);
  await expect(page.locator(".frequent-topic-card")).toContainText("시연 2");
  await expect(page.locator(".frequent-topic-card .frequent-rank")).toHaveText(
    "1",
  );
  await page.getByLabel("쟁점·별칭 검색", { exact: true }).fill("없는 별칭");
  await expect(
    page.getByText("검색한 제목이 없습니다", { exact: true }),
  ).toBeVisible();
});

test("24개 목록 끝에서 상세를 열어도 넓은 화면 목록을 유지하고 좁은 화면 위치를 복원한다", async ({
  page,
}, testInfo) => {
  await setup(page, 26);
  await page.getByLabel("기존 단원", { exact: true }).selectOption("CONST-01");
  const cards = page.locator(".frequent-topic-card");
  const finalCard = cards.nth(23);
  await finalCard
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .scrollIntoViewIfNeeded();
  const widePosition = await page.evaluate(() => window.scrollY);
  await finalCard
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .click();
  const detail = page.locator(".frequent-detail");
  await expect(finalCard).toBeVisible();
  await expect(detail).toBeVisible();
  const listBox = (await page.locator(".frequent-list-area").boundingBox())!;
  const detailBox = (await detail.boundingBox())!;
  expect(detailBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
  expect(
    Math.abs((await page.evaluate(() => window.scrollY)) - widePosition),
  ).toBeLessThan(10);
  await page.screenshot({
    path: testInfo.outputPath("frequent-unified-landscape.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 800, height: 1100 });
  await detail
    .getByRole("button", { name: "← 쟁점 목록으로 돌아가기", exact: true })
    .click();
  await finalCard
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .scrollIntoViewIfNeeded();
  const narrowPosition = await page.evaluate(() => window.scrollY);
  expect(narrowPosition).toBeGreaterThan(100);
  await finalCard
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .click();
  await expect(page.locator(".frequent-list-area")).not.toBeVisible();
  await expect(detail).toBeVisible();
  await expect(detail.locator("h2")).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("frequent-unified-portrait.png"),
    fullPage: true,
  });
  await detail
    .getByRole("button", { name: "← 쟁점 목록으로 돌아가기", exact: true })
    .click();
  await expect(page.getByLabel("기존 단원", { exact: true })).toHaveValue(
    "CONST-01",
  );
  await expect(finalCard).toBeInViewport();
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - narrowPosition),
    )
    .toBeLessThan(10);
  await page
    .getByRole("navigation", { name: "쟁점 목록 페이지", exact: true })
    .getByRole("button", { name: "다음", exact: true })
    .click();
  await expect(cards).toHaveCount(2);
  await cards
    .last()
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "← 쟁점 목록으로 돌아가기", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "쟁점 목록 페이지", exact: true }),
  ).toContainText("2 / 2");
});

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
    "0문항",
    "2문항",
  ]);
  await expect(page.getByLabel("과목", { exact: true })).toHaveValue(
    "constitution",
  );
  await expect(page.locator(".frequent-semantic-coverage")).toContainText(
    "의미 확인 2 / 20문항",
  );
  await expect(page.locator(".frequent-data-details")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator(".frequent-coverage")).not.toBeVisible();
  await expect(
    page.getByRole("group", { name: "연결 기준 선택", exact: true }),
  ).toHaveCount(0);
  for (const name of [
    "검토한 학습 쟁점",
    "원문 검증 쟁점",
    "원문 검증 근거",
    "강사 인용 출처",
  ])
    await expect(
      page.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toHaveCount(0);
  await page.getByLabel("과목", { exact: true }).selectOption("constitution");
  await page.getByLabel("기존 단원", { exact: true }).selectOption("CONST-04");
  await expect(
    page.getByText("이 범위의 의미 확인 쟁점이 없습니다", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("기존 단원", { exact: true }).selectOption("CONST-01");
  await page.getByLabel("연도", { exact: true }).selectOption("2026");
  await expect(card).toBeVisible();
  expect(await card.locator("dd").allTextContents()).toEqual([
    "1문항",
    "1회",
    "0문항",
    "1문항",
  ]);
  await card
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .click();
  const detail = page.locator(".frequent-detail");
  await detail
    .getByRole("button", { name: "관련 해설·출처", exact: true })
    .click();
  await expect(
    detail.getByRole("heading", { name: topicTitle, exact: true }),
  ).toBeVisible();
  await expect(
    detail.locator(".frequent-excerpt blockquote").first(),
  ).toHaveText(excerptText);
  await expect(
    detail.getByText("정리 본문 미등록", { exact: true }),
  ).toHaveCount(0);
  await expect(
    detail.getByText("별도 정리 미등록", { exact: true }),
  ).toHaveCount(0);
  await expect(detail.locator(".frequent-review-notes")).toContainText(
    reviewedNote,
  );
  const reviewRecord = detail.locator(".frequent-review-record");
  await expect(reviewRecord).not.toHaveAttribute("open", "");
  await reviewRecord.locator("summary").click();
  await expect(reviewRecord).toHaveAttribute("open", "");
  await expect(detail.locator(".frequent-variants > li")).toHaveCount(2);

  const original = detail
    .locator(".frequent-variants")
    .getByRole("button", { name: "관련 원문 보기", exact: true })
    .last();
  await original.scrollIntoViewIfNeeded();
  const readingScroll = await page.evaluate(() => window.scrollY);
  const readingPaneScroll = await detail.evaluate(
    (element) => element.scrollTop,
  );
  expect(readingScroll + readingPaneScroll).toBeGreaterThan(100);
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
  await expect(reviewRecord).toHaveAttribute("open", "");
  await expect(page.getByLabel("기존 단원", { exact: true })).toHaveValue(
    "CONST-01",
  );
  await expect(page.getByLabel("연도", { exact: true })).toHaveValue("2026");
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - readingScroll),
    )
    .toBeLessThan(10);
  await expect
    .poll(async () =>
      Math.abs(
        (await detail.evaluate((element) => element.scrollTop)) -
          readingPaneScroll,
      ),
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
  await expect(reviewRecord).toHaveAttribute("open", "");
  await expect(
    detail.getByRole("button", { name: "오답만 1문항 풀기", exact: true }),
  ).toBeEnabled();
  expect(await card.locator("dd").allTextContents()).toEqual([
    "1문항",
    "1회",
    "1문항",
    "0문항",
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
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .click();
  await page
    .locator(".frequent-detail")
    .getByRole("button", { name: "관련 해설·출처", exact: true })
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
    .getByRole("button", { name: "관련 기출 보기", exact: true })
    .click();
  await page
    .locator(".frequent-detail")
    .getByRole("button", { name: "관련 해설·출처", exact: true })
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
