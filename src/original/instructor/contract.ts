import { z } from "zod";
import type { Asset, Namespace, Question } from "../model";
import {
  canonicalExplanationValue,
  questionFingerprint,
  selectorSchema,
  targetText,
} from "../explanations/contract";

export const MAX_INSTRUCTOR_BYTES = 32 * 1024 * 1024;
export const MAX_INSTRUCTOR_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 10 * 1024 * 1024;
const id = z.string().min(1).max(200);
const text = z.string().max(500000);
const version = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const metadata = z.record(z.unknown());
const httpUrl = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
    );
  }, "출처 URL은 http/https만 허용합니다.");
const subject = z.enum([
  "constitution",
  "criminal",
  "police",
  "criminology",
  "civil_general",
]);
const sourceKeySchema = z
  .object({
    examCode: z.enum(["po", "lieut", "demo"]),
    year: z.number().int(),
    round: id,
    questionNumber: version,
    booklet: z.string().nullable().optional(),
  })
  .strict();
const targetSchema = z
  .object({ selector: selectorSchema, expectedText: text })
  .strict();
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
    (l) =>
      !l.bbox ||
      (l.bbox[0] >= 0 &&
        l.bbox[1] >= 0 &&
        l.bbox[2] >= l.bbox[0] &&
        l.bbox[3] >= l.bbox[1]),
    "잘못된 출처 영역입니다.",
  );
const locations = z.array(locationSchema).max(1000);
const textBlock = z
  .object({
    type: z.literal("text"),
    role: z.enum([
      "explanation",
      "source_judgment",
      "quotation",
      "source_question",
    ]),
    text: text.min(1),
    locations,
    sourceLineRefs: z
      .array(
        z
          .object({ page: version, lineIndex: z.number().int().nonnegative() })
          .strict(),
      )
      .max(20000)
      .optional(),
  })
  .strict();
const imageBlock = z
  .object({
    type: z.literal("image"),
    role: z.literal("source_layout"),
    assetId: id,
    alt: text,
    locations,
  })
  .strict();
const checkSchema = z.object({
  status: z.enum(["pending", "checked", "hold"]),
  method: text.nullable(),
  checkedAt: timestamp.nullable(),
  reasons: z.array(text).max(1000),
});
const extractionSchema = checkSchema.extend({ tool: text.nullable() }).strict();
const matchingSchema = checkSchema.extend({ evidence: metadata }).strict();
const documentSchema = z
  .object({
    documentId: id,
    originalFileName: text,
    sha256: digest,
    byteSize: version,
    pageCount: version,
    relativePath: text,
    duplicatePaths: z.array(text),
    title: text.nullable(),
    academy: text.nullable(),
    instructor: text.nullable(),
    edition: text.nullable(),
    authoredDate: text.nullable(),
    sourceUrl: httpUrl.nullable(),
    rightsNotice: text.nullable(),
    exam: z
      .object({
        examCode: z.enum(["po", "lieut", "demo"]),
        subjectId: subject,
        year: z.number().int(),
        round: id,
        booklet: z.string().nullable().optional(),
        examName: text.optional(),
      })
      .strict(),
    metadataEvidence: z.array(metadata).max(1000),
    status: z.enum(["pending", "checked", "hold"]),
    sourceType: z.enum(["instructor", "ai_assisted_reference"]).optional(),
    sourceGenerator: text.optional(),
    authoredTimestamp: text.optional(),
    rawCache: text.optional(),
  })
  .strict();
const officialAnswer = z
  .object({
    status: z.enum(["final", "provisional", "missing", "demo"]),
    kind: z.enum([
      "single",
      "multiple",
      "all_correct",
      "excluded",
      "unresolved",
    ]),
    acceptedChoices: z.array(z.number().int().min(1).max(4)).max(4),
  })
  .strict();
const recordSchema = z
  .object({
    id,
    revision: version,
    documentId: id,
    questionId: id,
    subjectId: subject,
    questionRevision: version,
    gradingRevision: version,
    questionFingerprint: digest,
    sourceKey: sourceKeySchema,
    scope: z
      .object({
        kind: z.enum(["question", "targets"]),
        targets: z.array(targetSchema).max(100),
      })
      .strict()
      .refine(
        (v) =>
          v.kind === "question" ? v.targets.length === 0 : v.targets.length > 0,
        "해설 범위가 올바르지 않습니다.",
      ),
    blocks: z
      .array(z.discriminatedUnion("type", [textBlock, imageBlock]))
      .min(1)
      .max(1000),
    locations: locations.min(1),
    sourceSymbols: z
      .object({
        answer: z
          .object({
            rawText: text,
            numbers: z.array(z.number().int().min(1).max(4)).max(4),
          })
          .strict()
          .nullable(),
        judgments: z
          .array(
            z
              .object({ rawText: text, target: selectorSchema.nullable() })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    officialAnswer,
    extraction: extractionSchema,
    matching: matchingSchema,
    legalVerification: z
      .object({
        status: z.literal("not_reviewed"),
        reviewedAt: z.null(),
        lawAsOf: z.null(),
      })
      .strict(),
    sourceQuestionText: text.nullable(),
    notes: z.array(text).max(1000),
  })
  .strict();
const assetSchema = z
  .object({
    assetId: id,
    mimeType: z.enum(["image/png", "image/jpeg"]),
    sha256: digest,
    relativePath: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (v) =>
          !v.includes("\\") &&
          !v.startsWith("/") &&
          !v.includes(":") &&
          !v.split("/").includes(".."),
        "자산 상대 경로가 올바르지 않습니다.",
      ),
    byteSize: version.max(MAX_INSTRUCTOR_ASSET_BYTES),
    documentId: id,
    questionId: id.optional(),
    location: locationSchema,
    alt: text,
    base64: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_INSTRUCTOR_ASSET_BYTES / 3) * 4)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict();
const coverageSchema = z
  .object({
    documentId: id,
    questionId: id,
    status: z.enum(["pending", "checked", "hold"]).optional(),
    narrativeTargets: z.array(targetSchema).optional(),
    judgmentOnlyTargets: z.array(targetSchema).optional(),
    missingNarrativeTargets: z.array(targetSchema).optional(),
    wholeQuestionOnly: z.boolean().optional(),
    answerChoiceOnly: z.boolean().optional(),
  })
  .passthrough();
export const instructorPackageSchema = z
  .object({
    format: z.literal("police-instructor-explanations-intermediate"),
    schemaVersion: z.literal("1.0.0"),
    packageId: id,
    packageVersion: version,
    exportedAt: timestamp,
    dataKind: z.enum(["real", "demo"]),
    questionPackages: z.array(metadata).max(1000),
    documents: z.array(documentSchema).min(1).max(2000),
    records: z.array(recordSchema).min(1).max(50000),
    assets: z.array(assetSchema).max(2000),
    citationMentions: z.array(metadata).max(200000),
    coverage: z.array(coverageSchema).max(50000),
    holds: z.array(metadata).max(50000),
    reviews: z.array(metadata).max(10000),
    compatibility: metadata,
    statistics: metadata,
  })
  .strict();
export type InstructorPackage = z.infer<typeof instructorPackageSchema>;
export type InstructorRecord = InstructorPackage["records"][number];
export type InstructorDocument = InstructorPackage["documents"][number];
export type InstructorAsset = InstructorPackage["assets"][number];
export type InstructorStatus = "checked" | "pending" | "hold" | "stale";
export interface ResolvedInstructorRecord {
  record: InstructorRecord;
  document: InstructorDocument;
  package: InstructorPackage;
  status: InstructorStatus;
  reason?: string;
}

function unique<T>(rows: T[], key: (r: T) => string, name: string) {
  const ids = new Set<string>();
  for (const row of rows) {
    const k = key(row);
    if (ids.has(k)) throw Error(`${name}: 중복 ID ${k}`);
    ids.add(k);
  }
}
function equal(a: unknown, b: unknown) {
  return canonicalExplanationValue(a) === canonicalExplanationValue(b);
}
export function parseInstructorPackage(value: unknown): InstructorPackage {
  const p = instructorPackageSchema.parse(value);
  unique(p.documents, (d) => d.documentId, "출처");
  unique(p.records, (r) => r.id, "해설");
  unique(p.assets, (a) => a.assetId, "자산");
  const docs = new Map(p.documents.map((d) => [d.documentId, d]));
  const assets = new Map(p.assets.map((a) => [a.assetId, a]));
  if (p.assets.reduce((n, a) => n + a.byteSize, 0) > MAX_TOTAL_ASSET_BYTES)
    throw Error("해설 자산은 합계 10 MiB 이하여야 합니다.");
  for (const r of p.records) {
    const d = docs.get(r.documentId);
    if (!d) throw Error(`출처 문서 없음: ${r.id}`);
    if (
      d.exam.subjectId !== r.subjectId ||
      d.exam.examCode !== r.sourceKey.examCode ||
      d.exam.year !== r.sourceKey.year ||
      d.exam.round !== r.sourceKey.round
    )
      throw Error(`출처 시험·과목 불일치: ${r.id}`);
    unique(
      r.scope.targets,
      (t) => canonicalExplanationValue(t.selector),
      "해설 대상",
    );
    for (const l of [...r.locations, ...r.blocks.flatMap((b) => b.locations)])
      if (l.page > d.pageCount) throw Error(`출처 페이지 범위 초과: ${r.id}`);
    for (const b of r.blocks)
      if (b.type === "image") {
        const a = assets.get(b.assetId);
        if (
          !a ||
          a.documentId !== r.documentId ||
          (a.questionId && a.questionId !== r.questionId)
        )
          throw Error(`해설 이미지 누락·출처 불일치: ${b.assetId}`);
      }
    for (const j of r.sourceSymbols.judgments)
      if (j.target && !r.scope.targets.some((t) => equal(t.selector, j.target)))
        throw Error(`정오 표기 대상 불일치: ${r.id}`);
    for (const c of [r.extraction, r.matching]) {
      if (c.status === "checked" && (!c.method?.trim() || !c.checkedAt))
        throw Error(`확인 기록 없음: ${r.id}`);
      if (c.status === "hold" && !c.reasons.length)
        throw Error(`보류 사유 없음: ${r.id}`);
    }
  }
  for (const a of p.assets)
    if (
      !docs.has(a.documentId) ||
      a.location.page > docs.get(a.documentId)!.pageCount
    )
      throw Error(`자산 출처 위치 불일치: ${a.assetId}`);
  return p;
}

export async function validateInstructorAssets(
  p: InstructorPackage,
): Promise<void> {
  for (const a of p.assets) {
    const raw = atob(a.base64),
      bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if (
      bytes.length !== a.byteSize ||
      bytes.length > MAX_INSTRUCTOR_ASSET_BYTES
    )
      throw Error(`이미지 크기 불일치: ${a.assetId}`);
    const signature =
      a.mimeType === "image/png"
        ? [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!signature) throw Error(`이미지 형식 불일치: ${a.assetId}`);
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== a.sha256) throw Error(`이미지 해시 불일치: ${a.assetId}`);
  }
}

function questionMismatch(
  r: InstructorRecord,
  q: Question,
  fingerprint: string,
): string | undefined {
  if (
    q.subjectId !== r.subjectId ||
    q.revision !== r.questionRevision ||
    q.gradingRevision !== r.gradingRevision
  )
    return "문항·채점 버전 불일치";
  if (r.questionFingerprint !== fingerprint)
    return "문제·정답·자산 내용 불일치";
  if (!equal(r.officialAnswer, q.officialAnswer)) return "공식 정답 불일치";
  if (
    r.sourceKey.examCode !== q.source.examCode ||
    r.sourceKey.year !== q.source.year ||
    r.sourceKey.round !== q.source.round ||
    r.sourceKey.questionNumber !== q.source.questionNumber
  )
    return "시험·회차·문항 번호 불일치";
  try {
    for (const t of r.scope.targets)
      if (targetText(q, t.selector) !== t.expectedText)
        return "원문 대상 문자열 불일치";
  } catch {
    return "원문 대상 선택자 불일치";
  }
  return undefined;
}
export async function validateInstructorPackage(
  value: unknown,
  namespace: Namespace,
  questions: Question[],
  questionAssets: Asset[] = [],
): Promise<InstructorPackage> {
  const p = parseInstructorPackage(value);
  if (p.dataKind !== namespace) throw Error("실제/시연 영역이 다릅니다.");
  await validateInstructorAssets(p);
  const qs = new Map(questions.map((q) => [q.id, q]));
  const fps = new Map<string, Promise<string>>();
  for (const r of p.records) {
    const q = qs.get(r.questionId);
    if (!q) throw Error(`없는 문항: ${r.questionId}`);
    if ((q.source.examCode === "demo") !== (namespace === "demo"))
      throw Error(`문항 자료 영역 불일치: ${r.id}`);
    if (!fps.has(q.id)) fps.set(q.id, questionFingerprint(q, questionAssets));
    const mismatch = questionMismatch(r, q, (await fps.get(q.id))!);
    if (mismatch) throw Error(`${mismatch}: ${r.questionId}`);
    if (
      r.sourceSymbols.answer &&
      !equal(
        [...r.sourceSymbols.answer.numbers].sort(),
        [...q.officialAnswer.acceptedChoices].sort(),
      ) &&
      r.matching.status !== "hold"
    )
      throw Error(`원문 정답 충돌은 보류로 표시해야 합니다: ${r.id}`);
  }
  return p;
}

export function summarizeInstructorPackage(p: InstructorPackage) {
  const grouped = new Map<string, InstructorRecord[]>();
  for (const r of p.records)
    grouped.set(r.questionId, [...(grouped.get(r.questionId) ?? []), r]);
  const states = [...grouped.values()].map((rs) =>
    rs.some(
      (r) => r.extraction.status === "hold" || r.matching.status === "hold",
    )
      ? "hold"
      : rs.every(
            (r) =>
              r.extraction.status === "checked" &&
              r.matching.status === "checked",
          )
        ? "checked"
        : "pending",
  );
  return {
    questions: grouped.size,
    checkedQuestions: states.filter((s) => s === "checked").length,
    heldQuestions: states.filter((s) => s === "hold").length,
    pendingQuestions: states.filter((s) => s === "pending").length,
    records: p.records.length,
    documents: p.documents.length,
    assets: p.assets.length,
  };
}

export async function resolveInstructorRecords(
  question: Question,
  packages: InstructorPackage[],
  questionAssets: Asset[] = [],
): Promise<ResolvedInstructorRecord[]> {
  const fingerprint = await questionFingerprint(question, questionAssets);
  return packages.flatMap((p) => {
    const docs = new Map(p.documents.map((d) => [d.documentId, d]));
    return p.records
      .filter((r) => r.questionId === question.id)
      .map((record) => {
        const document = docs.get(record.documentId)!;
        const mismatch = questionMismatch(record, question, fingerprint);
        const status: InstructorStatus = mismatch
          ? "stale"
          : record.extraction.status === "hold" ||
              record.matching.status === "hold"
            ? "hold"
            : record.extraction.status === "checked" &&
                record.matching.status === "checked"
              ? "checked"
              : "pending";
        return {
          record,
          document,
          package: p,
          status,
          reason:
            mismatch ??
            (status === "hold"
              ? [...record.extraction.reasons, ...record.matching.reasons].join(
                  " ",
                )
              : undefined),
        };
      });
  });
}

export function mergeInstructorPackages(
  existing: InstructorPackage[],
  incoming: InstructorPackage,
): InstructorPackage[] {
  const old = existing.find((p) => p.packageId === incoming.packageId);
  if (old) {
    if (
      incoming.packageVersion < old.packageVersion ||
      (incoming.packageVersion === old.packageVersion && !equal(incoming, old))
    )
      throw Error("강사 해설 패키지 버전 충돌입니다.");
    if (equal(incoming, old)) return existing;
    const oldRecords = new Map(old.records.map((r) => [r.id, r]));
    for (const r of incoming.records) {
      const prior = oldRecords.get(r.id);
      if (
        prior &&
        (r.revision < prior.revision ||
          (!equal(r, prior) && r.revision <= prior.revision))
      )
        throw Error(`강사 해설 revision 충돌: ${r.id}`);
    }
  }
  const result = existing
    .filter((p) => p.packageId !== incoming.packageId)
    .concat(incoming);
  const ids = new Map<string, InstructorRecord>();
  const documents = new Map<string, InstructorDocument>();
  const assets = new Map<string, InstructorAsset>();
  for (const p of result) {
    for (const r of p.records) {
      const prev = ids.get(r.id);
      if (prev && !equal(prev, r))
        throw Error(`패키지 간 해설 ID 충돌: ${r.id}`);
      ids.set(r.id, r);
    }
    for (const d of p.documents) {
      const prev = documents.get(d.documentId);
      if (prev && !equal(prev, d))
        throw Error(`패키지 간 출처 ID 충돌: ${d.documentId}`);
      documents.set(d.documentId, d);
    }
    for (const a of p.assets) {
      const prev = assets.get(a.assetId);
      if (prev && !equal(prev, a))
        throw Error(`패키지 간 자산 ID 충돌: ${a.assetId}`);
      assets.set(a.assetId, a);
    }
  }
  return result;
}

export const sameInstructorContent = equal;
