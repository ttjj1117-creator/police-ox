import type { Asset, Namespace, Question } from "../model";
import { bookNodes, isEligible, units } from "../validation";
import {
  canonicalExplanationValue as canonical,
  explanationIndex,
  questionFingerprint,
  selectorKey,
  sourceKey,
  targetText,
  type Basis,
  type Explanation,
  type ExplanationPackage,
  type Issue,
  type TargetSelector,
} from "../explanations/contract";
import { resolveExplanations } from "../explanations/analysis";
import type {
  InstructorDocument,
  InstructorPackage,
  InstructorRecord,
} from "../instructor/contract";
import {
  emptyFrequentFilter,
  getFrequentLearningTopics,
  parseFrequentIssuesPackage,
  semanticFrequentLinkMismatch,
  type FrequentAnalysis,
  type FrequentCitation,
  type FrequentClassificationLevel,
  type FrequentEvidenceLane,
  type FrequentFilter,
  type FrequentIssuesPackage,
  type FrequentLaneCoverage,
  type FrequentLegacyLink,
  type FrequentLink,
  type FrequentReading,
  type FrequentReviewedLink,
  type FrequentRow,
  type FrequentSource,
  type FrequentStatus,
  type FrequentStatuses,
  type ReadingExcerpt,
} from "./contract";

export { emptyFrequentFilter } from "./contract";
export type { FrequentFilter } from "./contract";

export interface FrequentIndexInput {
  questions: Question[];
  assets: Asset[];
  legacyPackages?: ExplanationPackage[];
  instructorPackages?: InstructorPackage[];
  handoff?: FrequentIssuesPackage | null;
  namespace: Namespace;
  /** The caller must supply only sources authorized for this account. */
  ownerKey: string;
  removed?: string[];
}
type IndexedRow = Pick<
  FrequentRow,
  "key" | "id" | "title" | "kind" | "lane" | "basisId"
> & { links: FrequentLink[] };
type Diagnostic = {
  question: Question;
  lane: FrequentEvidenceLane;
  status: FrequentStatus;
};
export interface UnifiedFrequentRow extends FrequentRow {
  aliases: string[];
  subjectId: Question["subjectId"];
  classificationLevel: FrequentClassificationLevel;
  studyUnitCodes: string[];
}
type IndexedCanonicalRow = IndexedRow &
  Pick<
    UnifiedFrequentRow,
    "aliases" | "subjectId" | "classificationLevel" | "studyUnitCodes"
  >;
export interface UnifiedFrequentAnalysis extends FrequentAnalysis {
  rows: UnifiedFrequentRow[];
  wholeQuestions: number;
  /** Preserved source and legacy diagnostics are available in the issue detail. */
  diagnosticAnalysis: FrequentAnalysis;
}
export interface FrequentIssuesIndex {
  ownerKey: string;
  namespace: Namespace;
  questions: Question[];
  rows: IndexedRow[];
  canonicalRows: IndexedCanonicalRow[];
  diagnostics: Diagnostic[];
  semanticDiagnostics: Diagnostic[];
  duplicates: { questionIds: string[]; conflict: boolean }[];
  ambiguousKeys: Set<string>;
}

const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const laneNames: FrequentEvidenceLane[] = [
  "legacy_verified",
  "instructor_source",
  "reviewed_topic",
];
const compareQuestions = (a: Question, b: Question) =>
  b.source.year - a.source.year ||
  b.source.round.localeCompare(a.source.round, "ko", { numeric: true }) ||
  a.source.questionNumber - b.source.questionNumber ||
  a.id.localeCompare(b.id);
const roundKey = (q: Question) =>
  canonical([q.source.examCode, q.source.year, q.source.round]);
const linkKey = (link: FrequentLink) =>
  canonical([
    sourceKey(link.question),
    link.selector ? selectorKey(link.selector) : null,
  ]);
const blankStatuses = (): FrequentStatuses => ({
  unknown: 0,
  hold: 0,
  conflict: 0,
  stale: 0,
});
const uniqueBy = <T>(values: T[], key: (value: T) => string): T[] => [
  ...new Map(values.map((v) => [key(v), v])).values(),
];

const bookParents = new Map(bookNodes.map((node) => [node.id, node.parentId]));
function isBookDescendant(id: string, ancestor: string) {
  const visited = new Set<string>();
  for (
    let current: string | null | undefined = id;
    current && !visited.has(current);
    current = bookParents.get(current)
  ) {
    if (current === ancestor) return true;
    visited.add(current);
  }
  return false;
}
/** Uses the same confirmed study-group/book-position rules as the existing selector. */
export function matchesFrequentUnit(q: Question, unitId: string): boolean {
  if (!unitId) return true;
  const classification = q.classification;
  if (!classification) return false;
  const unit = units.find(
    (item) => item.code === unitId && item.subjectId === q.subjectId,
  );
  if (!unit)
    return classification.bookUnitIds.some((id) =>
      isBookDescendant(id, unitId),
    );
  if (classification.studyStatus !== "confirmed") return false;
  return (
    classification.studyUnitCode === unitId ||
    classification.relatedStudyUnitCodes.includes(unitId) ||
    classification.bookUnitIds.some((id) =>
      unit.bookNodeIds.some((nodeId) =>
        unit.includeDescendants ? isBookDescendant(id, nodeId) : id === nodeId,
      ),
    )
  );
}
function matches(q: Question, filter: FrequentFilter) {
  return (
    (!filter.subjectId || q.subjectId === filter.subjectId) &&
    (!filter.examCode || q.source.examCode === filter.examCode) &&
    (!filter.year || String(q.source.year) === filter.year) &&
    (!filter.round || q.source.round === filter.round) &&
    matchesFrequentUnit(q, filter.unitId)
  );
}

/** Prefer the highest package revision; equal-revision conflicts are excluded. */
function currentPackages<
  T extends { packageId: string; packageVersion: number; dataKind: Namespace },
>(packages: T[], namespace: Namespace) {
  const grouped = new Map<string, T[]>();
  for (const p of packages)
    if (p.dataKind === namespace)
      grouped.set(p.packageId, [...(grouped.get(p.packageId) ?? []), p]);
  const selected: T[] = [],
    conflicts: T[] = [];
  for (const group of grouped.values()) {
    const latest = Math.max(...group.map((p) => p.packageVersion));
    const candidates = group.filter((p) => p.packageVersion === latest);
    if (candidates.some((p) => !equal(p, candidates[0])))
      conflicts.push(...candidates);
    else selected.push(candidates[0]);
  }
  return { selected, conflicts };
}

export async function buildFrequentIssuesIndex(
  input: FrequentIndexInput,
): Promise<FrequentIssuesIndex> {
  const removed = new Set(input.removed ?? []);
  const questions = input.questions.filter(
    (q) => !removed.has(q.id) && isEligible(q, input.namespace),
  );
  const allQuestions = new Map(input.questions.map((q) => [q.id, q]));
  const eligibleIds = new Set(questions.map((q) => q.id));
  const hashes = new Map<Question, string>();
  await Promise.all(
    questions.map(async (q) => {
      hashes.set(q, await questionFingerprint(q, input.assets));
    }),
  );
  const sourceGroups = new Map<string, Question[]>();
  for (const q of questions)
    sourceGroups.set(sourceKey(q), [
      ...(sourceGroups.get(sourceKey(q)) ?? []),
      q,
    ]);
  const duplicates: FrequentIssuesIndex["duplicates"] = [];
  const ambiguousKeys = new Set<string>();
  for (const [key, group] of sourceGroups) {
    if (group.length < 2) continue;
    const conflict = new Set(group.map((q) => hashes.get(q))).size > 1;
    duplicates.push({ questionIds: group.map((q) => q.id), conflict });
    if (conflict) ambiguousKeys.add(key);
  }
  const diagnostics: Diagnostic[] = [];
  const mark = (
    q: Question | undefined,
    lane: FrequentEvidenceLane,
    status: FrequentStatus,
  ) => {
    if (q && eligibleIds.has(q.id))
      diagnostics.push({ question: q, lane, status });
  };
  for (const q of questions)
    if (ambiguousKeys.has(sourceKey(q)))
      for (const lane of laneNames) mark(q, lane, "conflict");
  const rows = new Map<string, IndexedRow>();
  const add = (row: Omit<IndexedRow, "links">, link: FrequentLink) => {
    if (ambiguousKeys.has(sourceKey(link.question))) return;
    const old = rows.get(row.key);
    if (old) old.links.push(link);
    else rows.set(row.key, { ...row, links: [link] });
  };
  type Bound = Pick<
    FrequentLegacyLink,
    | "questionId"
    | "subjectId"
    | "questionRevision"
    | "gradingRevision"
    | "questionFingerprint"
    | "sourceKey"
  >;
  const bindingStatus = (
    binding: Bound,
    q: Question,
  ): FrequentStatus | undefined => {
    if (
      binding.questionId !== q.id ||
      binding.subjectId !== q.subjectId ||
      binding.questionRevision !== q.revision ||
      binding.gradingRevision !== q.gradingRevision ||
      binding.questionFingerprint !== hashes.get(q) ||
      canonical(binding.sourceKey) !== sourceKey(q)
    )
      return "stale";
    return undefined;
  };
  const targetMatches = (
    q: Question,
    selector: TargetSelector,
    expectedText: string,
  ) => {
    try {
      return targetText(q, selector) === expectedText;
    } catch {
      return false;
    }
  };
  const handoff =
    input.handoff && input.handoff.dataKind === input.namespace
      ? parseFrequentIssuesPackage(input.handoff)
      : null;
  const handoffQuestions = new Map(
    handoff?.questionIndex.map((q) => [q.questionId, q]) ?? [],
  );
  const legacySelection = currentPackages(
    input.legacyPackages ?? [],
    input.namespace,
  );
  const instructorSelection = currentPackages(
    input.instructorPackages ?? [],
    input.namespace,
  );
  const blockedLegacy = new Set<string>();
  for (const p of legacySelection.conflicts)
    for (const e of p.explanations) {
      blockedLegacy.add(e.questionId);
      mark(allQuestions.get(e.questionId), "legacy_verified", "conflict");
    }
  const blockedInstructor = new Set<string>();
  for (const p of instructorSelection.conflicts)
    for (const r of p.records) {
      blockedInstructor.add(r.id);
      mark(allQuestions.get(r.questionId), "instructor_source", "conflict");
    }

  let legacyIndex: ReturnType<typeof explanationIndex> | undefined;
  try {
    legacyIndex = explanationIndex(legacySelection.selected);
  } catch {
    for (const p of legacySelection.selected)
      for (const e of p.explanations) {
        blockedLegacy.add(e.questionId);
        mark(allQuestions.get(e.questionId), "legacy_verified", "conflict");
      }
  }
  type CatalogBasis =
    | NonNullable<typeof handoff>["legacyCatalog"]["bases"][number]
    | Basis;
  type CatalogIssue =
    | NonNullable<typeof handoff>["legacyCatalog"]["issues"][number]
    | Issue;
  const bases = new Map<string, CatalogBasis>(
    (handoff?.legacyCatalog.bases ?? []).map((b) => [b.id, b]),
  );
  const issues = new Map<string, CatalogIssue>(
    (handoff?.legacyCatalog.issues ?? []).map((i) => [i.id, i]),
  );
  for (const b of legacyIndex?.bases ?? []) bases.set(b.id, b);
  for (const i of legacyIndex?.issues ?? []) issues.set(i.id, i);
  const validLegacy = new Map<string, FrequentLink>();
  const currentExplanations = new Map(
    legacyIndex?.explanations.map((e) => [e.id, e]) ?? [],
  );
  const legacySources = (
    references: FrequentLegacyLink["references"],
    allowedIssues?: string[],
  ) =>
    references.flatMap((ref) =>
      ref.issueIds
        .filter((id) => !allowedIssues || allowedIssues.includes(id))
        .map((id) => {
          const basis = bases.get(ref.basisId)!;
          const issue = issues.get(id)!;
          return {
            id: `legacy:${id}`,
            title: basis.title,
            kind: "legacy" as const,
            legalStatus: "verified" as const,
            basisId: basis.id,
            issueId: id,
            sourceUrl: basis.sourceUrl,
            locator: issue.locator,
            locations: [],
          };
        }),
    );
  const legacyExcerpts = (
    q: Question,
    selector: TargetSelector,
    sources: FrequentSource[],
  ): ReadingExcerpt[] =>
    sources.flatMap((source) => {
      const issue = issues.get(source.issueId!);
      return issue && "excerpt" in issue
        ? [
            {
              id: `${source.id}:${q.id}:${selectorKey(selector)}`,
              title: issue.title,
              text: issue.excerpt,
              kind: "verified-excerpt" as const,
              questionId: q.id,
              selector,
              legalStatus: "verified" as const,
              sourceId: source.id,
            },
          ]
        : [];
    });
  const acceptLegacy = (
    record: FrequentLegacyLink | Explanation,
    q: Question,
    status?: FrequentStatus,
  ) => {
    if (blockedLegacy.has(q.id)) return;
    const explanationId =
      "explanationId" in record ? record.explanationId : record.id;
    const refStatus = record.references.every(
      (ref) =>
        bases.get(ref.basisId)?.verification.status === "verified" &&
        ref.issueIds.every(
          (id) =>
            issues.get(id)?.basisId === ref.basisId &&
            issues.get(id)?.verification.status === "verified",
        ),
    );
    const stale =
      record.questionRevision !== q.revision ||
      record.gradingRevision !== q.gradingRevision ||
      record.subjectId !== q.subjectId ||
      record.questionFingerprint !== hashes.get(q) ||
      !targetMatches(q, record.selector, record.expectedText);
    if (stale || status) {
      mark(q, "legacy_verified", stale ? "stale" : status!);
      return;
    }
    if (record.verification.status !== "verified" || !refStatus) {
      mark(
        q,
        "legacy_verified",
        record.verification.status === "hold" ? "hold" : "unknown",
      );
      return;
    }
    const sources = legacySources(record.references);
    const link: FrequentLink = {
      id: explanationId,
      question: q,
      selector: record.selector,
      expectedText: record.expectedText,
      evidenceLane: "legacy_verified",
      legalStatus: "verified",
      sources,
      excerpts: legacyExcerpts(q, record.selector, sources),
    };
    validLegacy.set(explanationId, link);
    for (const ref of record.references) {
      const basis = bases.get(ref.basisId)!;
      add(
        {
          key: `legacy-basis:${basis.id}`,
          id: basis.id,
          title: basis.title,
          kind: "legacy-basis",
          lane: "legacy_verified",
          basisId: basis.id,
        },
        {
          ...link,
          sources: sources.filter((s) => s.basisId === basis.id),
          excerpts: link.excerpts.filter((e) =>
            sources.some((s) => s.basisId === basis.id && s.id === e.sourceId),
          ),
        },
      );
      for (const issueId of new Set(ref.issueIds)) {
        const issue = issues.get(issueId)!;
        add(
          {
            key: `legacy-issue:${issueId}`,
            id: issueId,
            title: issue.title,
            kind: "legacy-issue",
            lane: "legacy_verified",
            basisId: basis.id,
          },
          {
            ...link,
            sources: sources.filter((s) => s.issueId === issueId),
            excerpts: link.excerpts.filter(
              (e) => e.sourceId === `legacy:${issueId}`,
            ),
          },
        );
      }
    }
  };
  // Reuse the existing legal verification resolver; additionally bind question revision.
  if (legacyIndex)
    for (const q of questions) {
      const resolved = await resolveExplanations(
        q,
        legacySelection.selected,
        input.assets,
        legacyIndex,
      );
      for (const result of resolved)
        acceptLegacy(
          result.explanation,
          q,
          result.status === "verified"
            ? undefined
            : result.status === "draft"
              ? "unknown"
              : result.status,
        );
    }
  for (const record of handoff?.legacyVerifiedLinks ?? []) {
    const q = allQuestions.get(record.questionId);
    if (!q || !eligibleIds.has(q.id) || validLegacy.has(record.explanationId))
      continue;
    const current = currentExplanations.get(record.explanationId);
    if (current) continue; // Current records, including holds, supersede archived metadata.
    const replacementPackage = legacySelection.selected.find(
      (p) => p.packageId === handoff!.inputPackages.legacy.packageId,
    );
    if (replacementPackage) {
      mark(q, "legacy_verified", "stale");
      continue;
    }
    acceptLegacy(record, q, bindingStatus(record, q));
  }

  type RuntimeRecord = {
    record: InstructorRecord;
    document: InstructorDocument;
    package: InstructorPackage;
  };
  const records = new Map<string, RuntimeRecord>();
  const recordConflicts = new Set(blockedInstructor);
  for (const p of instructorSelection.selected) {
    const documents = new Map(p.documents.map((d) => [d.documentId, d]));
    for (const record of p.records) {
      const document = documents.get(record.documentId);
      if (!document) {
        mark(allQuestions.get(record.questionId), "instructor_source", "stale");
        continue;
      }
      const old = records.get(record.id);
      if (
        old &&
        (!equal(old.record, record) || !equal(old.document, document))
      ) {
        recordConflicts.add(record.id);
        mark(
          allQuestions.get(record.questionId),
          "instructor_source",
          "conflict",
        );
      } else records.set(record.id, { record, document, package: p });
    }
  }
  const runtimeStatus = (
    runtime: RuntimeRecord,
    q: Question,
  ): FrequentStatus | undefined => {
    const r = runtime.record,
      d = runtime.document;
    if (recordConflicts.has(r.id)) return "conflict";
    if (
      r.questionId !== q.id ||
      r.subjectId !== q.subjectId ||
      r.questionRevision !== q.revision ||
      r.gradingRevision !== q.gradingRevision ||
      r.questionFingerprint !== hashes.get(q) ||
      !equal(r.officialAnswer, q.officialAnswer) ||
      r.sourceKey.examCode !== q.source.examCode ||
      r.sourceKey.year !== q.source.year ||
      r.sourceKey.round !== q.source.round ||
      r.sourceKey.questionNumber !== q.source.questionNumber ||
      d.exam.subjectId !== q.subjectId ||
      d.exam.examCode !== q.source.examCode ||
      d.exam.year !== q.source.year ||
      d.exam.round !== q.source.round ||
      r.scope.targets.some((t) => !targetMatches(q, t.selector, t.expectedText))
    )
      return "stale";
    if (
      r.sourceSymbols.answer &&
      !equal(
        [...r.sourceSymbols.answer.numbers].sort(),
        [...q.officialAnswer.acceptedChoices].sort(),
      )
    )
      return "conflict";
    if (
      r.matching.status === "hold" ||
      r.extraction.status === "hold" ||
      d.status === "hold"
    )
      return "hold";
    if (
      r.matching.status !== "checked" ||
      r.extraction.status !== "checked" ||
      d.status !== "checked"
    )
      return "unknown";
    return undefined;
  };
  const validCitations = new Map<
    string,
    { citation: FrequentCitation; runtime: RuntimeRecord }
  >();
  const instructorSource = (
    runtime: RuntimeRecord,
    blockIndex: number,
    locations: FrequentSource["locations"],
    precision: string,
  ): FrequentSource => ({
    id: `instructor:${runtime.record.id}:${blockIndex}`,
    title: runtime.document.title ?? runtime.document.originalFileName,
    kind: "instructor",
    sourceType: runtime.document.sourceType ?? "instructor",
    legalStatus: "not_reviewed",
    recordId: runtime.record.id,
    documentId: runtime.document.documentId,
    sourceUrl: runtime.document.sourceUrl,
    locations,
    locationPrecision: precision,
  });
  const instructorExcerpt = (
    runtime: RuntimeRecord,
    q: Question,
    selector: TargetSelector | null,
    blockIndex: number,
    source: FrequentSource,
  ): ReadingExcerpt[] => {
    const block = runtime.record.blocks[blockIndex];
    return block?.type === "text"
      ? [
          {
            id: `${source.id}:${q.id}:${selector ? selectorKey(selector) : "question"}`,
            title: source.title,
            text: block.text,
            kind: "instructor-context",
            questionId: q.id,
            selector,
            legalStatus: "not_reviewed",
            sourceId: source.id,
          },
        ]
      : [];
  };
  const authorityMap = new Map(
    handoff?.authorityCatalog.map((a) => [a.id, a]) ?? [],
  );
  for (const citation of handoff?.sourceCitationOccurrences ?? []) {
    const q = allQuestions.get(citation.questionId);
    if (!q || !eligibleIds.has(q.id)) continue;
    const indexedQ = handoffQuestions.get(q.id);
    if (!indexedQ || bindingStatus(indexedQ, q) || bindingStatus(citation, q)) {
      mark(q, "instructor_source", "stale");
      continue;
    }
    if (
      citation.disposition === "superseded_span" ||
      citation.disposition === "question_ineligible"
    )
      continue;
    const runtime = records.get(citation.recordId);
    if (!runtime) {
      mark(
        q,
        "instructor_source",
        recordConflicts.has(citation.recordId) ? "conflict" : "stale",
      );
      continue;
    }
    const status = runtimeStatus(runtime, q);
    if (status) {
      mark(q, "instructor_source", status);
      continue;
    }
    const r = runtime.record,
      d = runtime.document,
      block = r.blocks[citation.blockIndex];
    const span =
      block?.type === "text"
        ? Array.from(block.text)
            .slice(
              citation.characterOffsets.start,
              citation.characterOffsets.end,
            )
            .join("")
        : null;
    const locationValid = citation.sourceLocations.every(
      (l) =>
        l.page <= d.pageCount &&
        r.blocks[citation.blockIndex]?.locations.some((b) => b.page === l.page),
    );
    if (
      r.revision !== citation.recordRevision ||
      r.documentId !== citation.documentId ||
      d.sha256 !== citation.documentSha256 ||
      (d.sourceType ?? "instructor") !== citation.sourceType ||
      r.scope.kind !== citation.scopeKind ||
      !equal(r.scope.targets, citation.recordScopeTargets) ||
      span !== citation.rawCitation ||
      !locationValid
    ) {
      mark(q, "instructor_source", "stale");
      continue;
    }
    if (citation.disposition === "explanation_hold") {
      mark(q, "instructor_source", "hold");
      continue;
    }
    if (citation.disposition !== "source_linked") {
      mark(q, "instructor_source", "unknown");
      continue;
    }
    const authority = citation.authorityId
      ? authorityMap.get(citation.authorityId)
      : undefined;
    if (!authority) {
      mark(q, "instructor_source", "unknown");
      continue;
    }
    validCitations.set(citation.citationId, { citation, runtime });
    const title =
      authority.kind === "case"
        ? `${authority.court} ${authority.caseNumber}`
        : [
            authority.titleKey,
            ...authority.articleTrail,
            ...authority.qualifiers,
          ].join(" ");
    const source = instructorSource(
      runtime,
      citation.blockIndex,
      citation.sourceLocations,
      citation.locationPrecision,
    );
    for (const target of citation.scopeKind === "question"
      ? [null]
      : citation.recordScopeTargets) {
      const selector = target?.selector ?? null;
      const link: FrequentLink = {
        id: citation.citationId,
        question: q,
        selector,
        expectedText: target?.expectedText ?? null,
        evidenceLane: "instructor_source",
        legalStatus: "not_reviewed",
        sources: [source],
        excerpts: instructorExcerpt(
          runtime,
          q,
          selector,
          citation.blockIndex,
          source,
        ),
      };
      add(
        {
          key: `authority:${authority.id}`,
          id: authority.id,
          title,
          kind: "authority",
          lane: "instructor_source",
        },
        link,
      );
    }
  }
  const resolveReviewedLink = (
    topicId: string,
    reviewed: FrequentReviewedLink,
    q: Question,
    diagnose: (status: FrequentStatus) => void,
  ): FrequentLink | undefined => {
    if (
      bindingStatus(reviewed, q) ||
      !targetMatches(q, reviewed.selector, reviewed.expectedText)
    ) {
      diagnose("stale");
      return;
    }
    let sources: FrequentSource[] = [],
      excerpts: ReadingExcerpt[] = [];
    let valid = false;
    if (reviewed.evidenceLane === "legacy_verified") {
      const legacy = validLegacy.get(reviewed.explanationId);
      const current = currentExplanations.get(reviewed.explanationId);
      const currentReviewMatches =
        !current ||
        (current.revision === reviewed.revision &&
          equal(current.references, reviewed.references) &&
          reviewed.reviewedIssueIds.every((id) =>
            current.references.some((ref) => ref.issueIds.includes(id)),
          ));
      if (
        legacy &&
        currentReviewMatches &&
        equal(legacy.selector, reviewed.selector) &&
        legacy.expectedText === reviewed.expectedText
      ) {
        sources = legacySources(reviewed.references, reviewed.reviewedIssueIds);
        excerpts = legacyExcerpts(q, reviewed.selector, sources);
        valid = sources.length > 0;
      } else {
        diagnose(blockedLegacy.has(q.id) ? "conflict" : "stale");
      }
    } else {
      valid = validCitations.has(reviewed.sourceCitationId);
      if (!valid) diagnose("stale");
    }
    let evidenceValid = reviewed.evidenceLane === "legacy_verified";
    for (const evidence of reviewed.instructorEvidence) {
      const runtime = records.get(evidence.recordId);
      const currentStatus = runtime ? runtimeStatus(runtime, q) : "stale";
      if (!runtime || currentStatus) {
        if (reviewed.evidenceLane !== "legacy_verified")
          diagnose(currentStatus ?? "stale");
        continue;
      }
      const block = runtime.record.blocks[evidence.blockIndex];
      const expectedPackage = handoff!.inputPackages.instructor;
      const pinned = evidence.citationIds.length
        ? evidence.citationIds.every(
            (id) =>
              validCitations.get(id)?.runtime.record.id === evidence.recordId,
          )
        : runtime.package.packageId === expectedPackage.packageId &&
          runtime.package.packageVersion === expectedPackage.packageVersion;
      const sourceTypeMatches =
        (runtime.document.sourceType ?? "instructor") === evidence.sourceType;
      const locationValid = evidence.sourceLocations.every(
        (l) =>
          l.page <= runtime.document.pageCount &&
          block?.locations.some((location) => location.page === l.page),
      );
      if (
        !block ||
        block.type !== "text" ||
        !pinned ||
        !sourceTypeMatches ||
        runtime.record.documentId !== evidence.documentId ||
        !locationValid
      ) {
        if (reviewed.evidenceLane !== "legacy_verified") diagnose("stale");
        continue;
      }
      evidenceValid = true;
      const source = instructorSource(
        runtime,
        evidence.blockIndex,
        evidence.sourceLocations,
        "block",
      );
      sources.push(source);
      excerpts.push(
        ...instructorExcerpt(
          runtime,
          q,
          reviewed.selector,
          evidence.blockIndex,
          source,
        ),
      );
    }
    if (!valid || !evidenceValid) return;
    return {
      id: `${topicId}:${q.id}:${selectorKey(reviewed.selector)}`,
      question: q,
      selector: reviewed.selector,
      expectedText: reviewed.expectedText,
      evidenceLane: "reviewed_topic",
      legalStatus:
        reviewed.evidenceLane === "legacy_verified"
          ? "verified"
          : "not_reviewed",
      semanticReason: reviewed.semanticReason,
      sources,
      excerpts,
    };
  };
  for (const topic of handoff?.reviewedLearningTopics ?? [])
    for (const reviewed of topic.links) {
      const q = allQuestions.get(reviewed.questionId);
      if (!q || !eligibleIds.has(q.id)) continue;
      const link = resolveReviewedLink(topic.id, reviewed, q, (status) =>
        mark(q, "reviewed_topic", status),
      );
      if (!link) continue;
      add(
        {
          key: `reviewed-topic:${topic.id}`,
          id: topic.id,
          title: topic.title,
          kind: "reviewed-topic",
          lane: "reviewed_topic",
        },
        link,
      );
    }
  const semanticDiagnostics: Diagnostic[] = [];
  const canonicalRows: IndexedCanonicalRow[] = [];
  for (const topic of handoff ? getFrequentLearningTopics(handoff) : []) {
    const links: FrequentLink[] = [];
    for (const reviewed of topic.links) {
      const q = allQuestions.get(reviewed.questionId);
      if (!q || !eligibleIds.has(q.id)) continue;
      const diagnose = (status: FrequentStatus) =>
        semanticDiagnostics.push({
          question: q,
          lane: "reviewed_topic",
          status,
        });
      if (ambiguousKeys.has(sourceKey(q))) {
        diagnose("conflict");
        continue;
      }
      if (reviewed.evidenceLane !== "semantic_reviewed") {
        const link = resolveReviewedLink(topic.id, reviewed, q, diagnose);
        if (link) links.push(link);
        continue;
      }
      if (reviewed.classificationStatus !== "confirmed") {
        diagnose(reviewed.classificationStatus === "hold" ? "hold" : "unknown");
        continue;
      }
      const sourceStatus = reviewed.evidence.flatMap((evidence) => {
        if (evidence.kind !== "instructor_block") return [];
        const runtime = records.get(evidence.recordId);
        const status = runtime
          ? runtimeStatus(runtime, q)
          : recordConflicts.has(evidence.recordId)
            ? "conflict"
            : "stale";
        return status ? [status] : [];
      });
      if (sourceStatus.length) {
        for (const status of new Set(sourceStatus)) diagnose(status);
        continue;
      }
      if (
        bindingStatus(reviewed, q) ||
        (await semanticFrequentLinkMismatch(
          reviewed,
          q,
          input.assets,
          instructorSelection.selected,
        ))
      ) {
        diagnose("stale");
        continue;
      }
      const sources: FrequentSource[] = [],
        excerpts: ReadingExcerpt[] = [];
      for (const evidence of reviewed.evidence) {
        if (evidence.kind !== "instructor_block") continue;
        const runtime = records.get(evidence.recordId)!;
        const source = instructorSource(
          runtime,
          evidence.blockIndex,
          evidence.sourceLocations,
          "block",
        );
        sources.push(source);
        excerpts.push(
          ...instructorExcerpt(
            runtime,
            q,
            reviewed.selector,
            evidence.blockIndex,
            source,
          ),
        );
      }
      links.push({
        id: reviewed.id,
        question: q,
        selector: reviewed.selector,
        expectedText: reviewed.expectedText,
        evidenceLane: "reviewed_topic",
        legalStatus: "not_reviewed",
        semanticReason: reviewed.semanticReason,
        sources,
        excerpts,
      });
    }
    canonicalRows.push({
      key: `reviewed-topic:${topic.id}`,
      id: topic.id,
      title: topic.title,
      kind: "reviewed-topic",
      lane: "reviewed_topic",
      aliases: topic.aliases,
      subjectId: topic.subjectId,
      classificationLevel: topic.classificationLevel,
      studyUnitCodes: topic.studyUnitCodes,
      links,
    });
  }
  // Keep source/selector duplicates as one link while retaining all distinct source records.
  for (const row of [...rows.values(), ...canonicalRows]) {
    const merged = new Map<string, FrequentLink>();
    for (const link of row.links) {
      const key = linkKey(link),
        old = merged.get(key);
      if (!old) merged.set(key, { ...link });
      else
        merged.set(key, {
          ...old,
          sources: uniqueBy([...old.sources, ...link.sources], (s) => s.id),
          excerpts: uniqueBy([...old.excerpts, ...link.excerpts], (e) => e.id),
        });
    }
    row.links = [...merged.values()];
  }
  return {
    ownerKey: input.ownerKey,
    namespace: input.namespace,
    questions,
    rows: [...rows.values()],
    canonicalRows,
    diagnostics,
    semanticDiagnostics,
    duplicates,
    ambiguousKeys,
  };
}

const cache: {
  input: FrequentIndexInput;
  removedKey: string;
  promise: Promise<FrequentIssuesIndex>;
}[] = [];
/** Reference-based inputs are immutable app data, never attempts, timer or ink state. */
export function getFrequentIssuesIndex(
  input: FrequentIndexInput,
): Promise<FrequentIssuesIndex> {
  const removedKey = canonical([...(input.removed ?? [])].sort());
  const found = cache.find((entry) => {
    const old = entry.input;
    return (
      old.ownerKey === input.ownerKey &&
      old.namespace === input.namespace &&
      old.questions === input.questions &&
      old.assets === input.assets &&
      old.legacyPackages === input.legacyPackages &&
      old.instructorPackages === input.instructorPackages &&
      old.handoff === input.handoff &&
      entry.removedKey === removedKey
    );
  });
  if (found) return found.promise;
  const promise = buildFrequentIssuesIndex(input);
  cache.unshift({ input: { ...input }, removedKey, promise });
  cache.splice(4);
  void promise.catch(() => {
    const index = cache.findIndex((entry) => entry.promise === promise);
    if (index >= 0) cache.splice(index, 1);
  });
  return promise;
}
export function clearFrequentIssuesIndexCache(ownerKey?: string): void {
  for (let i = cache.length - 1; i >= 0; i--)
    if (ownerKey === undefined || cache[i].input.ownerKey === ownerKey)
      cache.splice(i, 1);
}

export function analyzeFrequentIssues(
  index: FrequentIssuesIndex,
  filter: FrequentFilter = emptyFrequentFilter,
): FrequentAnalysis {
  const scoped = index.questions.filter((q) => matches(q, filter));
  const scopedKeys = new Set(scoped.map(sourceKey));
  const usableKeys = new Set(
    [...scopedKeys].filter((key) => !index.ambiguousKeys.has(key)),
  );
  const total = usableKeys.size;
  const rows: FrequentRow[] = [];
  for (const row of index.rows) {
    const links = row.links.filter(
      (link) =>
        matches(link.question, filter) &&
        usableKeys.has(sourceKey(link.question)),
    );
    if (!links.length) continue;
    const related = uniqueBy(
      links.map((link) => link.question),
      sourceKey,
    ).sort(compareQuestions);
    const targetKeys = new Set(
      links.filter((link) => link.selector).map(linkKey),
    );
    const wholeKeys = new Set(
      links
        .filter((link) => !link.selector)
        .map((link) => sourceKey(link.question)),
    );
    const sources = uniqueBy(
      links.flatMap((link) => link.sources),
      (s) => canonical(s),
    );
    const excerpts = uniqueBy(
      links.flatMap((link) => link.excerpts),
      (e) => e.id,
    );
    const notes = uniqueBy(
      links
        .filter((link) => link.semanticReason)
        .map((link) => ({
          id: link.id,
          text: link.semanticReason!,
          questionId: link.question.id,
          selector: link.selector,
        })),
      (note) => note.id,
    );
    const reading: FrequentReading = {
      status:
        notes.length || excerpts.some((e) => e.legalStatus === "verified")
          ? "reviewed-links-only"
          : sources.length
            ? "source-only"
            : "missing",
      notes,
      excerpts,
      sources,
    };
    rows.push({
      ...row,
      links,
      questions: related.length,
      rounds: new Set(related.map(roundKey)).size,
      targets: targetKeys.size,
      wholeQuestions: wholeKeys.size,
      latest: `${related[0].source.year}년 ${related[0].source.round}차`,
      related,
      reading,
    });
  }
  rows.sort(
    (a, b) =>
      b.questions - a.questions ||
      b.targets - a.targets ||
      a.title.localeCompare(b.title, "ko"),
  );
  const statusCounts = (lane?: FrequentEvidenceLane): FrequentStatuses => {
    const sets = {
      unknown: new Set<string>(),
      hold: new Set<string>(),
      conflict: new Set<string>(),
      stale: new Set<string>(),
    };
    for (const d of index.diagnostics)
      if (
        (!lane || d.lane === lane) &&
        matches(d.question, filter) &&
        scopedKeys.has(sourceKey(d.question))
      )
        sets[d.status].add(sourceKey(d.question));
    return {
      ...blankStatuses(),
      ...Object.fromEntries(
        Object.entries(sets).map(([key, values]) => [key, values.size]),
      ),
    };
  };
  const coverage = (lane?: FrequentEvidenceLane): FrequentLaneCoverage => {
    const selected = rows.filter((row) => !lane || row.lane === lane);
    const links = selected.flatMap((row) => row.links);
    const covered = new Set(links.map((link) => sourceKey(link.question))).size;
    return {
      total,
      covered,
      coverage: total ? Math.round((100 * covered) / total) : 0,
      unlinked: Math.max(0, total - covered),
      targets: new Set(links.filter((link) => link.selector).map(linkKey)).size,
      wholeQuestions: new Set(
        links
          .filter((link) => !link.selector)
          .map((link) => sourceKey(link.question)),
      ).size,
      statuses: statusCounts(lane),
    };
  };
  const overall = coverage();
  return {
    rows,
    total,
    covered: overall.covered,
    coverage: overall.coverage,
    unlinked: overall.unlinked,
    targets: overall.targets,
    lanes: {
      legacy: coverage("legacy_verified"),
      source: coverage("instructor_source"),
      reviewed: coverage("reviewed_topic"),
    },
    statuses: statusCounts(),
    duplicates: index.duplicates.filter((duplicate) =>
      duplicate.questionIds.some((id) => scoped.some((q) => q.id === id)),
    ),
    ambiguous: [...scopedKeys].filter((key) => index.ambiguousKeys.has(key))
      .length,
  };
}

/** The study list contains only reviewed canonical topics. Source catalog rows
 * remain available in diagnosticAnalysis and never become topics by identity. */
export function analyzeUnifiedFrequentIssues(
  index: FrequentIssuesIndex,
  filter: FrequentFilter = emptyFrequentFilter,
): UnifiedFrequentAnalysis {
  const diagnosticAnalysis = analyzeFrequentIssues(index, filter);
  const semantic = analyzeFrequentIssues(
    {
      ...index,
      rows: index.canonicalRows,
      diagnostics: index.semanticDiagnostics,
    },
    filter,
  );
  const metadata = new Map(index.canonicalRows.map((row) => [row.id, row]));
  const rows: UnifiedFrequentRow[] = semantic.rows.map((row) => {
    const topic = metadata.get(row.id)!;
    return {
      ...row,
      aliases: topic.aliases,
      subjectId: topic.subjectId,
      classificationLevel: topic.classificationLevel,
      studyUnitCodes: topic.studyUnitCodes,
    };
  });
  const levelOrder: Record<FrequentClassificationLevel, number> = {
    topic: 0,
    issue: 1,
    subissue: 2,
    unspecified: 3,
  };
  rows.sort(
    (a, b) =>
      a.subjectId.localeCompare(b.subjectId) ||
      levelOrder[a.classificationLevel] - levelOrder[b.classificationLevel] ||
      b.questions - a.questions ||
      b.rounds - a.rounds ||
      b.related[0].source.year - a.related[0].source.year ||
      b.related[0].source.round.localeCompare(a.related[0].source.round, "ko", {
        numeric: true,
      }) ||
      a.title.localeCompare(b.title, "ko") ||
      a.id.localeCompare(b.id),
  );
  return {
    ...semantic,
    rows,
    wholeQuestions: semantic.lanes.reviewed.wholeQuestions,
    lanes: { ...diagnosticAnalysis.lanes, reviewed: semantic.lanes.reviewed },
    diagnosticAnalysis,
  };
}
