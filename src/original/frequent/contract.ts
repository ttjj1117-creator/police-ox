import { z } from "zod";
import type { Asset, Namespace, Question, OriginalPackage } from "../model";
import {
  canonicalExplanationValue,
  questionFingerprint,
  selectorSchema,
  sourceKey,
  targetText,
  verificationSchema,
  type ExplanationPackage,
  type TargetSelector,
} from "../explanations/contract";
import type { InstructorPackage } from "../instructor/contract";
import { isEligible, units } from "../validation";

const id = z.string().min(1).max(200);
const text = z.string().max(500000);
const version = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const subject = z.enum([
  "constitution",
  "criminal",
  "police",
  "criminology",
  "civil_general",
]);
const sourceKeySchema = z.tuple([
  z.enum(["po", "lieut", "demo"]),
  subject,
  z.number().int(),
  id,
  version,
]);
const binding = {
  questionId: id,
  sourceKey: sourceKeySchema,
  subjectId: subject,
  questionRevision: version,
  gradingRevision: version,
  questionFingerprint: digest,
};
const targetSchema = z
  .object({ selector: selectorSchema, expectedText: text.min(1) })
  .strict();
const referenceSchema = z
  .object({ basisId: id, issueIds: z.array(id).min(1).max(100) })
  .strict();
const references = z.array(referenceSchema).min(1).max(100);
const legacyFields = {
  ...binding,
  explanationId: id,
  revision: version,
  selector: selectorSchema,
  expectedText: text.min(1),
  references,
  verification: verificationSchema,
};
const legacyLinkSchema = z.object(legacyFields).strict();
const locationSchema = z
  .object({
    page: version,
    printedPage: z.union([z.string().max(100), version]).nullable(),
    bbox: z
      .tuple([
        z.number().finite(),
        z.number().finite(),
        z.number().finite(),
        z.number().finite(),
      ])
      .nullable(),
    coordinateSystem: z.literal("pdf-points-top-left").nullable(),
  })
  .strict()
  .refine(
    (v) =>
      !v.bbox ||
      (v.bbox[0] >= 0 &&
        v.bbox[1] >= 0 &&
        v.bbox[2] >= v.bbox[0] &&
        v.bbox[3] >= v.bbox[1]),
    "출처 영역이 올바르지 않습니다.",
  );
const locations = z.array(locationSchema).max(1000);
const sourceType = z.enum(["instructor", "ai_assisted_reference"]);
const citationSchema = z
  .object({
    ...binding,
    citationId: id,
    recordId: id,
    recordRevision: version,
    documentId: id,
    documentSha256: digest,
    sourceType,
    scopeKind: z.enum(["question", "targets"]),
    recordScopeTargets: z.array(targetSchema).max(100),
    blockIndex: z.number().int().nonnegative(),
    characterOffsets: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        unit: z.literal("unicode-code-points"),
        endExclusive: z.literal(true),
      })
      .strict()
      .refine((v) => v.start < v.end, "인용 문자 범위가 올바르지 않습니다."),
    rawCitation: text.min(1),
    sourceLocations: locations,
    locationPrecision: z.enum(["block", "source-block-region", "source-lines"]),
    sourceIdentificationStatus: z.enum(["identifiable", "unresolved"]),
    sourceUnresolvedReasons: z.array(text).max(1000),
    disposition: z.enum([
      "source_linked",
      "identity_hold",
      "explanation_hold",
      "question_ineligible",
      "superseded_span",
    ]),
    reason: text,
    authorityId: id.nullable(),
    legalVerificationStatus: z.literal("not_reviewed"),
    supersededBy: id.nullable(),
    supersedesForAnalysis: z.array(id).max(1000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.scopeKind === "question") !== (v.recordScopeTargets.length === 0))
      ctx.addIssue({
        code: "custom",
        message: "문항 전체와 지문 대상 범위가 일치하지 않습니다.",
      });
    // The final disposition may resolve a raw extractor's unresolved identity.
    if (v.disposition === "source_linked" && !v.authorityId)
      ctx.addIssue({
        code: "custom",
        message: "식별된 출처 연결에는 출처 ID가 필요합니다.",
      });
  });
const evidenceSchema = z
  .object({
    recordId: id,
    blockIndex: z.number().int().nonnegative(),
    citationIds: z.array(id).max(1000),
    reason: text.min(1),
    documentId: id,
    sourceType,
    sourceLocations: locations,
    legalVerificationStatus: z.literal("not_reviewed"),
  })
  .strict();
const reviewedCommon = {
  ...binding,
  selector: selectorSchema,
  expectedText: text.min(1),
  reviewedIssueIds: z.array(id).max(100),
  semanticReason: text.min(1),
  instructorEvidence: z.array(evidenceSchema).max(100),
};
const reviewedLinkSchema = z.discriminatedUnion("evidenceLane", [
  z
    .object({
      ...legacyFields,
      ...reviewedCommon,
      evidenceLane: z.literal("legacy_verified"),
    })
    .strict(),
  z
    .object({
      ...reviewedCommon,
      sourceCitationId: id,
      evidenceLane: z.literal("instructor_context_reviewed"),
      legalVerificationStatus: z.literal("not_reviewed"),
    })
    .strict(),
]);
const packageRefSchema = z
  .object({
    packageId: id,
    packageVersion: version,
    schemaVersion: z.literal("1.0.0"),
  })
  .strict();
const safeUrl = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  }, "http/https 출처만 허용합니다.");
export const frequentIssuesPackageV1Schema = z
  .object({
    format: z.literal("police-frequent-issues-handoff"),
    schemaVersion: z.literal("1.0.0"),
    dataKind: z.enum(["real", "demo"]),
    inputPackages: z
      .object({
        questions: packageRefSchema,
        legacy: packageRefSchema,
        instructor: packageRefSchema,
      })
      .strict(),
    questionIndex: z
      .array(
        z
          .object({
            ...binding,
            eligible: z.boolean(),
            classification: z
              .object({
                studyUnitCode: id.nullable(),
                relatedStudyUnitCodes: z.array(id),
                studyStatus: z.enum(["pending", "confirmed"]),
                bookUnitIds: z.array(id),
                blueprintAreaCode: id.nullable(),
                blueprintStatus: z.enum(["pending", "confirmed"]),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(100000),
    legacyVerifiedLinks: z.array(legacyLinkSchema).max(200000),
    authorityCatalog: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              id,
              kind: z.literal("case"),
              court: id,
              caseNumber: id,
              catalogBasisCandidates: z.array(id).max(1000),
            })
            .strict(),
          z
            .object({
              id,
              kind: z.literal("statute"),
              titleKey: text.min(1),
              articleTrail: z.array(text).max(100),
              qualifiers: z.array(text).max(100),
              version: text.nullable(),
              compoundExpression: text.optional(),
              catalogBasisCandidates: z.array(id).max(1000),
            })
            .strict(),
        ]),
      )
      .max(100000),
    legacyCatalog: z
      .object({
        bases: z
          .array(
            z
              .object({
                id,
                revision: version,
                type: z.enum([
                  "case",
                  "constitutional",
                  "law",
                  "theory",
                  "demo",
                ]),
                title: text.min(1),
                identity: z
                  .object({
                    authority: id,
                    number: id.nullable(),
                    date: z.string().nullable(),
                  })
                  .strict(),
                sourceUrl: safeUrl.nullable(),
                temporalBasis: z.enum(["exam", "current"]),
                asOfDate: z.string(),
                verification: verificationSchema,
              })
              .strict(),
          )
          .max(50000),
        issues: z
          .array(
            z
              .object({
                id,
                revision: version,
                basisId: id,
                title: text.min(1),
                locator: text.min(1),
                verification: verificationSchema,
              })
              .strict(),
          )
          .max(100000),
      })
      .strict(),
    sourceCitationOccurrences: z.array(citationSchema).max(300000),
    reviewedLearningTopics: z
      .array(
        z
          .object({
            id,
            title: text.min(1),
            subjectId: subject,
            basis: z.literal(
              "context_review_of_existing_explanation_and_target",
            ),
            frequency: z
              .object({
                questions: z.number().int().nonnegative(),
                rounds: z.number().int().nonnegative(),
                targets: z.number().int().nonnegative(),
                latest: text,
                questionIds: z.array(id),
              })
              .strict(),
            links: z.array(reviewedLinkSchema).min(1).max(10000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();

export type FrequentIssuesPackageV1 = z.infer<typeof frequentIssuesPackageV1Schema>;
export type FrequentCitation =
  FrequentIssuesPackageV1["sourceCitationOccurrences"][number];
export type FrequentLegacyLink =
  FrequentIssuesPackageV1["legacyVerifiedLinks"][number];
export type FrequentReviewedLink =
  FrequentIssuesPackageV1["reviewedLearningTopics"][number]["links"][number];
export type FrequentLocation = z.infer<typeof locationSchema>;

/** Structural and referential validation never upgrades a legal review status. */
function parseFrequentIssuesPackageV1(
  value: unknown,
): FrequentIssuesPackageV1 {
  const p = frequentIssuesPackageV1Schema.parse(value);
  const unique = <T>(items: T[], key: (item: T) => string, label: string) => {
    const map = new Map<string, T>();
    for (const item of items) {
      const k = key(item);
      if (map.has(k)) throw Error(`${label}: 중복 ID ${k}`);
      map.set(k, item);
    }
    return map;
  };
  const questions = unique(p.questionIndex, (r) => r.questionId, "문항");
  const bases = unique(p.legacyCatalog.bases, (r) => r.id, "기존 근거");
  const issues = unique(p.legacyCatalog.issues, (r) => r.id, "기존 쟁점");
  const authorities = unique(p.authorityCatalog, (r) => r.id, "인용 출처");
  const legacy = unique(
    p.legacyVerifiedLinks,
    (r) => r.explanationId,
    "기존 해설 연결",
  );
  const citations = unique(
    p.sourceCitationOccurrences,
    (r) => r.citationId,
    "인용",
  );
  unique(p.reviewedLearningTopics, (r) => r.id, "학습 쟁점");
  const equal = (a: unknown, b: unknown) =>
    canonicalExplanationValue(a) === canonicalExplanationValue(b);
  const checkBinding = (
    r:
      | z.infer<typeof legacyLinkSchema>
      | FrequentCitation
      | FrequentReviewedLink,
  ) => {
    const q = questions.get(r.questionId);
    if (
      !q ||
      [
        "subjectId",
        "questionRevision",
        "gradingRevision",
        "questionFingerprint",
        "sourceKey",
      ].some(
        (key) => !equal(q[key as keyof typeof q], r[key as keyof typeof r]),
      )
    )
      throw Error(`문항 인덱스 연결 불일치: ${r.questionId}`);
  };
  for (const q of p.questionIndex)
    if (
      q.sourceKey[1] !== q.subjectId ||
      (q.sourceKey[0] === "demo") !== (p.dataKind === "demo")
    )
      throw Error(`문항 출처·자료 영역 불일치: ${q.questionId}`);
  for (const issue of issues.values())
    if (!bases.has(issue.basisId)) throw Error(`쟁점 근거 없음: ${issue.id}`);
  for (const link of legacy.values()) {
    checkBinding(link);
    for (const ref of link.references) {
      if (!bases.has(ref.basisId))
        throw Error(`기존 근거 없음: ${ref.basisId}`);
      for (const issue of ref.issueIds)
        if (issues.get(issue)?.basisId !== ref.basisId)
          throw Error(`기존 쟁점 연결 불일치: ${issue}`);
    }
  }
  for (const citation of citations.values()) {
    checkBinding(citation);
    if (citation.authorityId && !authorities.has(citation.authorityId))
      throw Error(`인용 출처 없음: ${citation.citationId}`);
    if (citation.supersededBy && !citations.has(citation.supersededBy))
      throw Error(`교체 인용 없음: ${citation.citationId}`);
    for (const id of citation.supersedesForAnalysis)
      if (!citations.has(id)) throw Error(`교체 대상 없음: ${id}`);
  }
  for (const topic of p.reviewedLearningTopics)
    for (const link of topic.links) {
      checkBinding(link);
      if (topic.subjectId !== link.subjectId)
        throw Error(`학습 쟁점 과목 불일치: ${topic.id}`);
      if (link.evidenceLane === "legacy_verified") {
        const original = legacy.get(link.explanationId);
        if (
          !original ||
          !equal(
            original,
            Object.fromEntries(
              Object.keys(original).map((key) => [
                key,
                link[key as keyof typeof link],
              ]),
            ),
          )
        )
          throw Error(`검토 쟁점의 기존 연결 불일치: ${topic.id}`);
        const linkedIssues = new Set(
          link.references.flatMap((ref) => ref.issueIds),
        );
        if (link.reviewedIssueIds.some((id) => !linkedIssues.has(id)))
          throw Error(`검토 쟁점 범위 불일치: ${topic.id}`);
      } else if (
        citations.get(link.sourceCitationId)?.questionId !== link.questionId
      )
        throw Error(`검토 쟁점 인용 대상 불일치: ${topic.id}`);
      for (const evidence of link.instructorEvidence)
        for (const id of evidence.citationIds) {
          const citation = citations.get(id);
          if (
            !citation ||
            citation.questionId !== link.questionId ||
            citation.recordId !== evidence.recordId ||
            citation.documentId !== evidence.documentId ||
            citation.blockIndex !== evidence.blockIndex
          )
            throw Error(`검토 문단 인용 불일치: ${id}`);
        }
    }
  return p;
}

const semanticEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question_text"),
    sourceFileName: text.min(1).nullable(),
    sourceLocations: locations,
    contentSha256: digest,
  }).strict(),
  z.object({
    kind: z.literal("instructor_block"),
    recordId: id,
    recordRevision: version,
    documentId: id,
    documentSha256: digest,
    sourceType,
    blockIndex: z.number().int().nonnegative(),
    expectedText: text.min(1),
    contentSha256: digest,
    sourceLocations: locations.min(1),
  }).strict(),
]);
export const semanticFrequentLinkSchema = z.object({
  ...binding,
  id,
  selector: selectorSchema.nullable(),
  expectedText: text.min(1),
  evidenceLane: z.literal("semantic_reviewed"),
  classificationStatus: z.enum(["confirmed", "pending", "hold"]),
  semanticReason: text.min(1),
  legalVerificationStatus: z.literal("not_reviewed"),
  evidence: z.array(semanticEvidenceSchema).max(100),
  citationIds: z.array(id).max(1000).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.classificationStatus === "confirmed" && !v.evidence.length)
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "의미 분류 확인에는 실제 원문 또는 매칭된 해설 문단 근거가 필요합니다." });
});
export type SemanticFrequentEvidence = z.infer<typeof semanticEvidenceSchema>;
export type SemanticFrequentLink = z.infer<typeof semanticFrequentLinkSchema>;
export type CommonFrequentTopicLink = FrequentReviewedLink | SemanticFrequentLink;
export const frequentClassificationLevelSchema = z.enum(["topic", "issue", "subissue"]);
export type FrequentClassificationLevel = z.infer<typeof frequentClassificationLevelSchema> | "unspecified";
const canonicalTopicSchema = z.object({
  id,
  title: text.min(1),
  subjectId: subject,
  aliases: z.array(text.min(1)).max(100),
  classificationLevel: frequentClassificationLevelSchema,
  studyUnitCodes: z.array(id).max(100),
  links: z.array(z.union([reviewedLinkSchema, semanticFrequentLinkSchema])).max(10000),
}).strict();
export type CanonicalFrequentTopic = Omit<z.infer<typeof canonicalTopicSchema>, "classificationLevel"> & {
  classificationLevel: FrequentClassificationLevel;
};
export const frequentIssuesPackageV11Schema = frequentIssuesPackageV1Schema.extend({
  schemaVersion: z.literal("1.1.0"),
  handoffRevision: version,
  canonicalLearningTopics: z.array(canonicalTopicSchema).max(10000),
}).strict();
export type FrequentIssuesPackageV11 = z.infer<typeof frequentIssuesPackageV11Schema>;
export const frequentIssuesPackageSchema = z.discriminatedUnion("schemaVersion", [
  frequentIssuesPackageV1Schema,
  frequentIssuesPackageV11Schema,
]);
export type FrequentIssuesPackage = z.infer<typeof frequentIssuesPackageSchema>;

/** Retains v1.0's exact strict schema and all of its reference checks. */
export function parseFrequentIssuesPackage(value: unknown): FrequentIssuesPackage {
  const p = frequentIssuesPackageSchema.parse(value);
  if (p.schemaVersion === "1.0.0") return parseFrequentIssuesPackageV1(p);
  const { handoffRevision: _revision, canonicalLearningTopics: topics, ...legacy } = p;
  parseFrequentIssuesPackageV1({ ...legacy, schemaVersion: "1.0.0" });
  const topicIds = new Set<string>();
  const linkIds = new Set<string>();
  const questions = new Map(p.questionIndex.map((q) => [q.questionId, q]));
  const citations = new Map(p.sourceCitationOccurrences.map((c) => [c.citationId, c]));
  const equal = (a: unknown, b: unknown) => canonicalExplanationValue(a) === canonicalExplanationValue(b);
  for (const [ti, topic] of topics.entries()) {
    const path = `canonicalLearningTopics.${ti}`;
    if (topicIds.has(topic.id)) throw Error(`${path}.id: 중복 학습 쟁점 ID ${topic.id}`);
    topicIds.add(topic.id);
    for (const [field, values] of [["aliases", topic.aliases], ["studyUnitCodes", topic.studyUnitCodes]] as const)
      if (new Set(values).size !== values.length)
        throw Error(`${path}.${field}: 중복 값`);
    for (const code of topic.studyUnitCodes)
      if (units.find((u) => u.code === code)?.subjectId !== topic.subjectId)
        throw Error(`${path}.studyUnitCodes: 존재하지 않거나 과목이 다른 단원 ${code}`);
    for (const [li, link] of topic.links.entries()) {
      const lp = `${path}.links.${li}`;
      if (link.subjectId !== topic.subjectId) throw Error(`${lp}.subjectId: 학습 쟁점 과목 불일치`);
      if (link.evidenceLane !== "semantic_reviewed") continue;
      if (linkIds.has(link.id)) throw Error(`${lp}.id: 중복 의미 연결 ID ${link.id}`);
      linkIds.add(link.id);
      const q = questions.get(link.questionId);
      if (!q || Object.keys(binding).some((key) => !equal(q[key as keyof typeof q], link[key as keyof typeof link])))
        throw Error(`${lp}: 문항 인덱스 연결 불일치 ${link.questionId}`);
      for (const cid of link.citationIds ?? [])
        if (citations.get(cid)?.questionId !== link.questionId)
          throw Error(`${lp}.citationIds: 인용 대상 불일치 ${cid}`);
      if (new Set(link.citationIds ?? []).size !== (link.citationIds?.length ?? 0))
        throw Error(`${lp}.citationIds: 중복 인용 ID`);
      if (new Set(link.evidence.map(canonicalExplanationValue)).size !== link.evidence.length)
        throw Error(`${lp}.evidence: 동일 근거를 중복 등록하지 마세요.`);
    }
  }
  for (const old of p.reviewedLearningTopics)
    if (!topicIds.has(old.id))
      throw Error(`canonicalLearningTopics: 기존 학습 쟁점 ID를 보존하세요: ${old.id}`);
  // Old links inside the canonical catalog keep the original strict reader rules.
  parseFrequentIssuesPackageV1({
    ...legacy,
    schemaVersion: "1.0.0",
    reviewedLearningTopics: topics.flatMap((topic) => {
      const links = topic.links.filter((l): l is FrequentReviewedLink => l.evidenceLane !== "semantic_reviewed");
      return links.length ? [{
        id: topic.id, title: topic.title, subjectId: topic.subjectId,
        basis: "context_review_of_existing_explanation_and_target",
        frequency: { questions: 0, rounds: 0, targets: 0, latest: "", questionIds: [] },
        links,
      }] : [];
    }),
  });
  return p;
}

/** Accept a parsed handoff. Source identities never become canonical issue IDs. */
export function getFrequentLearningTopics(p: FrequentIssuesPackage): CanonicalFrequentTopic[] {
  return p.schemaVersion === "1.1.0" ? p.canonicalLearningTopics : p.reviewedLearningTopics.map((topic) => ({
    id: topic.id, title: topic.title, subjectId: topic.subjectId,
    aliases: [], classificationLevel: "unspecified", studyUnitCodes: [], links: topic.links,
  }));
}

/** Whole-question meaning pins structured original content, not an invented target. */
export function frequentQuestionText(q: Question): string {
  return canonicalExplanationValue({ body: q.body, choices: q.choices });
}
export async function frequentContentSha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Runtime check reused by analysis. A failure excludes a semantic link, never grants legal verification. */
export async function semanticFrequentLinkMismatch(
  link: SemanticFrequentLink,
  q: Question,
  assets: Asset[],
  instructorPackages: InstructorPackage[],
): Promise<string | undefined> {
  const equal = (a: unknown, b: unknown) => canonicalExplanationValue(a) === canonicalExplanationValue(b);
  if (link.questionId !== q.id || link.subjectId !== q.subjectId ||
      link.questionRevision !== q.revision || link.gradingRevision !== q.gradingRevision ||
      canonicalExplanationValue(link.sourceKey) !== sourceKey(q)) return "문항·채점 버전·출처 불일치";
  if (link.questionFingerprint !== await questionFingerprint(q, assets)) return "문항 fingerprint 불일치";
  try {
    if (link.expectedText !== (link.selector === null ? frequentQuestionText(q) : targetText(q, link.selector)))
      return "원문 대상 expectedText 불일치";
  } catch { return "원문 대상 selector 불일치"; }
  if (link.classificationStatus === "confirmed" && !link.evidence.length) return "의미 확인 근거 없음";
  for (const proof of link.evidence) {
    if (proof.kind === "question_text") {
      if (proof.contentSha256 !== await frequentContentSha256(link.expectedText)) return "원문 근거 내용 해시 불일치";
      const pdf = q.source.questionPdf;
      if (pdf) {
        if (proof.sourceFileName !== pdf.fileName || !proof.sourceLocations.length || proof.sourceLocations.some((l) => !pdf.pages.includes(l.page) || l.bbox !== null || l.coordinateSystem !== null))
          return "원문 근거 파일·페이지 위치 불일치";
      } else if (proof.sourceFileName !== null || proof.sourceLocations.length) return "PDF 없는 원문의 근거 위치 불일치";
      continue;
    }
    const candidates = instructorPackages.flatMap((p) => p.records.filter((r) => r.id === proof.recordId).map((record) => ({ p, record, document: p.documents.find((d) => d.documentId === record.documentId) })));
    if (!candidates.length) return "매칭된 해설 레코드 없음";
    const first = candidates[0];
    if (candidates.some((c) => !equal(c.record, first.record) || !equal(c.document, first.document))) return "해설 레코드·문서 충돌";
    const { record, document } = first;
    if (!document || candidates.some((c) => c.p.dataKind !== (q.source.examCode === "demo" ? "demo" : "real")) ||
        record.questionId !== q.id || record.subjectId !== q.subjectId ||
        record.questionRevision !== q.revision || record.gradingRevision !== q.gradingRevision || record.questionFingerprint !== link.questionFingerprint ||
        !equal(record.officialAnswer, q.officialAnswer) ||
        record.sourceKey.examCode !== q.source.examCode || record.sourceKey.year !== q.source.year || record.sourceKey.round !== q.source.round || record.sourceKey.questionNumber !== q.source.questionNumber)
      return "해설 문항 매칭·자료 영역 불일치";
    if (record.revision !== proof.recordRevision || record.documentId !== proof.documentId || document.sha256 !== proof.documentSha256 ||
        (document.sourceType ?? "instructor") !== proof.sourceType) return "해설 레코드·문서 버전 불일치";
    if (document.exam.examCode !== q.source.examCode || document.exam.subjectId !== q.subjectId || document.exam.year !== q.source.year || document.exam.round !== q.source.round || proof.sourceLocations.some((l) => l.page > document.pageCount)) return "해설 문서 시험·과목·출처 위치 불일치";
    if (link.classificationStatus === "confirmed" && document.status !== "checked") return "해설 문서 미확인";
    if (link.classificationStatus === "confirmed" && (record.extraction.status !== "checked" || record.matching.status !== "checked")) return "해설 추출·문항 매칭 미확인";
    try {
      for (const t of record.scope.targets) if (targetText(q, t.selector) !== t.expectedText) return "해설 대상 원문 불일치";
    } catch { return "해설 대상 선택자 불일치"; }
    if (record.scope.kind === "targets" && (link.selector === null || !record.scope.targets.some((t) => equal(t.selector, link.selector) && t.expectedText === link.expectedText)))
      return "해설의 확인 대상 범위 불일치";
    const block = record.blocks[proof.blockIndex];
    if (!block || block.type !== "text" || block.text !== proof.expectedText || proof.contentSha256 !== await frequentContentSha256(block.text)) return "해설 문단 expectedText·해시 불일치";
    if (!equal(proof.sourceLocations, block.locations.length ? block.locations : record.locations)) return "해설 문단 출처 위치 불일치";
  }
  return undefined;
}

export interface FrequentValidationContext {
  namespace: Namespace;
  questions: Question[];
  assets?: Asset[];
  questionPackages: OriginalPackage[];
  legacyPackages: ExplanationPackage[];
  instructorPackages: InstructorPackage[];
}

/** Full source validation for the data CLI. Importers still use the strict structural reader and runtime recheck. */
export async function validateFrequentIssuesPackage(value: unknown, input: FrequentValidationContext): Promise<FrequentIssuesPackage> {
  const p = parseFrequentIssuesPackage(value), assets = input.assets ?? [];
  const equal = (a: unknown, b: unknown) => canonicalExplanationValue(a) === canonicalExplanationValue(b);
  const sourceRecords = <T,>(items: T[], key: (item: T) => string, label: string) => {
    const map = new Map<string, T>();
    for (const item of items) {
      const id = key(item), old = map.get(id);
      if (old && !equal(old, item)) throw Error(`${label}: 원천 패키지 사이의 동일 ID 내용 충돌 ${id}`);
      map.set(id, item);
    }
    return map;
  };
  if (p.dataKind !== input.namespace) throw Error("dataKind: 실제/시연 자료 영역 불일치");
  for (const [name, packages] of [["questions", input.questionPackages], ["legacy", input.legacyPackages], ["instructor", input.instructorPackages]] as const) {
    const ref = p.inputPackages[name];
    const matched = packages.filter((v) => v.packageId === ref.packageId && v.packageVersion === ref.packageVersion && v.schemaVersion === ref.schemaVersion);
    if (!matched.length) throw Error(`inputPackages.${name}: 지정한 원천 패키지·버전이 입력에 없습니다: ${ref.packageId}@${ref.packageVersion}`);
    if (packages.some((v) => v.dataKind !== p.dataKind)) throw Error(`inputPackages.${name}: 자료 영역 혼합`);
    if (matched.some((v) => !equal(v, matched[0]))) throw Error(`inputPackages.${name}: 동일 원천 버전 내용 충돌`);
  }
  const questions = new Map<string, Question>();
  for (const q of input.questions) {
    if (questions.has(q.id) && !equal(questions.get(q.id), q)) throw Error(`questions: 동일 ID 내용 충돌 ${q.id}`);
    questions.set(q.id, q);
  }
  for (const [i, binding] of p.questionIndex.entries()) {
    const q = questions.get(binding.questionId), path = `questionIndex.${i}`;
    if (!q || q.subjectId !== binding.subjectId || sourceKey(q) !== canonicalExplanationValue(binding.sourceKey) || q.revision !== binding.questionRevision || q.gradingRevision !== binding.gradingRevision || await questionFingerprint(q, assets) !== binding.questionFingerprint)
      throw Error(`${path}: 실제 원문·버전·fingerprint 불일치 ${binding.questionId}`);
    if (binding.eligible !== isEligible(q, p.dataKind)) throw Error(`${path}.eligible: 실제 출제 가능 상태 불일치`);
    if (!equal(binding.classification, q.classification)) throw Error(`${path}.classification: 실제 원문 단원 분류 불일치`);
  }
  const sourceBases = sourceRecords(input.legacyPackages.flatMap((s) => s.bases), (b) => b.id, "legacy.bases");
  const sourceIssues = sourceRecords(input.legacyPackages.flatMap((s) => s.issues), (i) => i.id, "legacy.issues");
  for (const [i, basis] of p.legacyCatalog.bases.entries()) {
    const actual = sourceBases.get(basis.id);
    if (!actual || Object.entries(basis).some(([k, v]) => !equal(actual[k as keyof typeof actual], v))) throw Error(`legacyCatalog.bases.${i}: 실제 기존 근거 내용·검증 상태 불일치 ${basis.id}`);
  }
  for (const [i, issue] of p.legacyCatalog.issues.entries()) {
    const actual = sourceIssues.get(issue.id);
    if (!actual || Object.entries(issue).some(([k, v]) => !equal(actual[k as keyof typeof actual], v))) throw Error(`legacyCatalog.issues.${i}: 실제 기존 쟁점 내용·검증 상태 불일치 ${issue.id}`);
  }
  const explanations = sourceRecords(input.legacyPackages.flatMap((s) => s.explanations), (e) => e.id, "legacy.explanations");
  for (const [i, link] of p.legacyVerifiedLinks.entries()) {
    const original = explanations.get(link.explanationId), q = questions.get(link.questionId);
    if (!q || !original || original.revision !== link.revision || Object.entries(link).some(([k, v]) => !["explanationId", "sourceKey"].includes(k) && !equal(original[k as keyof typeof original], v)) || sourceKey(q) !== canonicalExplanationValue(link.sourceKey))
      throw Error(`legacyVerifiedLinks.${i}: 실제 기존 해설 연결 불일치 ${link.explanationId}`);
    if (targetText(q, link.selector) !== link.expectedText) throw Error(`legacyVerifiedLinks.${i}.expectedText: 실제 원문 불일치`);
  }
  const records = sourceRecords(input.instructorPackages.flatMap((s) => s.records), (r) => r.id, "instructor.records");
  const documents = sourceRecords(input.instructorPackages.flatMap((s) => s.documents), (d) => d.documentId, "instructor.documents");
  for (const [i, citation] of p.sourceCitationOccurrences.entries()) {
    const r = records.get(citation.recordId), d = documents.get(citation.documentId), block = r?.blocks[citation.blockIndex];
    const q = questions.get(citation.questionId), path = `sourceCitationOccurrences.${i}`;
    if (!q || !r || !d || r.questionId !== q.id || r.revision !== citation.recordRevision || r.documentId !== citation.documentId || d.sha256 !== citation.documentSha256 || (d.sourceType ?? "instructor") !== citation.sourceType || !block || block.type !== "text")
      throw Error(`${path}: 실제 해설 문서·레코드·문단 불일치 ${citation.citationId}`);
    const offsets = citation.characterOffsets;
    if ([...block.text].slice(offsets.start, offsets.end).join("") !== citation.rawCitation) throw Error(`${path}.characterOffsets: 실제 인용 문자 범위 불일치`);
    if (citation.scopeKind !== r.scope.kind || !equal(citation.recordScopeTargets, r.scope.targets)) throw Error(`${path}.recordScopeTargets: 실제 해설 범위 불일치`);
    if (citation.locationPrecision === "block" && !equal(citation.sourceLocations, block.locations.length ? block.locations : r.locations)) throw Error(`${path}.sourceLocations: 실제 해설 문단 위치 불일치`);
    if (citation.sourceLocations.some((l) => l.page > d.pageCount)) throw Error(`${path}.sourceLocations: 문서 페이지 범위 초과`);
  }
  for (const [ti, topic] of getFrequentLearningTopics(p).entries())
    for (const [li, link] of topic.links.entries()) {
      const path = `${p.schemaVersion === "1.1.0" ? "canonicalLearningTopics" : "reviewedLearningTopics"}.${ti}.links.${li}`;
      const q = questions.get(link.questionId);
      if (!q) throw Error(`${path}.questionId: 실제 원문 없음`);
      if (link.evidenceLane === "semantic_reviewed") {
        const reason = await semanticFrequentLinkMismatch(link, q, assets, input.instructorPackages);
        if (reason) throw Error(`${path}: ${reason}`);
      } else {
        if (targetText(q, link.selector) !== link.expectedText) throw Error(`${path}.expectedText: 실제 원문 불일치`);
        for (const evidence of link.instructorEvidence) {
          const r = records.get(evidence.recordId), block = r?.blocks[evidence.blockIndex];
          if (!r || r.questionId !== q.id || r.documentId !== evidence.documentId || !block || block.type !== "text") throw Error(`${path}.instructorEvidence: 실제 해설 문단 없음`);
          if (!equal(evidence.sourceLocations, block.locations.length ? block.locations : r.locations)) throw Error(`${path}.instructorEvidence: 실제 해설 문단 위치 불일치`);
        }
      }
    }
  return p;
}

export type FrequentEvidenceLane =
  | "legacy_verified"
  | "instructor_source"
  | "reviewed_topic";
export interface FrequentFilter {
  subjectId: string;
  unitId: string;
  examCode: string;
  year: string;
  round: string;
}
export const emptyFrequentFilter: FrequentFilter = {
  subjectId: "",
  unitId: "",
  examCode: "",
  year: "",
  round: "",
};
export type FrequentStatus = "unknown" | "hold" | "conflict" | "stale";
export type FrequentStatuses = Record<FrequentStatus, number>;
export interface FrequentSource {
  id: string;
  title: string;
  kind: "legacy" | "instructor";
  sourceType?: "instructor" | "ai_assisted_reference";
  legalStatus: "verified" | "not_reviewed";
  basisId?: string;
  issueId?: string;
  recordId?: string;
  documentId?: string;
  sourceUrl?: string | null;
  locator?: string;
  locations: FrequentLocation[];
  locationPrecision?: string;
}
export interface ReadingNote {
  id: string;
  text: string;
  questionId: string;
  selector: TargetSelector | null;
}
export interface ReadingExcerpt {
  id: string;
  title: string;
  text: string;
  kind: "verified-excerpt" | "instructor-context";
  questionId: string;
  selector: TargetSelector | null;
  legalStatus: "verified" | "not_reviewed";
  sourceId: string;
}
export interface FrequentReading {
  status: "reviewed-links-only" | "source-only" | "missing";
  notes: ReadingNote[];
  excerpts: ReadingExcerpt[];
  sources: FrequentSource[];
}
export interface FrequentLink {
  id: string;
  question: Question;
  selector: TargetSelector | null;
  expectedText: string | null;
  evidenceLane: FrequentEvidenceLane;
  legalStatus: "verified" | "not_reviewed";
  semanticReason?: string;
  sources: FrequentSource[];
  excerpts: ReadingExcerpt[];
}
export interface FrequentRow {
  key: string;
  id: string;
  title: string;
  kind: "legacy-issue" | "legacy-basis" | "reviewed-topic" | "authority";
  lane: FrequentEvidenceLane;
  basisId?: string;
  questions: number;
  rounds: number;
  targets: number;
  wholeQuestions: number;
  latest: string;
  related: Question[];
  links: FrequentLink[];
  reading: FrequentReading;
}
export interface FrequentLaneCoverage {
  total: number;
  covered: number;
  coverage: number;
  unlinked: number;
  targets: number;
  wholeQuestions: number;
  statuses: FrequentStatuses;
}
export interface FrequentAnalysis {
  rows: FrequentRow[];
  total: number;
  covered: number;
  coverage: number;
  unlinked: number;
  targets: number;
  lanes: {
    legacy: FrequentLaneCoverage;
    source: FrequentLaneCoverage;
    reviewed: FrequentLaneCoverage;
  };
  statuses: FrequentStatuses;
  duplicates: { questionIds: string[]; conflict: boolean }[];
  ambiguous: number;
}
