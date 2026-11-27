import { describe, expect, it } from "vitest";
import type { Question } from "../src/original/model";
import type { InstructorPackage } from "../src/original/instructor/contract";
import {
  questionFingerprint,
  targetText,
  type ExplanationPackage,
} from "../src/original/explanations/contract";
import {
  parseFrequentIssuesPackage,
  frequentQuestionText,
  type FrequentIssuesPackage,
  type FrequentLegacyLink,
  type SemanticFrequentLink,
} from "../src/original/frequent/contract";
import {
  analyzeFrequentIssues,
  analyzeUnifiedFrequentIssues,
  buildFrequentIssuesIndex,
  emptyFrequentFilter,
  getFrequentIssuesIndex,
  matchesFrequentUnit,
} from "../src/original/frequent/analysis";
import { bookNodes, units } from "../src/original/validation";

const verification = {
  status: "verified" as const,
  checkedAt: "2026-01-01T00:00:00Z",
  checkedBy: "fixture",
  note: "Synthetic source review for tests.",
};
const selector = { kind: "choice" as const, number: 1 };
function question(number = 1, round = "1"): Question {
  return {
    id: `q${number}`,
    revision: 1,
    gradingRevision: 1,
    subjectId: "police",
    source: {
      examCode: "demo",
      year: 2026,
      round,
      examName: "Synthetic",
      questionNumber: number,
      questionPdf: null,
      answerPdf: null,
    },
    body: [{ type: "text", text: "Synthetic question" }],
    choices: [1, 2, 3, 4].map((n) => ({
      number: n,
      blocks: [{ type: "text" as const, text: `Target ${n}` }],
    })),
    officialAnswer: { status: "demo", kind: "single", acceptedChoices: [1] },
    classification: {
      studyUnitCode: null,
      relatedStudyUnitCodes: [],
      studyStatus: "pending",
      bookUnitIds: [],
      blueprintAreaCode: null,
      blueprintStatus: "pending",
    },
    qa: { textStatus: "checked", answerStatus: "checked", notes: [] },
    lifecycle: "active",
  };
}
async function fixture() {
  const qs = [question(1), question(2, "2")];
  const bindings = await Promise.all(
    qs.map(async (q) => ({
      questionId: q.id,
      subjectId: q.subjectId,
      questionRevision: q.revision,
      gradingRevision: q.gradingRevision,
      questionFingerprint: await questionFingerprint(q),
      sourceKey: [
        q.source.examCode,
        q.subjectId,
        q.source.year,
        q.source.round,
        q.source.questionNumber,
      ] as FrequentLegacyLink["sourceKey"],
    })),
  );
  const ref = {
    packageId: "synthetic",
    packageVersion: 1,
    schemaVersion: "1.0.0" as const,
  };
  const legacyLinks: FrequentLegacyLink[] = bindings.map((b, index) => ({
    ...b,
    explanationId: `ex${index}`,
    revision: 1,
    selector,
    expectedText: "Target 1",
    references: [{ basisId: "basis1", issueIds: ["issue1", "issue2"] }],
    verification: { ...verification },
  }));
  const location = {
    page: 1,
    printedPage: null,
    bbox: null,
    coordinateSystem: null,
  };
  const check = {
    status: "checked" as const,
    method: "Synthetic",
    checkedAt: "2026-01-01T00:00:00Z",
    reasons: [],
  };
  const handoff: FrequentIssuesPackage = {
    format: "police-frequent-issues-handoff",
    schemaVersion: "1.0.0",
    dataKind: "demo",
    inputPackages: {
      questions: ref,
      legacy: { ...ref, packageId: "legacy" },
      instructor: { ...ref, packageId: "instructor" },
    },
    questionIndex: bindings.map((b) => ({
      ...b,
      eligible: true,
      classification: null,
    })),
    legacyCatalog: {
      bases: [
        {
          id: "basis1",
          revision: 1,
          type: "demo",
          title: "One authority, two issues",
          identity: { authority: "Synthetic", number: null, date: null },
          sourceUrl: "https://example.com/source",
          temporalBasis: "current",
          asOfDate: "2026-01-01",
          verification,
        },
      ],
      issues: ["issue1", "issue2"].map((id) => ({
        id,
        revision: 1,
        basisId: "basis1",
        title: id,
        locator: "Synthetic paragraph",
        verification,
      })),
    },
    legacyVerifiedLinks: legacyLinks,
    authorityCatalog: [
      {
        id: "authority1",
        kind: "case",
        court: "Synthetic",
        caseNumber: "2026A1",
        catalogBasisCandidates: ["basis1"],
      },
    ],
    sourceCitationOccurrences: [
      {
        ...bindings[0],
        citationId: "cite1",
        recordId: "record1",
        recordRevision: 1,
        documentId: "document1",
        documentSha256: "a".repeat(64),
        sourceType: "instructor",
        scopeKind: "targets",
        recordScopeTargets: [{ selector, expectedText: "Target 1" }],
        blockIndex: 0,
        characterOffsets: {
          start: 1,
          end: 5,
          unit: "unicode-code-points",
          endExclusive: true,
        },
        rawCitation: "case",
        sourceLocations: [location],
        locationPrecision: "block",
        sourceIdentificationStatus: "identifiable",
        sourceUnresolvedReasons: [],
        disposition: "source_linked",
        reason: "synthetic",
        authorityId: "authority1",
        legalVerificationStatus: "not_reviewed",
        supersededBy: null,
        supersedesForAnalysis: [],
      },
    ],
    reviewedLearningTopics: [
      {
        id: "topic1",
        title: "A reviewed issue across authorities",
        subjectId: "police",
        basis: "context_review_of_existing_explanation_and_target",
        frequency: {
          questions: 1,
          targets: 1,
          rounds: 1,
          latest: "2026년 1차",
          questionIds: [qs[0].id],
        },
        links: [
          {
            ...legacyLinks[0],
            evidenceLane: "legacy_verified",
            reviewedIssueIds: ["issue1"],
            semanticReason: "Only issue 1 was reviewed for this topic.",
            instructorEvidence: [],
          },
        ],
      },
      {
        id: "topic2",
        title: "Instructor context reviewed",
        subjectId: "police",
        basis: "context_review_of_existing_explanation_and_target",
        frequency: {
          questions: 1,
          targets: 1,
          rounds: 1,
          latest: "2026년 1차",
          questionIds: [qs[0].id],
        },
        links: [
          {
            ...bindings[0],
            selector,
            expectedText: "Target 1",
            sourceCitationId: "cite1",
            evidenceLane: "instructor_context_reviewed",
            legalVerificationStatus: "not_reviewed",
            reviewedIssueIds: [],
            semanticReason: "Curated connection reason.",
            instructorEvidence: [
              {
                recordId: "record1",
                blockIndex: 0,
                citationIds: ["cite1"],
                reason: "Synthetic paragraph reviewed",
                documentId: "document1",
                sourceType: "instructor",
                sourceLocations: [location],
                legalVerificationStatus: "not_reviewed",
              },
            ],
          },
        ],
      },
    ],
  };
  const instructor = {
    format: "police-instructor-explanations",
    schemaVersion: "1.0.0",
    packageId: "instructor",
    packageVersion: 1,
    exportedAt: "2026-01-01T00:00:00Z",
    dataKind: "demo",
    producer: "fixture",
    notes: [],
    assets: [],
    citationMentions: [],
    unresolvedCitations: [],
    reviews: [],
    documents: [
      {
        documentId: "document1",
        originalFileName: "synthetic.pdf",
        sha256: "a".repeat(64),
        byteSize: 100,
        pageCount: 1,
        relativePath: "synthetic.pdf",
        duplicatePaths: [],
        title: "Synthetic instructor",
        academy: null,
        instructor: null,
        edition: null,
        authoredDate: null,
        sourceUrl: null,
        rightsNotice: null,
        exam: { examCode: "demo", subjectId: "police", year: 2026, round: "1" },
        metadataEvidence: [],
        status: "checked",
        sourceType: "instructor",
      },
    ],
    records: [
      {
        id: "record1",
        revision: 1,
        documentId: "document1",
        ...bindings[0],
        sourceKey: {
          examCode: "demo",
          year: 2026,
          round: "1",
          questionNumber: 1,
        },
        scope: {
          kind: "targets",
          targets: [{ selector, expectedText: "Target 1" }],
        },
        blocks: [
          {
            type: "text",
            role: "explanation",
            text: "😀case context",
            locations: [location],
          },
        ],
        locations: [location],
        sourceSymbols: { answer: null, judgments: [] },
        officialAnswer: qs[0].officialAnswer,
        extraction: { ...check, tool: null },
        matching: { ...check, evidence: {} },
        legalVerification: {
          status: "not_reviewed",
          reviewedAt: null,
          lawAsOf: null,
        },
        sourceQuestionText: null,
        notes: [],
      },
    ],
    coverage: [],
  } as unknown as InstructorPackage;
  const legacy = {
    format: "police-original-explanations",
    schemaVersion: "1.0.0",
    packageId: "legacy",
    packageVersion: 1,
    dataKind: "demo",
    exportedAt: "2026-01-01T00:00:00Z",
    producer: "fixture",
    notes: [],
    scope: { subjectIds: ["police"], questionIds: qs.map((q) => q.id) },
    bases: handoff.legacyCatalog.bases.map((b) => ({
      ...b,
      verification: { ...b.verification },
      originalText: "Synthetic authority",
      archivedAt: null,
    })),
    issues: handoff.legacyCatalog.issues.map((i) => ({
      ...i,
      verification: { ...i.verification },
      excerpt: `Verified ${i.id} only`,
    })),
    explanations: legacyLinks.map(
      ({ explanationId, sourceKey: _key, ...e }) => ({
        ...e,
        verification: { ...e.verification },
        id: explanationId,
        explanation: "Existing explanation",
      }),
    ),
  } as ExplanationPackage;
  return { qs, handoff, instructor, legacy };
}
const inputFor = (f: Awaited<ReturnType<typeof fixture>>) => ({
  questions: f.qs,
  assets: [],
  handoff: f.handoff,
  instructorPackages: [f.instructor],
  legacyPackages: [f.legacy],
  namespace: "demo" as const,
  ownerKey: "account-a",
});

async function textHash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function semanticLink(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    id?: string;
    questionIndex?: number;
    wholeQuestion?: boolean;
    instructorRecordIndex?: number;
  } = {},
): Promise<SemanticFrequentLink> {
  const q = f.qs[options.questionIndex ?? 0],
    selected = options.wholeQuestion ? null : selector,
    expectedText = selected ? targetText(q, selected) : frequentQuestionText(q);
  const link: SemanticFrequentLink = {
    id: options.id ?? "semantic-link",
    questionId: q.id,
    subjectId: q.subjectId,
    questionRevision: q.revision,
    gradingRevision: q.gradingRevision,
    questionFingerprint: await questionFingerprint(q),
    sourceKey: [
      q.source.examCode,
      q.subjectId,
      q.source.year,
      q.source.round,
      q.source.questionNumber,
    ],
    selector: selected,
    expectedText,
    evidenceLane: "semantic_reviewed",
    classificationStatus: "confirmed",
    semanticReason: "Synthetic direct meaning review.",
    legalVerificationStatus: "not_reviewed",
    evidence: [
      {
        kind: "question_text",
        sourceFileName: null,
        sourceLocations: [],
        contentSha256: await textHash(expectedText),
      },
    ],
  };
  if (options.instructorRecordIndex !== undefined) {
    const record = f.instructor.records[options.instructorRecordIndex],
      document = f.instructor.documents.find(
        (d) => d.documentId === record.documentId,
      )!,
      block = record.blocks[0];
    if (block.type !== "text") throw Error("Synthetic text block required");
    link.evidence = [
      {
        kind: "instructor_block",
        recordId: record.id,
        recordRevision: record.revision,
        documentId: document.documentId,
        documentSha256: document.sha256,
        sourceType: document.sourceType ?? "instructor",
        blockIndex: 0,
        expectedText: block.text,
        contentSha256: await textHash(block.text),
        sourceLocations: block.locations.length
          ? block.locations
          : record.locations,
      },
    ];
  }
  return link;
}
async function semanticFixture(
  options: Parameters<typeof semanticLink>[1] = {},
) {
  const f = await fixture(),
    link = await semanticLink(f, options),
    handoff = parseFrequentIssuesPackage({
      ...f.handoff,
      schemaVersion: "1.1.0",
      handoffRevision: 1,
      reviewedLearningTopics: [],
      canonicalLearningTopics: [
        {
          id: "semantic-topic",
          title: "Semantically reviewed topic",
          aliases: ["Synthetic alias"],
          subjectId: "police",
          classificationLevel: "issue",
          studyUnitCodes: [],
          links: [link],
        },
      ],
    });
  if (handoff.schemaVersion !== "1.1.0") throw Error("Synthetic v1.1 required");
  return { ...f, handoff };
}

describe("frequent issue handoff contract", () => {
  it("accepts the distinct format and keeps legal statuses unchanged", async () => {
    const f = await fixture();
    const p = parseFrequentIssuesPackage(f.handoff);
    expect(p.sourceCitationOccurrences[0].legalVerificationStatus).toBe(
      "not_reviewed",
    );
    expect(() =>
      parseFrequentIssuesPackage({
        ...p,
        format: "police-original-explanations",
      }),
    ).toThrow();
    p.sourceCitationOccurrences[0].sourceIdentificationStatus = "unresolved";
    p.sourceCitationOccurrences[0].reason = "dated_registry_match";
    expect(
      parseFrequentIssuesPackage(p).sourceCitationOccurrences[0].disposition,
    ).toBe("source_linked");
  });
  it("rejects duplicate identities, broken references and topic scope expansion", async () => {
    const f = await fixture();
    for (const mutate of [
      (p: FrequentIssuesPackage) => {
        p.questionIndex.push(p.questionIndex[0]);
      },
      (p: FrequentIssuesPackage) => {
        p.legacyVerifiedLinks[0].references[0].issueIds = ["missing"];
      },
      (p: FrequentIssuesPackage) => {
        p.sourceCitationOccurrences[0].questionFingerprint = "b".repeat(64);
      },
      (p: FrequentIssuesPackage) => {
        p.reviewedLearningTopics[0].links[0].reviewedIssueIds = ["missing"];
      },
      (p: FrequentIssuesPackage) => {
        p.sourceCitationOccurrences[0].characterOffsets.end = 0;
      },
      (p: FrequentIssuesPackage) => {
        p.reviewedLearningTopics[1].links[0].questionId =
          p.questionIndex[1].questionId;
        Object.assign(p.reviewedLearningTopics[1].links[0], p.questionIndex[1]);
      },
    ]) {
      const p = structuredClone(f.handoff);
      mutate(p);
      expect(() => parseFrequentIssuesPackage(p)).toThrow();
    }
  });
});

describe("frequent issue aggregation", () => {
  it("separates verified issues, source citations and reviewed learning topics", async () => {
    const f = await fixture(),
      result = analyzeFrequentIssues(
        await buildFrequentIssuesIndex(inputFor(f)),
      );
    expect(result.total).toBe(2);
    expect(result.lanes.legacy).toMatchObject({
      covered: 2,
      targets: 2,
      coverage: 100,
    });
    expect(result.lanes.source).toMatchObject({
      covered: 1,
      targets: 1,
      coverage: 50,
    });
    expect(result.lanes.reviewed).toMatchObject({ covered: 1, targets: 1 });
    expect(result.rows.find((r) => r.id === "issue1")).toMatchObject({
      questions: 2,
      rounds: 2,
      targets: 2,
    });
    const reviewed = result.rows.find((r) => r.id === "topic1")!;
    expect(reviewed.questions).toBe(1);
    expect(reviewed.reading.excerpts.map((e) => e.text)).toEqual([
      "Verified issue1 only",
    ]);
    const instructorTopic = result.rows.find((r) => r.id === "topic2")!;
    expect(instructorTopic.links[0].legalStatus).toBe("not_reviewed");
    expect(instructorTopic.reading.notes[0].text).toBe(
      "Curated connection reason.",
    );
    expect(instructorTopic.reading.excerpts[0].text).toBe("😀case context");
  });
  it("deduplicates reimports, instructors, mentions and cloned source questions", async () => {
    const f = await fixture();
    const clone = structuredClone(f.qs[0]);
    clone.id = "reassembled-question";
    f.qs.push(clone);
    f.handoff.sourceCitationOccurrences.push({
      ...f.handoff.sourceCitationOccurrences[0],
      citationId: "duplicate-mention",
    });
    const secondInstructor = structuredClone(f.instructor);
    secondInstructor.packageId = "other-instructor";
    secondInstructor.records[0].id = "record2";
    f.handoff.sourceCitationOccurrences.push({
      ...f.handoff.sourceCitationOccurrences[0],
      citationId: "second-instructor",
      recordId: "record2",
    });
    const result = analyzeFrequentIssues(
      await buildFrequentIssuesIndex({
        ...inputFor(f),
        instructorPackages: [f.instructor, f.instructor, secondInstructor],
        legacyPackages: [f.legacy, f.legacy],
      }),
    );
    expect(result.total).toBe(2);
    expect(result.rows.find((r) => r.id === "authority1")).toMatchObject({
      questions: 1,
      targets: 1,
      rounds: 1,
    });
    expect(result.duplicates).toEqual([
      { questionIds: ["q1", "reassembled-question"], conflict: false },
    ]);
  });
  it("counts a whole-question citation as a question with zero statement targets", async () => {
    const f = await fixture();
    f.handoff.sourceCitationOccurrences[0].scopeKind = "question";
    f.handoff.sourceCitationOccurrences[0].recordScopeTargets = [];
    f.instructor.records[0].scope = { kind: "question", targets: [] };
    const result = analyzeFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(result.rows.find((r) => r.id === "authority1")).toMatchObject({
      questions: 1,
      targets: 0,
      wholeQuestions: 1,
    });
    // A separately reviewed selector still identifies one precise statement.
    expect(result.rows.find((r) => r.id === "topic2")?.targets).toBe(1);
  });
  it("excludes conflicting copies of the same source key from all frequency lanes", async () => {
    const f = await fixture(),
      conflict = structuredClone(f.qs[0]);
    conflict.id = "conflict";
    conflict.body[0] = { type: "text", text: "Changed source" };
    f.qs.push(conflict);
    const result = analyzeFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(result).toMatchObject({
      total: 1,
      covered: 1,
      ambiguous: 1,
      statuses: { conflict: 1 },
    });
    expect(result.lanes.source.covered).toBe(0);
    expect(result.rows.find((r) => r.id === "issue1")?.questions).toBe(1);
  });
  it.each([
    "revision",
    "gradingRevision",
    "text",
    "selector",
    "document",
    "record",
    "block",
    "offset",
  ])(
    "marks %s changes stale rather than reusing old evidence",
    async (change) => {
      const f = await fixture();
      if (change === "revision") f.qs[0].revision++;
      if (change === "gradingRevision") f.qs[0].gradingRevision++;
      if (change === "text")
        f.qs[0].choices[0].blocks[0] = { type: "text", text: "Changed" };
      if (change === "selector")
        f.handoff.sourceCitationOccurrences[0].recordScopeTargets[0].expectedText =
          "Different target";
      if (change === "document")
        f.instructor.documents[0].sha256 = "c".repeat(64);
      if (change === "record") f.instructor.records[0].revision++;
      if (change === "block")
        f.instructor.records[0].blocks[0] = {
          type: "text",
          role: "explanation",
          text: "Changed",
          locations: [],
        };
      if (change === "offset")
        f.handoff.sourceCitationOccurrences[0].characterOffsets.start = 0;
      const result = analyzeFrequentIssues(
        await buildFrequentIssuesIndex(inputFor(f)),
      );
      expect(result.lanes.source.covered).toBe(0);
      expect(result.lanes.source.statuses.stale).toBe(1);
      if (["revision", "gradingRevision", "text"].includes(change))
        expect(result.lanes.legacy.covered).toBe(1);
    },
  );
  it("keeps unknown identity, held extraction and answer conflict distinct", async () => {
    const f = await fixture();
    f.handoff.sourceCitationOccurrences[0].disposition = "identity_hold";
    expect(
      analyzeFrequentIssues(await buildFrequentIssuesIndex(inputFor(f))).lanes
        .source.statuses.unknown,
    ).toBe(1);
    f.handoff.sourceCitationOccurrences[0].disposition = "source_linked";
    f.instructor.records[0].matching.status = "hold";
    expect(
      analyzeFrequentIssues(await buildFrequentIssuesIndex(inputFor(f))).lanes
        .source.statuses.hold,
    ).toBe(1);
    f.instructor.records[0].sourceSymbols.answer = {
      rawText: "2",
      numbers: [2],
    };
    const conflict = analyzeFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(conflict.lanes.source.statuses.conflict).toBe(1);
    expect(conflict.lanes.source.covered).toBe(0);
  });
  it("uses handoff verified links without archived full text and respects newer holds", async () => {
    const f = await fixture();
    const standalone = analyzeFrequentIssues(
      await buildFrequentIssuesIndex({ ...inputFor(f), legacyPackages: [] }),
    );
    expect(standalone.lanes.legacy.covered).toBe(2);
    expect(
      standalone.rows.find((r) => r.id === "issue1")?.reading.excerpts,
    ).toEqual([]);
    f.legacy.packageVersion = 2;
    f.legacy.explanations[0].verification.status = "hold";
    const current = analyzeFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(current.lanes.legacy.covered).toBe(1);
    expect(current.lanes.legacy.statuses.hold).toBe(1);
    expect(current.rows.find((r) => r.id === "topic1")).toBeUndefined();
  });
  it("invalidates a reviewed topic when the current explanation revises its issue scope", async () => {
    const f = await fixture();
    f.legacy.packageVersion = 2;
    f.legacy.explanations[0].revision++;
    f.legacy.explanations[0].references = [
      { basisId: "basis1", issueIds: ["issue2"] },
    ];
    const current = analyzeFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(current.lanes.legacy.covered).toBe(2);
    expect(current.rows.find((r) => r.id === "topic1")).toBeUndefined();
    expect(current.lanes.reviewed.statuses.stale).toBe(1);
  });
  it("handles selected year/round/unit scope and removed questions", async () => {
    const f = await fixture(),
      unit = units.find((u) => u.subjectId === "police")!;
    f.qs[0].classification!.studyUnitCode = unit.code;
    f.qs[0].classification!.studyStatus = "confirmed";
    const index = await buildFrequentIssuesIndex(inputFor(f));
    const scoped = analyzeFrequentIssues(index, {
      ...emptyFrequentFilter,
      unitId: unit.code,
      round: "1",
    });
    expect(scoped.total).toBe(1);
    expect(scoped.covered).toBe(1);
    expect(scoped.lanes.source.coverage).toBe(100);
    const removed = analyzeFrequentIssues(
      await buildFrequentIssuesIndex({ ...inputFor(f), removed: [f.qs[0].id] }),
    );
    expect(removed.total).toBe(1);
    expect(removed.lanes.source.covered).toBe(0);
    expect(
      analyzeFrequentIssues(index, { ...emptyFrequentFilter, year: "2025" })
        .total,
    ).toBe(0);
  });
  it("uses original book descendants and confirmed related study-unit assignments", () => {
    const q = question(),
      node = bookNodes.find((n) => n.subjectId === "police" && n.parentId)!;
    q.classification!.bookUnitIds = [node.id];
    expect(matchesFrequentUnit(q, node.parentId!)).toBe(true);
    const unit = units.find((u) => u.subjectId === "police")!;
    q.classification!.relatedStudyUnitCodes = [unit.code];
    expect(matchesFrequentUnit(q, unit.code)).toBe(false);
    q.classification!.studyStatus = "confirmed";
    expect(matchesFrequentUnit(q, unit.code)).toBe(true);
  });
  it("isolates account, namespace, source changes and cache invalidation", async () => {
    const f = await fixture(),
      input = inputFor(f);
    const first = getFrequentIssuesIndex(input);
    expect(getFrequentIssuesIndex({ ...input })).toBe(first);
    expect(
      getFrequentIssuesIndex({ ...input, ownerKey: "account-b" }),
    ).not.toBe(first);
    expect(getFrequentIssuesIndex({ ...input, removed: ["q1"] })).not.toBe(
      first,
    );
    const real = await getFrequentIssuesIndex({ ...input, namespace: "real" });
    expect(analyzeFrequentIssues(real).rows).toEqual([]);
    const replacement = structuredClone(f.instructor);
    replacement.packageVersion++;
    expect(
      getFrequentIssuesIndex({ ...input, instructorPackages: [replacement] }),
    ).not.toBe(first);
    await first;
  });
});

describe("unified canonical frequent topics", () => {
  it("retains the old diagnostic API and exposes only explicitly reviewed v1.0 topics", async () => {
    const f = await fixture(),
      index = await buildFrequentIssuesIndex(inputFor(f)),
      old = analyzeFrequentIssues(index),
      unified = analyzeUnifiedFrequentIssues(index);
    expect(unified.diagnosticAnalysis).toEqual(old);
    expect(unified.rows.map((row) => row.id).sort()).toEqual([
      "topic1",
      "topic2",
    ]);
    expect(old.rows.some((row) => row.kind === "authority")).toBe(true);
    expect(old.rows.some((row) => row.kind === "legacy-basis")).toBe(true);
    expect(unified.covered).toBe(1);
    expect(unified.rows.every((row) => row.kind === "reviewed-topic")).toBe(
      true,
    );
  });

  it("preserves existing topic links and source readings through an explicit v1.1 migration", async () => {
    const f = await fixture(),
      before = analyzeUnifiedFrequentIssues(
        await buildFrequentIssuesIndex(inputFor(f)),
      );
    expect(
      before.rows.every((row) => row.classificationLevel === "unspecified"),
    ).toBe(true);
    f.handoff = parseFrequentIssuesPackage({
      ...f.handoff,
      schemaVersion: "1.1.0",
      handoffRevision: 1,
      canonicalLearningTopics: f.handoff.reviewedLearningTopics.map(
        (topic) => ({
          id: topic.id,
          title: topic.title,
          subjectId: topic.subjectId,
          aliases: [],
          classificationLevel: "issue",
          studyUnitCodes: [],
          links: topic.links,
        }),
      ),
    });
    const after = analyzeUnifiedFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(after.rows).toEqual(
      before.rows.map((row) => ({ ...row, classificationLevel: "issue" })),
    );
    expect(after.diagnosticAnalysis).toEqual(before.diagnosticAnalysis);
  });

  it.each(["absent", "unresolved"])(
    "accepts matched instructor meaning when citation identity is %s",
    async (identity) => {
      const f = await semanticFixture({ instructorRecordIndex: 0 });
      if (identity === "absent") {
        f.handoff.sourceCitationOccurrences = [];
        f.handoff.authorityCatalog = [];
      } else {
        const citation = f.handoff.sourceCitationOccurrences[0];
        citation.disposition = "identity_hold";
        citation.sourceIdentificationStatus = "unresolved";
        citation.authorityId = null;
        citation.sourceUnresolvedReasons = ["Synthetic unidentified citation"];
      }
      const result = analyzeUnifiedFrequentIssues(
        await buildFrequentIssuesIndex(inputFor(f)),
      );
      expect(result).toMatchObject({ covered: 1, targets: 1 });
      expect(result.rows[0]).toMatchObject({
        id: "semantic-topic",
        aliases: ["Synthetic alias"],
        questions: 1,
      });
      expect(result.rows[0].reading.sources).toHaveLength(1);
      expect(result.rows[0].links[0].legalStatus).toBe("not_reviewed");
      expect(result.lanes.source.covered).toBe(0);
    },
  );

  it("counts a confirmed whole question once without inventing target occurrences", async () => {
    const f = await semanticFixture({ wholeQuestion: true });
    const result = analyzeUnifiedFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(result).toMatchObject({ covered: 1, targets: 0, wholeQuestions: 1 });
    expect(result.rows[0]).toMatchObject({
      questions: 1,
      targets: 0,
      wholeQuestions: 1,
    });
    expect(result.rows[0].links[0].selector).toBeNull();
    expect(result.rows[0].reading.status).toBe("reviewed-links-only");
  });

  it("deduplicates one target across sources and retains multiple semantic topics", async () => {
    const f = await semanticFixture({ instructorRecordIndex: 0 });
    const secondDocument = structuredClone(f.instructor.documents[0]);
    secondDocument.documentId = "document2";
    secondDocument.sha256 = "b".repeat(64);
    secondDocument.title = "Second synthetic source";
    const secondRecord = structuredClone(f.instructor.records[0]);
    secondRecord.id = "record2";
    secondRecord.documentId = secondDocument.documentId;
    f.instructor.documents.push(secondDocument);
    f.instructor.records.push(secondRecord);
    const topic = f.handoff.canonicalLearningTopics[0];
    topic.links.push(
      await semanticLink(f, { id: "same-source", instructorRecordIndex: 0 }),
      await semanticLink(f, { id: "second-source", instructorRecordIndex: 1 }),
      await semanticLink(f, { id: "original-text" }),
    );
    f.handoff.canonicalLearningTopics.push({
      ...topic,
      id: "different-meaning",
      title: "A separate meaning from the same question",
      aliases: [],
      links: [await semanticLink(f, { id: "different-meaning-link" })],
    });
    const result = analyzeUnifiedFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(result).toMatchObject({ covered: 1, targets: 1 });
    expect(result.rows).toHaveLength(2);
    const combined = result.rows.find((row) => row.id === topic.id)!;
    expect(combined).toMatchObject({ questions: 1, targets: 1, rounds: 1 });
    expect(combined.links).toHaveLength(1);
    expect(combined.reading.sources).toHaveLength(2);
    expect(combined.reading.excerpts).toHaveLength(2);
  });

  it.each([
    "question",
    "grading",
    "document",
    "record",
    "text",
    "location",
    "scope",
    "wrong-question",
  ])(
    "excludes stale or mismatched semantic evidence after a %s change",
    async (change) => {
      const f = await semanticFixture({ instructorRecordIndex: 0 });
      if (change === "question") f.qs[0].revision++;
      if (change === "grading") f.qs[0].gradingRevision++;
      if (change === "document")
        f.instructor.documents[0].sha256 = "c".repeat(64);
      if (change === "record") f.instructor.records[0].revision++;
      if (change === "text") {
        const block = f.instructor.records[0].blocks[0];
        if (block.type === "text") block.text = "Changed explanation context";
      }
      if (change === "location")
        f.instructor.records[0].blocks[0].locations[0].bbox = [0, 0, 10, 10];
      if (change === "scope")
        f.instructor.records[0].scope.targets = [
          { selector: { kind: "choice", number: 2 }, expectedText: "Target 2" },
        ];
      if (change === "wrong-question")
        f.instructor.records[0].questionId = f.qs[1].id;
      const result = analyzeUnifiedFrequentIssues(
        await buildFrequentIssuesIndex(inputFor(f)),
      );
      expect(result.rows).toEqual([]);
      expect(result.covered).toBe(0);
      expect(result.statuses.stale).toBe(1);
    },
  );

  it("keeps pending and held classification out of the study list", async () => {
    const f = await semanticFixture();
    const link = f.handoff.canonicalLearningTopics[0].links[0];
    if (link.evidenceLane !== "semantic_reviewed")
      throw Error("Synthetic semantic link required");
    link.classificationStatus = "pending";
    let result = analyzeUnifiedFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(result.rows).toEqual([]);
    expect(result.statuses.unknown).toBe(1);
    link.classificationStatus = "hold";
    result = analyzeUnifiedFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(result.rows).toEqual([]);
    expect(result.statuses.hold).toBe(1);
  });

  it("ranks the same classification level by questions, repeated rounds, then latest", async () => {
    const f = await semanticFixture(),
      q3 = question(3, "1"),
      q4 = question(4, "3");
    f.qs.push(q3, q4);
    for (const q of [q3, q4]) {
      const binding = await semanticLink(f, { questionIndex: f.qs.indexOf(q) });
      f.handoff.questionIndex.push({
        questionId: binding.questionId,
        subjectId: binding.subjectId,
        questionRevision: binding.questionRevision,
        gradingRevision: binding.gradingRevision,
        questionFingerprint: binding.questionFingerprint,
        sourceKey: binding.sourceKey,
        eligible: true,
        classification: null,
      });
    }
    const topic = f.handoff.canonicalLearningTopics[0];
    f.handoff.canonicalLearningTopics = await Promise.all(
      [
        { id: "same-round", q: [0, 2] },
        { id: "repeat", q: [0, 1] },
        { id: "latest", q: [1, 3] },
        { id: "single-question", q: [0] },
      ].map(async (item) => ({
        ...topic,
        id: item.id,
        title: item.id,
        links: await Promise.all(
          item.q.map((questionIndex) =>
            semanticLink(f, {
              id: `${item.id}-${questionIndex}`,
              questionIndex,
            }),
          ),
        ),
      })),
    );
    const result = analyzeUnifiedFrequentIssues(
      await buildFrequentIssuesIndex(inputFor(f)),
    );
    expect(result.rows.map((row) => row.id)).toEqual([
      "latest",
      "repeat",
      "same-round",
      "single-question",
    ]);
  });
});
