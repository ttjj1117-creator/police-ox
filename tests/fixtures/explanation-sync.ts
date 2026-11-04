import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OriginalPackage } from "../../src/original/model";
import {
  questionFingerprint,
  targetText,
  type ExplanationPackage,
} from "../../src/original/explanations/contract";
import type { InstructorPackage } from "../../src/original/instructor/contract";
import { expectedQuestionId, subjectLabels } from "../../src/original/validation";

/** Synthetic shape/color questions only. Never imports a learner's records. */
export async function explanationSyncFixture() {
  const source: OriginalPackage = JSON.parse(
    readFileSync(resolve("tests/fixtures/explanations/questions.demo.json"), "utf8"),
  );
  const oldIds = source.questions.map((q) => q.id);
  source.dataKind = "real";
  source.packageId = "TEST_ONLY_explanation_sync_questions";
  for (const q of source.questions) {
    q.source.examCode = "po";
    q.id = expectedQuestionId(q);
    q.source.examName = "TEST_ONLY 중립 도형 자료";
    q.source.questionPdf = { fileName: "TEST_ONLY_question.pdf", pages: [1] };
    q.source.answerPdf = {
      fileName: "TEST_ONLY_answer.pdf",
      pages: [1],
      subjectColumn: subjectLabels[q.subjectId],
    };
    q.officialAnswer.status = "final";
  }
  const legacy: ExplanationPackage = JSON.parse(
    readFileSync(resolve("tests/fixtures/explanations/valid.demo.json"), "utf8"),
  );
  legacy.dataKind = "real";
  legacy.packageId = "TEST_ONLY_legacy_explanations";
  for (const basis of legacy.bases) basis.type = "theory";
  legacy.scope.questionIds = legacy.scope.questionIds.map(
    (id) => source.questions[oldIds.indexOf(id)].id,
  );
  for (const e of legacy.explanations) {
    const q = source.questions[oldIds.indexOf(e.questionId)];
    e.questionId = q.id;
    e.questionFingerprint = await questionFingerprint(q, source.assets);
  }
  const q = source.questions[0], now = "2026-11-04T00:00:00Z";
  const location = {
    page: 1,
    printedPage: "1",
    bbox: null,
    coordinateSystem: null,
  };
  const instructor: InstructorPackage = {
    format: "police-instructor-explanations-intermediate",
    schemaVersion: "1.0.0",
    packageId: "TEST_ONLY_instructor_explanations",
    packageVersion: 1,
    exportedAt: now,
    dataKind: "real",
    questionPackages: [],
    documents: [{
      documentId: "TEST_ONLY_document",
      originalFileName: "TEST_ONLY.pdf",
      sha256: "a".repeat(64),
      byteSize: 123,
      pageCount: 1,
      relativePath: "TEST_ONLY.pdf",
      duplicatePaths: [],
      title: "TEST_ONLY 중립 도형 해설",
      academy: null,
      instructor: "TEST_ONLY",
      edition: null,
      authoredDate: null,
      sourceUrl: null,
      rightsNotice: null,
      exam: {
        examCode: "po",
        subjectId: q.subjectId,
        year: q.source.year,
        round: q.source.round,
        booklet: null,
      },
      metadataEvidence: [],
      status: "checked",
      sourceType: "instructor",
    }],
    records: [{
      id: "TEST_ONLY_record",
      revision: 1,
      documentId: "TEST_ONLY_document",
      questionId: q.id,
      subjectId: q.subjectId,
      questionRevision: q.revision,
      gradingRevision: q.gradingRevision,
      questionFingerprint: await questionFingerprint(q, source.assets),
      sourceKey: {
        examCode: "po",
        year: q.source.year,
        round: q.source.round,
        questionNumber: q.source.questionNumber,
        booklet: null,
      },
      scope: {
        kind: "targets",
        targets: [{ selector: { kind: "choice", number: 1 }, expectedText: targetText(q, { kind: "choice", number: 1 }) }],
      },
      blocks: [{ type: "text", role: "explanation", text: "TEST_ONLY 빨강 도형의 해설입니다.", locations: [location] }],
      locations: [location],
      sourceSymbols: { answer: null, judgments: [] },
      officialAnswer: structuredClone(q.officialAnswer),
      extraction: { status: "checked", method: "TEST_ONLY fixture", checkedAt: now, tool: "fixture", reasons: [] },
      matching: { status: "checked", method: "TEST_ONLY exact match", checkedAt: now, evidence: {}, reasons: [] },
      legalVerification: { status: "not_reviewed", reviewedAt: null, lawAsOf: null },
      sourceQuestionText: null,
      notes: [],
    }],
    assets: [],
    citationMentions: [],
    coverage: [],
    holds: [],
    reviews: [],
    compatibility: {},
    statistics: {},
  };
  return { source, legacy, instructor };
}
