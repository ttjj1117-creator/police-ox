import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, linkSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { OriginalPackage } from "../src/original/model";
import { validatePackage, isEligible } from "../src/original/validation";
import { questionFingerprint, targetText, validateExplanationPackage, type ExplanationPackage, type TargetSelector } from "../src/original/explanations/contract";
import { validateInstructorPackage, type InstructorPackage } from "../src/original/instructor/contract";
import {
  frequentContentSha256,
  frequentQuestionText,
  getFrequentLearningTopics,
  parseFrequentIssuesPackage,
  semanticFrequentLinkMismatch,
  validateFrequentIssuesPackage,
  type FrequentIssuesPackageV1,
  type FrequentIssuesPackageV11,
  type FrequentValidationContext,
  type SemanticFrequentLink,
} from "../src/original/frequent/contract";

/** Complete synthetic valid example: existing neutral shapes fixtures, never real examination data. */
async function fixture() {
  const load = (name: string) => JSON.parse(readFileSync(resolve("tests/fixtures/explanations", name), "utf8"));
  const source: OriginalPackage = await validatePackage(load("questions.demo.json"), "demo");
  const legacy: ExplanationPackage = await validateExplanationPackage(load("valid.demo.json"), "demo", source.questions, source.assets);
  const q = source.questions[0], selector = { kind: "choice", number: 1 } as const;
  const loc = { page: 1, printedPage: null, bbox: null, coordinateSystem: null };
  const now = "2026-01-01T00:00:00Z";
  const binding = {
    questionId: q.id, subjectId: q.subjectId, questionRevision: q.revision, gradingRevision: q.gradingRevision,
    questionFingerprint: await questionFingerprint(q, source.assets),
    sourceKey: [q.source.examCode, q.subjectId, q.source.year, q.source.round, q.source.questionNumber] as SemanticFrequentLink["sourceKey"],
  };
  const instructor: InstructorPackage = {
    format: "police-instructor-explanations-intermediate", schemaVersion: "1.0.0", packageId: "synthetic-instructor", packageVersion: 1,
    exportedAt: now, dataKind: "demo", questionPackages: [],
    documents: [{
      documentId: "doc", originalFileName: "synthetic.pdf", sha256: "a".repeat(64), byteSize: 10, pageCount: 1,
      relativePath: "synthetic.pdf", duplicatePaths: [], title: "Synthetic neutral explanation", academy: null, instructor: null,
      edition: null, authoredDate: null, sourceUrl: null, rightsNotice: null,
      exam: { examCode: "demo", subjectId: q.subjectId, year: q.source.year, round: q.source.round },
      metadataEvidence: [], status: "checked", sourceType: "instructor",
    }],
    records: [{
      ...binding, id: "record", revision: 1, documentId: "doc",
      sourceKey: { examCode: "demo", year: q.source.year, round: q.source.round, questionNumber: q.source.questionNumber },
      scope: { kind: "question", targets: [] },
      blocks: [{ type: "text", role: "explanation", text: "😀Unidentified reference; this paragraph explains the neutral blue shape.", locations: [loc] }],
      locations: [loc], sourceSymbols: { answer: null, judgments: [] }, officialAnswer: q.officialAnswer,
      extraction: { status: "checked", method: "Synthetic exact comparison", checkedAt: now, reasons: [], tool: null },
      matching: { status: "checked", method: "Synthetic question match", checkedAt: now, reasons: [], evidence: {} },
      legalVerification: { status: "not_reviewed", reviewedAt: null, lawAsOf: null }, sourceQuestionText: null, notes: [],
    }],
    assets: [], citationMentions: [], coverage: [], holds: [], reviews: [], compatibility: {}, statistics: {},
  };
  await validateInstructorPackage(instructor, "demo", source.questions, source.assets);
  const originalProof = { kind: "question_text" as const, sourceFileName: null, sourceLocations: [], contentSha256: await frequentContentSha256(targetText(q, selector)) };
  const semantic: SemanticFrequentLink = {
    ...binding, id: "semantic-target", selector, expectedText: targetText(q, selector),
    evidenceLane: "semantic_reviewed", classificationStatus: "confirmed", semanticReason: "Confirmed neutral shape meaning in the exact original target.",
    legalVerificationStatus: "not_reviewed", evidence: [originalProof],
  };
  const ref = (p: { packageId: string; packageVersion: number }) => ({ packageId: p.packageId, packageVersion: p.packageVersion, schemaVersion: "1.0.0" as const });
  const handoff: FrequentIssuesPackageV11 = {
    format: "police-frequent-issues-handoff", schemaVersion: "1.1.0", dataKind: "demo", handoffRevision: 1,
    inputPackages: { questions: ref(source), legacy: ref(legacy), instructor: ref(instructor) },
    questionIndex: await Promise.all(source.questions.map(async (question) => ({
      questionId: question.id, subjectId: question.subjectId, questionRevision: question.revision, gradingRevision: question.gradingRevision,
      questionFingerprint: await questionFingerprint(question, source.assets),
      sourceKey: [question.source.examCode, question.subjectId, question.source.year, question.source.round, question.source.questionNumber] as SemanticFrequentLink["sourceKey"],
      classification: question.classification, eligible: isEligible(question, "demo"),
    }))),
    legacyVerifiedLinks: [],
    legacyCatalog: {
      bases: legacy.bases.map(({ originalText: _text, archivedAt: _archived, ...b }) => b),
      issues: legacy.issues.map(({ excerpt: _excerpt, ...i }) => i),
    },
    authorityCatalog: [], sourceCitationOccurrences: [], reviewedLearningTopics: [],
    canonicalLearningTopics: [{ id: "stable-neutral-shape", title: "Neutral shape meaning", subjectId: q.subjectId, aliases: ["Blue shape"], classificationLevel: "issue", studyUnitCodes: [], links: [semantic] }],
  };
  const context: FrequentValidationContext = { namespace: "demo", questions: source.questions, assets: source.assets, questionPackages: [source], legacyPackages: [legacy], instructorPackages: [instructor] };
  return { source, legacy, instructor, handoff, context, q, semantic, binding, selector, loc };
}
const validate = (f: Awaited<ReturnType<typeof fixture>>) => validateFrequentIssuesPackage(f.handoff, f.context);
const semanticLink = (f: Awaited<ReturnType<typeof fixture>>) => f.handoff.canonicalLearningTopics[0].links[0] as SemanticFrequentLink;

describe("frequent contract 1.1.0", () => {
  it("validates citation-free original meaning without a PDF and preserves not_reviewed", async () => {
    const f = await fixture(), p = await validate(f);
    expect(p.schemaVersion).toBe("1.1.0");
    expect(semanticLink(f).citationIds).toBeUndefined();
    expect(semanticLink(f).legalVerificationStatus).toBe("not_reviewed");
    expect(f.q.source.questionPdf).toBeNull();
    expect(getFrequentLearningTopics(p)[0].aliases).toEqual(["Blue shape"]);
  });
  it("validates a matched instructor paragraph without any citation", async () => {
    const f = await fixture(), block = f.instructor.records[0].blocks[0];
    if (block.type !== "text") throw Error("fixture");
    semanticLink(f).evidence = [{ kind: "instructor_block", recordId: "record", recordRevision: 1, documentId: "doc", documentSha256: "a".repeat(64), sourceType: "instructor", blockIndex: 0, expectedText: block.text, contentSha256: await frequentContentSha256(block.text), sourceLocations: [f.loc] }];
    expect(await validate(f)).toBeDefined();
  });
  it("accepts unresolved citation metadata independently from confirmed meaning", async () => {
    const f = await fixture();
    f.handoff.sourceCitationOccurrences = [{
      ...f.binding, citationId: "unresolved", recordId: "record", recordRevision: 1, documentId: "doc", documentSha256: "a".repeat(64),
      sourceType: "instructor", scopeKind: "question", recordScopeTargets: [], blockIndex: 0,
      characterOffsets: { start: 1, end: 13, unit: "unicode-code-points", endExclusive: true }, rawCitation: "Unidentified",
      sourceLocations: [f.loc], locationPrecision: "block", sourceIdentificationStatus: "unresolved", sourceUnresolvedReasons: ["Synthetic identity unavailable"],
      disposition: "identity_hold", reason: "Keep unidentifiable source metadata", authorityId: null, legalVerificationStatus: "not_reviewed", supersededBy: null, supersedesForAnalysis: [],
    }];
    semanticLink(f).citationIds = ["unresolved"];
    expect(await validate(f)).toBeDefined();
    expect(semanticLink(f).classificationStatus).toBe("confirmed");
  });
  it("supports exact whole-question meaning and multiple canonical issues on one question", async () => {
    const f = await fixture(), whole = structuredClone(f.semantic);
    whole.id = "semantic-whole"; whole.selector = null; whole.expectedText = frequentQuestionText(f.q);
    whole.evidence = [{ kind: "question_text", sourceFileName: null, sourceLocations: [], contentSha256: await frequentContentSha256(whole.expectedText) }];
    f.handoff.canonicalLearningTopics.push({ id: "stable-whole", title: "Whole neutral meaning", subjectId: f.q.subjectId, aliases: [], classificationLevel: "topic", studyUnitCodes: [], links: [whole] });
    expect(getFrequentLearningTopics(await validate(f))).toHaveLength(2);
    expect(whole.selector).toBeNull();
  });
  it.each<TargetSelector>([
    { kind: "block", area: "body", choiceNumber: null, blockIndex: 0 },
    { kind: "entry", area: "body", choiceNumber: null, blockIndex: 1, entryIndex: 0, label: "㉠" },
  ])("supports exact structured target selectors %j", async (selector) => {
    const f = await fixture(), link = semanticLink(f);
    link.selector = selector; link.expectedText = targetText(f.q, selector);
    link.evidence = [{ kind: "question_text", sourceFileName: null, sourceLocations: [], contentSha256: await frequentContentSha256(link.expectedText) }];
    expect(await validate(f)).toBeDefined();
  });
  it("allows multiple independent evidence sources without inventing extra links", async () => {
    const f = await fixture(), block = f.instructor.records[0].blocks[0];
    if (block.type !== "text") throw Error("fixture");
    semanticLink(f).evidence.push({ kind: "instructor_block", recordId: "record", recordRevision: 1, documentId: "doc", documentSha256: "a".repeat(64), sourceType: "instructor", blockIndex: 0, expectedText: block.text, contentSha256: await frequentContentSha256(block.text), sourceLocations: [f.loc] });
    expect((getFrequentLearningTopics(await validate(f))[0].links[0] as SemanticFrequentLink).evidence).toHaveLength(2);
    expect(getFrequentLearningTopics(await validate(f))[0].links).toHaveLength(1);
  });
  it("preserves pending/hold without evidence and rejects confirmed without proof", async () => {
    const f = await fixture(), link = semanticLink(f);
    link.evidence = []; link.classificationStatus = "hold";
    expect(await validate(f)).toBeDefined();
    link.classificationStatus = "pending";
    expect(await validate(f)).toBeDefined();
    link.classificationStatus = "confirmed";
    expect(() => parseFrequentIssuesPackage(f.handoff)).toThrow(/근거/);
  });
  it.each([
    ["wrong target", (f: Awaited<ReturnType<typeof fixture>>) => { semanticLink(f).expectedText += " changed"; }, /expectedText/],
    ["wrong selector", (f: Awaited<ReturnType<typeof fixture>>) => { semanticLink(f).selector = { kind: "block", area: "body", choiceNumber: null, blockIndex: 99 }; }, /selector/],
    ["wrong fingerprint", (f: Awaited<ReturnType<typeof fixture>>) => { semanticLink(f).questionFingerprint = "0".repeat(64); }, /문항 인덱스/],
    ["wrong hash", (f: Awaited<ReturnType<typeof fixture>>) => { semanticLink(f).evidence[0].contentSha256 = "0".repeat(64); }, /해시/],
    ["invented PDF", (f: Awaited<ReturnType<typeof fixture>>) => { const proof = semanticLink(f).evidence[0]; if (proof.kind === "question_text") proof.sourceFileName = "invented.pdf"; }, /PDF/],
  ] as const)("rejects %s", async (_title, mutate, expected) => {
    const f = await fixture(); mutate(f);
    await expect(validate(f)).rejects.toThrow(expected);
  });
  it("rejects whole-question meaning backed only by a target-scoped instructor record", async () => {
    const f = await fixture(), link = semanticLink(f), block = f.instructor.records[0].blocks[0];
    if (block.type !== "text") throw Error("fixture");
    f.instructor.records[0].scope = { kind: "targets", targets: [{ selector: f.selector, expectedText: link.expectedText }] };
    link.selector = null; link.expectedText = frequentQuestionText(f.q);
    link.evidence = [{ kind: "instructor_block", recordId: "record", recordRevision: 1, documentId: "doc", documentSha256: "a".repeat(64), sourceType: "instructor", blockIndex: 0, expectedText: block.text, contentSha256: await frequentContentSha256(block.text), sourceLocations: [f.loc] }];
    await expect(validate(f)).rejects.toThrow(/범위/);
  });
  it("rejects changed instructor text, revision, document, matching status or location", async () => {
    const f = await fixture(), link = semanticLink(f), block = f.instructor.records[0].blocks[0];
    if (block.type !== "text") throw Error("fixture");
    const proof = { kind: "instructor_block" as const, recordId: "record", recordRevision: 1, documentId: "doc", documentSha256: "a".repeat(64), sourceType: "instructor" as const, blockIndex: 0, expectedText: block.text, contentSha256: await frequentContentSha256(block.text), sourceLocations: [f.loc] };
    link.evidence = [proof];
    for (const mutate of [
      () => { proof.expectedText += "wrong"; },
      () => { proof.recordRevision = 2; },
      () => { proof.documentSha256 = "b".repeat(64); },
      () => { proof.sourceLocations = [{ ...f.loc, page: 2 }]; },
    ]) {
      const before = structuredClone(proof); mutate();
      expect(await semanticFrequentLinkMismatch(link, f.q, f.source.assets, [f.instructor])).toBeTruthy();
      Object.assign(proof, before);
    }
    f.instructor.records[0].matching.status = "hold";
    await expect(validate(f)).rejects.toThrow(/미확인/);
  });
  it("rejects namespace mixing, missing source refs and legal status promotion", async () => {
    const f = await fixture();
    await expect(validateFrequentIssuesPackage(f.handoff, { ...f.context, namespace: "real" })).rejects.toThrow(/영역/);
    await expect(validateFrequentIssuesPackage(f.handoff, { ...f.context, instructorPackages: [] })).rejects.toThrow(/inputPackages.instructor/);
    expect(() => parseFrequentIssuesPackage({ ...f.handoff, canonicalLearningTopics: [{ ...f.handoff.canonicalLearningTopics[0], links: [{ ...f.semantic, legalVerificationStatus: "verified" }] }] })).toThrow();
  });
  it("rejects changed legacy catalog content and verification metadata", async () => {
    const f = await fixture(), basis = f.handoff.legacyCatalog.bases[0], issue = f.handoff.legacyCatalog.issues[0];
    const before = basis.title; basis.title += " invented";
    await expect(validate(f)).rejects.toThrow(/legacyCatalog.bases.0.*실제 기존 근거/);
    basis.title = before; issue.verification = { ...issue.verification, status: "draft" };
    await expect(validate(f)).rejects.toThrow(/legacyCatalog.issues.0.*검증 상태/);
  });
  it("accepts identical source records repeated across packages", async () => {
    const f = await fixture(), legacyCopy = structuredClone(f.legacy), instructorCopy = structuredClone(f.instructor);
    legacyCopy.packageId = "additional-legacy-same-records";
    instructorCopy.packageId = "additional-instructor-same-records";
    f.context.legacyPackages.push(legacyCopy); f.context.instructorPackages.push(instructorCopy);
    expect(await validate(f)).toBeDefined();
  });
  it.each(["basis", "issue", "explanation", "record", "document"] as const)("rejects conflicting %s IDs across source packages", async (kind) => {
    const f = await fixture();
    if (kind === "basis" || kind === "issue" || kind === "explanation") {
      const other = structuredClone(f.legacy); other.packageId = "additional-conflicting-legacy";
      if (kind === "basis") other.bases[0].title += " changed";
      if (kind === "issue") other.issues[0].title += " changed";
      if (kind === "explanation") other.explanations[0].explanation += " changed";
      f.context.legacyPackages.push(other);
    } else {
      const other = structuredClone(f.instructor); other.packageId = "additional-conflicting-instructor";
      if (kind === "record") other.records[0].notes.push("Different source record content");
      if (kind === "document") other.documents[0].title = "Different source document metadata";
      f.context.instructorPackages.push(other);
    }
    await expect(validate(f)).rejects.toThrow(/원천 패키지 사이의 동일 ID 내용 충돌/);
  });
  it("retains strict v1.0 reader and stable IDs while distinguishing unknown old level", async () => {
    const f = await fixture(), e = f.legacy.explanations[0];
    const { id, explanation: _text, ...oldFields } = e;
    const legacyLink = { ...oldFields, explanationId: id, sourceKey: f.binding.sourceKey };
    const oldTopic = { id: "old-stable-id", title: "Old reviewed neutral meaning", subjectId: f.q.subjectId, basis: "context_review_of_existing_explanation_and_target" as const, frequency: { questions: 1, rounds: 1, targets: 1, latest: "2026", questionIds: [f.q.id] }, links: [{ ...legacyLink, evidenceLane: "legacy_verified" as const, reviewedIssueIds: e.references[0].issueIds, semanticReason: "Existing exact meaning review.", instructorEvidence: [] }] };
    const { handoffRevision: _revision, canonicalLearningTopics: _topics, ...common } = f.handoff;
    const v1: FrequentIssuesPackageV1 = { ...common, schemaVersion: "1.0.0", legacyVerifiedLinks: [legacyLink], reviewedLearningTopics: [oldTopic] };
    expect(getFrequentLearningTopics(parseFrequentIssuesPackage(v1))[0].classificationLevel).toBe("unspecified");
    expect(() => parseFrequentIssuesPackage({ ...v1, canonicalLearningTopics: [] })).toThrow();
    f.handoff.legacyVerifiedLinks = [legacyLink]; f.handoff.reviewedLearningTopics = [oldTopic];
    expect(() => parseFrequentIssuesPackage(f.handoff)).toThrow(/old-stable-id/);
    f.handoff.canonicalLearningTopics.push({ id: oldTopic.id, title: oldTopic.title, subjectId: oldTopic.subjectId, aliases: [], classificationLevel: "subissue", studyUnitCodes: [], links: oldTopic.links });
    expect(await validate(f)).toBeDefined();
  });
});

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup path");
    rmSync(dir, { recursive: true, force: true });
  }
});
describe("frequent validation CLI", () => {
  async function cliFixture() {
    const f = await fixture(), dir = mkdtempSync(join(tmpdir(), "frequent-contract-")); temporary.push(dir);
    const paths = { connections: join(dir, "connections.json"), questions: join(dir, "questions.json"), legacy: join(dir, "legacy.json"), instructor: join(dir, "instructor.json") };
    for (const [key, value] of Object.entries({ connections: f.handoff, questions: f.source, legacy: f.legacy, instructor: f.instructor })) writeFileSync(paths[key as keyof typeof paths], JSON.stringify(value));
    const args = Object.entries(paths).flatMap(([key, path]) => [`--${key}`, path]);
    return { f, dir, paths, args };
  }
  function run(args: string[]) {
    return execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/validate-frequent-issues.ts"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  it("checks complete synthetic sources and emits a useful failure path", async () => {
    const { f, dir, paths, args } = await cliFixture(), report = join(dir, "report.json");
    expect(JSON.parse(run([...args, "--report", report])).valid).toBe(true);
    semanticLink(f).expectedText += "wrong"; writeFileSync(paths.connections, JSON.stringify(f.handoff));
    expect(() => run([...args, "--report", report])).toThrow();
    expect(JSON.parse(readFileSync(report, "utf8")).error).toMatch(/canonicalLearningTopics.0.links.0.*expectedText/);
    expect(() => run(["--connections", paths.connections])).toThrow();
  }, 15000);
  it("refuses report paths and hardlink aliases that overwrite source inputs", async () => {
    const { dir, paths, args } = await cliFixture(), before = readFileSync(paths.connections, "utf8"), alias = join(dir, "alias.json");
    expect(() => run([...args, "--report", paths.connections])).toThrow();
    expect(readFileSync(paths.connections, "utf8")).toBe(before);
    linkSync(paths.connections, alias);
    expect(() => run([...args, "--report", alias])).toThrow();
    expect(readFileSync(paths.connections, "utf8")).toBe(before);
  }, 15000);
});
