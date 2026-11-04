import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OriginalPackage } from "../src/original/model";
import type { InstructorPackage } from "../src/original/instructor/contract";

const fixture = (name: string) => resolve("tests/fixtures/explanations", name);
const read = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8"));
// Padding is valid JSON whitespace: exercise the actual file-size boundary
// without checking a huge fixture or fabricated legal content into the repo.
const padded = (value: unknown, mebibytes: number) => ({
  name: "large-neutral-explanations.json",
  mimeType: "application/json",
  buffer: Buffer.concat([
    Buffer.from(JSON.stringify(value)),
    Buffer.alloc(mebibytes * 1024 * 1024 + 1, 32),
  ]),
});
async function setup(page: Page) {
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page
    .getByLabel("문제 JSON 가져오기", { exact: true })
    .setInputFiles(fixture("questions.demo.json"));
  await page
    .getByRole("button", { name: "확인하고 적용", exact: true })
    .click();
  await expect(
    page.getByText("검증한 데이터를 저장했습니다.", { exact: true }),
  ).toBeVisible();
}
async function questionState(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open("police-ox-storage");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("states", "readonly"),
            value = tx.objectStore("states").get("original:demo");
          tx.oncomplete = () => {
            db.close();
            resolve(JSON.stringify(value.result));
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}
async function exported(page: Page, label: string) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: label, exact: true }).click();
  return JSON.parse(readFileSync((await (await download).path())!, "utf8"));
}
function instructorFixture(): InstructorPackage {
  const source = read("questions.demo.json") as OriginalPackage,
    legacy = read("valid.demo.json"),
    q = source.questions[0],
    location = {
      page: 1,
      printedPage: null,
      bbox: null,
      coordinateSystem: null,
    },
    now = "2026-10-29T00:00:00Z";
  return {
    format: "police-instructor-explanations-intermediate",
    schemaVersion: "1.0.0",
    packageId: "large-instructor-neutral-demo",
    packageVersion: 1,
    exportedAt: now,
    dataKind: "demo",
    questionPackages: [],
    documents: [
      {
        documentId: "neutral-document",
        originalFileName: "neutral-demo.pdf",
        sha256: "a".repeat(64),
        byteSize: 1,
        pageCount: 1,
        relativePath: "neutral-demo.pdf",
        duplicatePaths: [],
        title: "중립 시연 원문",
        academy: null,
        instructor: null,
        edition: null,
        authoredDate: null,
        sourceUrl: null,
        rightsNotice: null,
        exam: {
          examCode: "demo",
          subjectId: q.subjectId,
          year: q.source.year,
          round: q.source.round,
        },
        metadataEvidence: [],
        status: "checked",
      },
    ],
    records: [
      {
        id: "neutral-record",
        revision: 1,
        documentId: "neutral-document",
        questionId: q.id,
        subjectId: q.subjectId,
        questionRevision: q.revision,
        gradingRevision: q.gradingRevision,
        questionFingerprint: legacy.explanations.find(
          (r: { questionId: string }) => r.questionId === q.id,
        ).questionFingerprint,
        sourceKey: {
          examCode: "demo",
          year: q.source.year,
          round: q.source.round,
          questionNumber: q.source.questionNumber,
        },
        scope: { kind: "question", targets: [] },
        blocks: [
          {
            type: "text",
            role: "explanation",
            text: "중립 도형 시연 해설입니다. 법률 판단 자료가 아닙니다.",
            locations: [location],
          },
        ],
        locations: [location],
        sourceSymbols: { answer: null, judgments: [] },
        officialAnswer: structuredClone(q.officialAnswer),
        extraction: {
          status: "checked",
          method: "neutral fixture",
          checkedAt: now,
          reasons: [],
          tool: "fixture",
        },
        matching: {
          status: "checked",
          method: "fixture fingerprint",
          checkedAt: now,
          reasons: [],
          evidence: {},
        },
        legalVerification: {
          status: "not_reviewed",
          reviewedAt: null,
          lawAsOf: null,
        },
        sourceQuestionText: null,
        notes: [],
      },
    ],
    assets: [],
    citationMentions: [],
    coverage: [],
    holds: [],
    reviews: [],
    compatibility: {},
    statistics: {},
  };
}

test("32 MiB 초과 강사 해설은 가져오고 큰 잘못된 파일은 기존 자료를 보존한다", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page);
  const before = await questionState(page),
    valid = instructorFixture(),
    input = page.getByLabel("강사 해설 JSON 가져오기", { exact: true });
  await input.setInputFiles(padded(valid, 32));
  await expect(page.getByLabel("강사 해설 가져오기 미리보기")).toBeVisible();
  await page
    .getByRole("button", { name: "기존 해설을 교체하고 가져오기", exact: true })
    .click();
  await expect(
    page.getByText(
      "강사 해설을 저장하고 이전 등록 해설을 교체했습니다. 문제·정답·학습 기록은 유지했습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  const saved = await exported(page, "강사 해설 내보내기");
  expect(saved).toEqual(valid);
  const invalid = structuredClone(valid);
  invalid.records[0].questionFingerprint = "f".repeat(64);
  await input.setInputFiles(padded(invalid, 32));
  await expect(page.getByText(/문제·정답·자산 내용 불일치/)).toBeVisible();
  await expect(page.getByLabel("강사 해설 가져오기 미리보기")).toHaveCount(0);
  expect(await exported(page, "강사 해설 내보내기")).toEqual(saved);
  expect(await questionState(page)).toBe(before);
});

test("20 MiB 초과 이전 형식 해설도 검증과 저장·실패 시 보존을 유지한다", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page);
  const before = await questionState(page),
    valid = read("valid.demo.json");
  await page.getByText("이전 형식 해설 관리·복구", { exact: true }).click();
  const input = page.getByLabel("해설 JSON 가져오기", { exact: true });
  await input.setInputFiles(padded(valid, 20));
  await page
    .getByRole("button", { name: "해설 확인하고 적용", exact: true })
    .click();
  await expect(
    page.getByText("검증한 해설 자료를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  const saved = await exported(page, "해설 자료 내보내기");
  expect(saved).toEqual(valid);
  await input.setInputFiles(padded(read("invalid-reference.demo.json"), 20));
  await expect(page.getByText(/잘못된 쟁점 참조/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "해설 확인하고 적용", exact: true }),
  ).toHaveCount(0);
  expect(await exported(page, "해설 자료 내보내기")).toEqual(saved);
  expect(await questionState(page)).toBe(before);
});
