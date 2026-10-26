import { z } from "zod";
import type { Asset, Block, Namespace, Question } from "../model";
import { stable, referencedAssets } from "../validation";

const id = z.string().min(1).max(200),
  text = z.string().min(1).max(200000),
  version = z.number().int().positive();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "유효한 날짜가 필요합니다.",
  );
const url = z
  .string()
  .url()
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  }, "http/https 출처만 허용합니다.");
const subject = z.enum([
  "constitution",
  "criminal",
  "police",
  "criminology",
  "civil_general",
]);
export const verificationSchema = z
  .object({
    status: z.enum(["draft", "verified", "hold"]),
    checkedAt: z.string().datetime().nullable(),
    checkedBy: id.nullable(),
    note: z.string().max(5000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.status === "verified" &&
      (!v.checkedAt || !v.checkedBy || !v.note.trim())
    )
      ctx.addIssue({
        code: "custom",
        message:
          "verified에는 실제 확인자·시각·확인 기록이 필요합니다. 구조 검사는 법률 검증이 아닙니다.",
      });
  });
const area = {
  area: z.enum(["body", "choice"]),
  choiceNumber: z.number().int().min(1).max(4).nullable(),
  blockIndex: z.number().int().nonnegative(),
};
export const selectorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("choice"),
      number: z.number().int().min(1).max(4),
    })
    .strict(),
  z.object({ kind: z.literal("block"), ...area }).strict(),
  z
    .object({
      kind: z.literal("entry"),
      ...area,
      entryIndex: z.number().int().nonnegative(),
      label: id,
    })
    .strict(),
]);
const basisSchema = z
  .object({
    id,
    revision: version,
    type: z.enum(["case", "constitutional", "law", "theory", "demo"]),
    title: text,
    identity: z
      .object({ authority: id, number: id.nullable(), date: date.nullable() })
      .strict(),
    sourceUrl: url.nullable(),
    originalText: z.string().max(1000000).nullable(),
    archivedAt: z.string().datetime().nullable(),
    temporalBasis: z.enum(["exam", "current"]),
    asOfDate: date,
    verification: verificationSchema,
  })
  .strict()
  .refine(
    (v) => !!v.sourceUrl || !!v.originalText,
    "출처 URL 또는 보관 원문이 필요합니다.",
  );
const issueSchema = z
  .object({
    id,
    revision: version,
    basisId: id,
    title: text,
    excerpt: text,
    locator: text,
    verification: verificationSchema,
  })
  .strict();
const explanationSchema = z
  .object({
    id,
    revision: version,
    questionId: id,
    subjectId: subject,
    questionRevision: version,
    gradingRevision: version,
    questionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    selector: selectorSchema,
    expectedText: text,
    explanation: text,
    references: z
      .array(
        z
          .object({ basisId: id, issueIds: z.array(id).min(1).max(100) })
          .strict(),
      )
      .min(1)
      .max(100),
    verification: verificationSchema,
  })
  .strict();
export const explanationPackageSchema = z
  .object({
    format: z.literal("police-original-explanations"),
    schemaVersion: z.literal("1.0.0"),
    packageId: id,
    packageVersion: version,
    exportedAt: z.string().datetime(),
    dataKind: z.enum(["real", "demo"]),
    scope: z
      .object({
        subjectIds: z.array(subject).min(1),
        questionIds: z.array(id).min(1),
      })
      .strict(),
    producer: id,
    notes: z.array(z.string().max(5000)).max(100),
    bases: z.array(basisSchema).max(20000),
    issues: z.array(issueSchema).max(50000),
    explanations: z.array(explanationSchema).min(1).max(50000),
  })
  .strict();
export type ExplanationPackage = z.infer<typeof explanationPackageSchema>;
export type Explanation = ExplanationPackage["explanations"][number];
export type Basis = ExplanationPackage["bases"][number];
export type Issue = ExplanationPackage["issues"][number];
export type TargetSelector = z.infer<typeof selectorSchema>;
export const MAX_EXPLANATION_BYTES = 20 * 1024 * 1024;
export const selectorKey = (selector: TargetSelector) => stable(selector);
export const sourceKey = (q: Question) =>
  stable([
    q.source.examCode,
    q.subjectId,
    q.source.year,
    q.source.round,
    q.source.questionNumber,
  ]);
/** UTF-16 key ordering, independent of the browser/OS locale. */
export function canonicalExplanationValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalExplanationValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalExplanationValue((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const blockText = (b: Block) =>
  b.type === "text"
    ? b.text
    : b.type === "image"
      ? `[[image:${b.assetId}]]`
      : b.entries.map((e) => `${e.label} ${e.text}`).join("\n");
export function targetText(q: Question, selector: TargetSelector): string {
  if (selector.kind === "choice") {
    const choices = q.choices.filter((c) => c.number === selector.number);
    if (choices.length !== 1)
      throw Error("선택지 번호가 없거나 중복되었습니다.");
    return choices[0].blocks.map(blockText).join("\n");
  }
  if ((selector.area === "body") !== (selector.choiceNumber === null))
    throw Error(
      "body는 choiceNumber:null, choice는 실제 선택지 번호가 필요합니다.",
    );
  const blocks =
    selector.area === "body"
      ? q.body
      : q.choices.find((c) => c.number === selector.choiceNumber)?.blocks;
  const block = blocks?.[selector.blockIndex];
  if (!block) throw Error("대상 block이 없습니다.");
  if (selector.kind === "block") {
    if (block.type !== "text")
      throw Error(
        "block 대상은 text만 허용합니다. 개별 보기는 entry를 사용하세요.",
      );
    return block.text;
  }
  if (block.type !== "statements")
    throw Error("entry 대상은 statements여야 합니다.");
  const entry = block.entries[selector.entryIndex];
  if (!entry || entry.label !== selector.label)
    throw Error("entry 위치·label이 일치하지 않습니다.");
  return entry.text;
}
export async function questionFingerprint(
  q: Question,
  assets: Asset[] = [],
): Promise<string> {
  const refs = new Set(referencedAssets(q));
  const content = canonicalExplanationValue({
    version: "original-explanation-content-v1",
    subjectId: q.subjectId,
    source: q.source,
    body: q.body,
    choices: q.choices,
    officialAnswer: q.officialAnswer,
    gradingRevision: q.gradingRevision,
    assets: [...refs]
      .sort()
      .map((id) => [id, assets.find((a) => a.assetId === id)?.sha256 ?? null]),
  });
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function parseExplanationPackage(value: unknown): ExplanationPackage {
  const p = explanationPackageSchema.parse(value);
  if (p.dataKind === "real" && p.bases.some((b) => b.type === "demo"))
    throw Error("시연 근거를 실제 자료로 등록할 수 없습니다.");
  for (const b of p.bases)
    if (
      (b.type === "case" || b.type === "constitutional") &&
      (!b.identity.number || !b.identity.date)
    )
      throw Error(
        `사건 근거에는 법원·기관, 사건번호, 선고·결정일이 필요합니다: ${b.id}`,
      );
  for (const [name, records] of [
    ["bases", p.bases],
    ["issues", p.issues],
    ["explanations", p.explanations],
  ] as const) {
    const seen = new Set<string>();
    for (const r of records) {
      if (seen.has(r.id)) throw Error(`${name}: 중복 ID ${r.id}`);
      seen.add(r.id);
    }
  }
  if (
    new Set(p.scope.questionIds).size !== p.scope.questionIds.length ||
    new Set(p.scope.subjectIds).size !== p.scope.subjectIds.length
  )
    throw Error("scope 중복입니다.");
  const explanations = new Set(p.explanations.map((e) => e.questionId));
  if (
    p.scope.questionIds.some((id) => !explanations.has(id)) ||
    p.explanations.some(
      (e) =>
        !p.scope.questionIds.includes(e.questionId) ||
        !p.scope.subjectIds.includes(e.subjectId),
    )
  )
    throw Error("scope와 해설 대상이 일치하지 않습니다.");
  return p;
}
function uniqueRecords<T extends { id: string }>(
  records: T[],
  name: string,
): T[] {
  const map = new Map<string, T>();
  for (const r of records) {
    const old = map.get(r.id);
    if (old && stable(old) !== stable(r))
      throw Error(`${name}: 패키지 간 ID 충돌 ${r.id}`);
    map.set(r.id, r);
  }
  return [...map.values()];
}
export function explanationIndex(packages: ExplanationPackage[]) {
  const bases = uniqueRecords(
      packages.flatMap((p) => p.bases),
      "근거",
    ),
    issues = uniqueRecords(
      packages.flatMap((p) => p.issues),
      "쟁점",
    ),
    explanations = uniqueRecords(
      packages.flatMap((p) => p.explanations),
      "해설",
    );
  const bm = new Map(bases.map((b) => [b.id, b])),
    im = new Map(issues.map((i) => [i.id, i]));
  const identities = new Map<string, string>();
  for (const b of bases) {
    const k = stable([b.type, b.identity]);
    const old = identities.get(k);
    if (old && old !== b.id)
      throw Error(
        `동일 식별정보의 근거 ID가 둘입니다: ${old}, ${b.id}. 확인 후 공통 ID를 사용하세요.`,
      );
    identities.set(k, b.id);
  }
  for (const i of issues)
    if (!bm.has(i.basisId)) throw Error(`쟁점의 근거 없음: ${i.id}`);
  const targets = new Map<string, string>();
  const levels = new Map<string, { whole: Set<number>; parts: Set<number> }>();
  for (const e of explanations) {
    const group = stable([e.questionId, e.questionFingerprint]),
      level = levels.get(group) ?? {
        whole: new Set<number>(),
        parts: new Set<number>(),
      };
    if (e.selector.kind === "choice") level.whole.add(e.selector.number);
    else if (e.selector.area === "choice" && e.selector.choiceNumber !== null)
      level.parts.add(e.selector.choiceNumber);
    if ([...level.whole].some((n) => level.parts.has(n)))
      throw Error(
        `선택지 전체와 그 내부의 개별 대상을 겹쳐 등록할 수 없습니다: ${e.id}`,
      );
    levels.set(group, level);
    const k = stable([e.questionId, e.questionFingerprint, e.selector]);
    const old = targets.get(k);
    if (old && old !== e.id)
      throw Error(`한 대상에 서로 다른 해설 ID가 있습니다: ${old}, ${e.id}`);
    targets.set(k, e.id);
    for (const ref of e.references) {
      const b = bm.get(ref.basisId);
      if (!b) throw Error(`해설의 근거 없음: ${ref.basisId}`);
      for (const id of ref.issueIds) {
        const i = im.get(id);
        if (!i || i.basisId !== b.id) throw Error(`잘못된 쟁점 참조: ${id}`);
      }
      if (
        e.verification.status === "verified" &&
        (b.verification.status !== "verified" ||
          ref.issueIds.some(
            (id) => im.get(id)?.verification.status !== "verified",
          ))
      )
        throw Error(`확정 해설의 근거·쟁점도 검증 기록이 필요합니다: ${e.id}`);
    }
  }
  return { bases, issues, explanations, bm, im };
}
export async function validateExplanationPackage(
  value: unknown,
  namespace: Namespace,
  questions: Question[],
  assets: Asset[] = [],
): Promise<ExplanationPackage> {
  const p = parseExplanationPackage(value);
  if (p.dataKind !== namespace) throw Error("실제/시연 영역이 다릅니다.");
  explanationIndex([p]);
  const fingerprints = new Map<string, Promise<string>>();
  for (const e of p.explanations) {
    const q = questions.find((q) => q.id === e.questionId);
    if (!q) throw Error(`없는 문항: ${e.questionId}`);
    if (
      (q.source.examCode === "demo") !== (namespace === "demo") ||
      q.subjectId !== e.subjectId
    )
      throw Error(`과목·자료 영역 불일치: ${e.id}`);
    if (q.gradingRevision !== e.gradingRevision)
      throw Error(`채점 버전 불일치: ${e.id}`);
    if (targetText(q, e.selector) !== e.expectedText)
      throw Error(`원문 대상 문자열 불일치: ${e.id}`);
    if (!fingerprints.has(q.id))
      fingerprints.set(q.id, questionFingerprint(q, assets));
    if ((await fingerprints.get(q.id)) !== e.questionFingerprint)
      throw Error(`원문/정답 지문값 불일치: ${e.id}`);
  }
  return p;
}
export function mergeExplanationPackages(
  existing: ExplanationPackage[],
  incoming: ExplanationPackage,
): ExplanationPackage[] {
  const old = existing.find((p) => p.packageId === incoming.packageId);
  if (old) {
    if (
      incoming.packageVersion < old.packageVersion ||
      (incoming.packageVersion === old.packageVersion &&
        stable(incoming) !== stable(old))
    )
      throw Error("패키지 버전 충돌입니다.");
    for (const name of ["bases", "issues", "explanations"] as const)
      for (const record of incoming[name]) {
        const prior = old[name].find((r) => r.id === record.id);
        if (
          prior &&
          (record.revision < prior.revision ||
            (stable(record) !== stable(prior) &&
              record.revision <= prior.revision))
        )
          throw Error(`자료 revision 충돌: ${record.id}`);
      }
  }
  const next = existing
    .filter((p) => p.packageId !== incoming.packageId)
    .concat(incoming);
  explanationIndex(next);
  return next;
}
