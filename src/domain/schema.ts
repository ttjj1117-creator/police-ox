import { z } from "zod";

const text = z.string().trim().min(1);
const positive = z.number().int().positive();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "유효한 날짜가 필요합니다",
  );
const timestamp = z.string().datetime();
const subject = z.enum(["constitution", "criminal", "police"]);
export const basisSchema = z.enum(["exam", "current"]);
export const evidenceSchema = z
  .object({
    type: z.enum(["law", "case", "other"]),
    title: text,
    caseNumber: z.string().optional(),
    decisionDate: date.optional(),
    article: z.string().optional(),
    url: z
      .string()
      .refine(
        (v) =>
          v === "" ||
          (/^https?:\/\//i.test(v) &&
            (() => {
              try {
                return !!new URL(v).hostname;
              } catch {
                return false;
              }
            })()),
        "http/https URL만 허용합니다",
      )
      .optional(),
    excerpt: z.string().optional(),
    caseTextCompared: z.boolean(),
  })
  .strict();
export const judgmentSchema = z
  .object({
    answer: z.enum(["O", "X"]).nullable(),
    status: z.enum(["draft", "verified", "hold"]),
    judgmentRevision: positive,
    verifiedAt: timestamp.nullable(),
    asOfDate: date.nullable(),
    shortReason: z.string(),
    keyPoint: z.string(),
    corrections: z.array(z.object({ wrong: text, correct: text }).strict()),
    evidence: z.array(evidenceSchema),
  })
  .strict();
export const taxonomySchema = z
  .object({
    id: text,
    parentId: text.nullable(),
    label: text,
    order: z.number().int(),
    subjectId: subject,
    origin: z.enum(["book", "custom"]),
    taxonomyVersion: positive,
    book: z
      .object({
        title: z.string().optional(),
        edition: z.string().optional(),
        year: z.number().int().optional(),
        fileRef: z.string().optional(),
        page: positive.optional(),
        tocPage: positive.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const itemSchema = z
  .object({
    id: text,
    revision: positive,
    originalQuestionId: text,
    source: z
      .object({
        year: z.number().int(),
        round: text,
        examName: text,
        track: z.string(),
        subject: text,
        questionNumber: positive,
        option: z.string(),
        fileRef: z.string(),
        page: z.number().int().positive().nullable(),
      })
      .strict(),
    subjectId: subject,
    areaId: text.nullable(),
    primaryUnitId: text.nullable(),
    relatedUnitIds: z.array(text),
    tags: z.array(text),
    originalText: text,
    displayText: text,
    contextText: z.string(),
    transformation: z.enum(["original", "context_added", "adapted"]),
    transformationReason: z.string(),
    trapTypes: z.array(
      z.enum([
        "conclusion_negation",
        "subject_object",
        "requirements_scope",
        "condition_exception",
        "time_procedure",
        "case_application",
      ]),
    ),
    originalVerified: z.boolean(),
    judgments: z
      .object({ exam: judgmentSchema, current: judgmentSchema })
      .strict(),
    lifecycle: z.enum(["active", "retired"]),
  })
  .strict();
const groupSchema = z
  .object({
    id: text,
    title: text,
    subjectId: subject,
    unitIds: z.array(text),
    includeDescendants: z.boolean(),
    optionalAnyTags: z.array(text),
    order: z.number().int(),
  })
  .strict();
const coverageSchema = z
  .object({
    id: text,
    year: z.number().int(),
    round: text,
    subjectId: subject,
    status: z.enum(["not_started", "partial", "complete"]),
    classificationComplete: z.boolean(),
  })
  .strict();
export const datasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: text,
    datasetVersion: positive,
    exportedAt: timestamp,
    taxonomies: z.array(taxonomySchema),
    studyGroups: z.array(groupSchema),
    coverage: z.array(coverageSchema),
    items: z.array(itemSchema),
  })
  .strict()
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    for (const key of [
      "taxonomies",
      "studyGroups",
      "coverage",
      "items",
    ] as const) {
      const ids = new Set<string>();
      d[key].forEach((v, i) => {
        if (ids.has(v.id)) issue([key, i, "id"], "중복 ID");
        ids.add(v.id);
      });
    }
    const nodes = new Map(d.taxonomies.map((n) => [n.id, n]));
    d.taxonomies.forEach((n, i) => {
      if (
        n.parentId &&
        (!nodes.has(n.parentId) ||
          nodes.get(n.parentId)?.subjectId !== n.subjectId)
      )
        issue(["taxonomies", i, "parentId"], "부모 참조 또는 과목 불일치");
      const seen = new Set([n.id]);
      let p = n.parentId;
      while (p && nodes.has(p)) {
        if (seen.has(p)) {
          issue(["taxonomies", i, "parentId"], "순환 목차");
          break;
        }
        seen.add(p);
        p = nodes.get(p)!.parentId;
      }
    });
    const ref = (id: string, sub: string, path: (string | number)[]) => {
      if (!nodes.has(id) || nodes.get(id)?.subjectId !== sub)
        issue(path, "단원 참조 또는 과목 불일치");
    };
    d.studyGroups.forEach((g, i) =>
      g.unitIds.forEach((id, j) =>
        ref(id, g.subjectId, ["studyGroups", i, "unitIds", j]),
      ),
    );
    d.items.forEach((v, i) => {
      if (v.primaryUnitId) {
        ref(v.primaryUnitId, v.subjectId, ["items", i, "primaryUnitId"]);
        if (d.taxonomies.some((n) => n.parentId === v.primaryUnitId))
          issue(
            ["items", i, "primaryUnitId"],
            "주단원은 말단 단원을 사용하세요. 미확정은 null입니다.",
          );
      }
      if (v.areaId) ref(v.areaId, v.subjectId, ["items", i, "areaId"]);
      v.relatedUnitIds.forEach((id, j) =>
        ref(id, v.subjectId, ["items", i, "relatedUnitIds", j]),
      );
      for (const b of ["exam", "current"] as const) {
        const j = v.judgments[b];
        if (j.status === "verified") {
          if (
            !v.originalVerified ||
            !j.answer ||
            !j.verifiedAt ||
            !j.asOfDate ||
            !j.shortReason.trim() ||
            !j.evidence.length ||
            (j.answer === "X" && !j.corrections.length) ||
            (j.answer === "O" && !j.keyPoint.trim())
          )
            issue(
              ["items", i, "judgments", b],
              "검증 완료 필수값 누락 (원문 대조·정답·날짜·이유·근거·정정/핵심)",
            );
        }
      }
    });
  });
export type Dataset = z.infer<typeof datasetSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
export type Basis = z.infer<typeof basisSchema>;
export type Namespace = "real" | "demo";
export const selectionSchema = z
  .object({
    subjectId: subject,
    basis: basisSchema,
    view: z.enum(["units", "groups"]),
    unitIds: z.array(text),
    groupIds: z.array(text),
    year: z.string(),
    round: z.string(),
    filter: z.enum(["all", "unanswered", "incorrect", "unknown", "marked"]),
    mode: z.enum(["cycle", "balanced", "weak"]),
    order: z.enum(["ordered", "random"]),
    limit: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(0)]),
  })
  .strict();
export type Selection = z.infer<typeof selectionSchema>;
export const defaultSelection: Selection = {
  subjectId: "constitution",
  basis: "current",
  view: "units",
  unitIds: [],
  groupIds: [],
  year: "",
  round: "",
  filter: "all",
  mode: "cycle",
  order: "ordered",
  limit: 20,
};
export const attemptSchema = z
  .object({
    attemptId: text,
    sessionId: text,
    itemId: text,
    itemRevision: positive,
    basis: basisSchema,
    judgmentRevision: positive,
    response: z.enum(["O", "X", "unknown"]),
    expectedAnswer: z.enum(["O", "X"]),
    result: z.enum(["correct", "incorrect", "unknown"]),
    answeredAt: timestamp,
  })
  .strict();
export type Attempt = z.infer<typeof attemptSchema>;
export const sessionSchema = z
  .object({
    id: text,
    selection: selectionSchema,
    items: z.array(itemSchema).min(1),
    index: z.number().int().nonnegative(),
    revealed: z.boolean(),
    status: z.enum(["active", "completed", "ended"]),
    cycleKey: z.string().nullable(),
    createdAt: timestamp,
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;
export const stateSchema = z
  .object({
    dataset: datasetSchema,
    attempts: z.array(attemptSchema),
    marks: z.record(z.boolean()),
    sessions: z.array(sessionSchema),
    cycles: z.record(
      z
        .object({
          candidates: z.array(text),
          remaining: z.array(text),
          round: positive,
        })
        .strict(),
    ),
    allocations: z.record(z.number().int().nonnegative()),
    settings: z.object({ fontScale: z.number().min(1).max(2) }).strict(),
  })
  .strict();
export type State = z.infer<typeof stateSchema>;
export const backupSchema = z
  .object({
    backupSchemaVersion: z.literal(1),
    appVersion: text,
    exportedAt: timestamp,
    namespace: z.enum(["real", "demo"]),
    state: stateSchema,
  })
  .strict();
export function parseDataset(value: unknown): Dataset {
  return datasetSchema.parse(value);
}
export function errorMessage(e: unknown): string {
  return e instanceof z.ZodError
    ? e.issues
        .map((i) => `${i.path.join(".") || "파일"}: ${i.message}`)
        .join("\n")
    : e instanceof Error
      ? e.message
      : String(e);
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => JSON.stringify(k) + ":" + canonical(val))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
