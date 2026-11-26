import { z } from "zod";
import type { Question } from "../model";
import {
  canonicalExplanationValue,
  selectorSchema,
  verificationSchema,
  type TargetSelector,
} from "../explanations/contract";

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
export const frequentIssuesPackageSchema = z
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

export type FrequentIssuesPackage = z.infer<typeof frequentIssuesPackageSchema>;
export type FrequentCitation =
  FrequentIssuesPackage["sourceCitationOccurrences"][number];
export type FrequentLegacyLink =
  FrequentIssuesPackage["legacyVerifiedLinks"][number];
export type FrequentReviewedLink =
  FrequentIssuesPackage["reviewedLearningTopics"][number]["links"][number];
export type FrequentLocation = z.infer<typeof locationSchema>;

/** Structural and referential validation never upgrades a legal review status. */
export function parseFrequentIssuesPackage(
  value: unknown,
): FrequentIssuesPackage {
  const p = frequentIssuesPackageSchema.parse(value);
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
