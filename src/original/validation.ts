import schema from "./contracts/original.schema.json";
import registry from "./contracts/study-units.json";
import examProfiles from "./contracts/exam-profiles.json";
import catalog from "../fixtures/book-taxonomies.json";
import type { Asset, Block, Namespace, OriginalData, OriginalPackage, Question, Subject } from "./model";

export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
export const subjectLabels: Record<string, string> = { constitution: "헌법", criminal: "형사법", police: "경찰학", criminology: "범죄학", civil_general: "민법총칙" };
export const bookNodes = catalog;
export const units = [
  ...registry.units,
  ...registry.pendingAreas.map((u, i) => ({ ...u, group: "형사소송법 임시 대분류", order: 33 + i, includeDescendants: true, bookLocation: "기본서 세부 목차 미등록", bookStartPages: [] as number[] })),
];
export const profile = examProfiles.profiles[0];
export const areas = profile.areas;
const nodes = new Map(bookNodes.map((n) => [n.id, n]));
export const mappingReport = {
  bookNodeCount: bookNodes.length,
  unitCount: registry.units.length,
  pendingAreaCount: registry.pendingAreas.length,
  referenceCount: units.reduce((n, u) => n + u.bookNodeIds.length, 0),
  pending: units.flatMap((u) => u.bookNodeIds.filter((id) => nodes.get(id)?.subjectId !== u.subjectId).map((id) => ({ unitCode: u.code, bookNodeId: id, reason: "현재 목차에 없거나 과목이 달라 연결 보류" }))),
};
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
type Schema = Record<string, any>;
function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
    && (offsetHour === undefined || Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
}
function structural(s: Schema, v: unknown, path: string, errors: string[]): void {
  const fail = (message: string) => errors.push(`${path || "파일"}: ${message}`);
  if (s.$ref) {
    const ref = s.$ref.split("/").slice(1).reduce((r: any, key: string) => r[key], schema);
    structural(ref, v, path, errors); return;
  }
  if (s.anyOf || s.oneOf) {
    const variants = (s.anyOf ?? s.oneOf).map((sub: Schema) => { const out: string[] = []; structural(sub, v, path, out); return out; });
    const matches = variants.filter((out: string[]) => out.length === 0).length;
    if (matches === 0) { const best = variants.sort((a: string[], b: string[]) => a.length - b.length)[0]; errors.push(...best); }
    else if (s.oneOf && matches !== 1) fail("허용된 구조 한 가지와 정확히 일치해야 합니다.");
    return;
  }
  if (s.const !== undefined && stable(v) !== stable(s.const)) fail(`지원 값은 ${JSON.stringify(s.const)}입니다.`);
  if (s.enum && !s.enum.some((x: unknown) => stable(x) === stable(v))) fail("허용되지 않은 값입니다.");
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (s.type && (s.type === "integer" ? typeof v !== "number" || !Number.isSafeInteger(v) : kind !== s.type)) { fail(`${s.type} 형식이 필요합니다.`); return; }
  if (typeof v === "string") {
    if (s.minLength !== undefined && [...v].length < s.minLength) fail("빈 문자열을 사용할 수 없습니다.");
    if (s.pattern && !new RegExp(s.pattern).test(v)) fail("문자열 형식이 맞지 않습니다.");
    if (s.format === "date-time" && !validTimestamp(v)) fail("시간대가 있는 유효한 ISO 8601 시각이 필요합니다.");
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) fail(`${s.minimum} 이상이어야 합니다.`);
    if (s.maximum !== undefined && v > s.maximum) fail(`${s.maximum} 이하여야 합니다.`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) fail(`항목이 ${s.minItems}개 이상 필요합니다.`);
    if (s.maxItems !== undefined && v.length > s.maxItems) fail(`항목은 ${s.maxItems}개까지 허용됩니다.`);
    if (s.uniqueItems && new Set(v.map(stable)).size !== v.length) fail("중복된 항목이 있습니다.");
    if (s.items) v.forEach((x, i) => structural(s.items, x, `${path}.${i}`, errors));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const key of s.required ?? []) if (!Object.hasOwn(o, key)) errors.push(`${path ? path + "." : ""}${key}: 필수 항목입니다.`);
    for (const [key, val] of Object.entries(o)) {
      const p = `${path ? path + "." : ""}${key}`;
      if (s.properties?.[key]) structural(s.properties[key], val, p, errors);
      else if (s.additionalProperties === false) errors.push(`${p}: 알 수 없는 항목입니다.`);
    }
  }
  for (const clause of s.allOf ?? []) {
    if (clause.if) { const condition: string[] = []; structural(clause.if, v, path, condition); if (!condition.length) structural(clause.then, v, path, errors); }
    else structural(clause, v, path, errors);
  }
}
export function validateStructure(value: unknown): asserts value is OriginalPackage {
  const errors: string[] = [];
  structural(schema, value, "", errors);
  if (errors.length) throw new Error(errors.slice(0, 40).join("\n"));
}
const prefixes: Record<Subject, string> = { constitution: "const", criminal: "crim", police: "police", criminology: "crime", civil_general: "civil" };
export function expectedQuestionId(q: Question): string {
  const s = q.source;
  return s.examCode === "demo" ? `demo_${prefixes[q.subjectId]}_${s.questionNumber}` : `${s.examCode === "lieut" ? "lieut_" : ""}${prefixes[q.subjectId]}_${s.year}_${s.round}_${s.questionNumber}`;
}
export function referencedAssets(q: Question): string[] {
  return [...q.body, ...q.choices.flatMap((c) => c.blocks)].filter((b): b is Extract<Block, { type: "image" }> => b.type === "image").map((b) => b.assetId);
}
export async function validateAssets(assets: Asset[]): Promise<void> {
  const seen = new Set<string>();
  for (const [i, asset] of assets.entries()) {
    const fail = (message: string): never => { throw new Error(`assets.${i}: ${message}`); };
    if (seen.has(asset.assetId)) fail("중복 assetId입니다.");
    seen.add(asset.assetId);
    let bytes: Uint8Array;
    try {
      const binary = atob(asset.base64);
      if (btoa(binary) !== asset.base64) fail("정규 base64 문자열이 아닙니다.");
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch { fail("그림 base64를 읽을 수 없습니다."); }
    const isPng = bytes!.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, k) => bytes![k] === n);
    const isJpeg = bytes!.length >= 4 && bytes![0] === 255 && bytes![1] === 216 && bytes![2] === 255 && bytes![bytes!.length - 2] === 255 && bytes![bytes!.length - 1] === 217;
    if (asset.mimeType === "image/png" ? !isPng : !isJpeg) fail("그림 MIME 형식과 파일 서명이 다릅니다.");
    const digest = await crypto.subtle.digest("SHA-256", bytes!);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hash !== asset.sha256) fail("SHA-256 해시가 다릅니다.");
    // The browser must also be able to decode the full raster. Matching hashes
    // and signatures alone do not detect a truncated or otherwise broken file.
    if (typeof createImageBitmap === "function") {
      let bitmap: ImageBitmap | undefined;
      try { bitmap = await createImageBitmap(new Blob([bytes!], { type: asset.mimeType })); }
      catch { fail("그림 파일을 읽을 수 없습니다. 원본 PNG/JPEG 파일을 확인하세요."); }
      finally { bitmap?.close(); }
    }
  }
}
export function isEligible(q: Question, namespace: Namespace): boolean {
  return ["constitution", "criminal", "police"].includes(q.subjectId) && q.lifecycle === "active" && q.qa.textStatus === "checked" && q.qa.answerStatus === "checked" && ["single", "multiple"].includes(q.officialAnswer.kind) && (namespace === "demo" ? q.source.examCode === "demo" && q.officialAnswer.status === "demo" : q.source.examCode === "po" && q.officialAnswer.status === "final" && !!q.source.questionPdf && !!q.source.answerPdf);
}
export async function validatePackage(value: unknown, namespace: Namespace, options: { allowLargeCollection?: boolean } = {}): Promise<OriginalPackage> {
  // The cap applies to one imported problem file. Backup/session collections may
  // legitimately combine many previously validated files into a larger archive.
  if (!options.allowLargeCollection && new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_ORIGINAL_BYTES) throw new Error("파일: 원문 JSON은 20 MiB 이하여야 합니다.");
  validateStructure(value);
  const pkg = value;
  const fail = (path: string, message: string): never => { throw new Error(`${path}: ${message}`); };
  if (pkg.dataKind !== namespace) fail("dataKind", "실제/시연 저장 영역이 다릅니다.");
  const ids = new Set<string>();
  const assetIds = new Set(pkg.assets.map((a) => a.assetId));
  for (const [i, q] of pkg.questions.entries()) {
    const path = `questions.${i}`;
    if (ids.has(q.id)) fail(`${path}.id`, "중복 문항 ID입니다.");
    ids.add(q.id);
    if (q.id !== expectedQuestionId(q)) fail(`${path}.id`, `출처·과목에서 계산한 ID ${expectedQuestionId(q)}와 다릅니다.`);
    if ((namespace === "demo") !== (q.source.examCode === "demo") || (namespace === "demo") !== (q.officialAnswer.status === "demo")) fail(`${path}.source.examCode`, "실제 기출과 기능 시연 문항을 혼합할 수 없습니다.");
    if (q.gradingRevision > q.revision) fail(`${path}.gradingRevision`, "revision보다 클 수 없습니다.");
    if (q.choices.some((c, j) => c.number !== j + 1)) fail(`${path}.choices`, "선택지는 원문 순서 1·2·3·4가 각각 한 번씩 있어야 합니다.");
    if (q.officialAnswer.acceptedChoices.some((n, j, a) => j > 0 && a[j - 1] >= n)) fail(`${path}.officialAnswer.acceptedChoices`, "인정 정답은 중복 없이 오름차순이어야 합니다.");
    if (pkg.stage === "extracted" && q.classification !== null) fail(`${path}.classification`, "extracted 단계에는 분류를 null로 보존하세요.");
    if (q.classification) {
      const c = q.classification;
      if (c.studyStatus === "confirmed" && !c.studyUnitCode) fail(`${path}.classification.studyUnitCode`, "확정한 학습 단원 코드가 필요합니다.");
      if (c.blueprintStatus === "confirmed" && !c.blueprintAreaCode) fail(`${path}.classification.blueprintAreaCode`, "확정한 공식 영역 코드가 필요합니다.");
      if (c.studyUnitCode && c.relatedStudyUnitCodes.includes(c.studyUnitCode)) fail(`${path}.classification.relatedStudyUnitCodes`, "주단원을 관련 단원에 중복하지 마세요.");
      for (const code of [c.studyUnitCode, ...c.relatedStudyUnitCodes].filter(Boolean)) if (units.find((u) => u.code === code)?.subjectId !== q.subjectId) fail(`${path}.classification.studyUnitCode`, "단원 코드의 과목이 문항과 다릅니다.");
      if (c.blueprintAreaCode && areas.find((a) => a.code === c.blueprintAreaCode)?.subjectId !== q.subjectId) fail(`${path}.classification.blueprintAreaCode`, "공식 영역의 과목이 문항과 다릅니다.");
      for (const id of c.bookUnitIds) if (nodes.get(id)?.subjectId !== q.subjectId) fail(`${path}.classification.bookUnitIds`, `존재하지 않거나 과목이 다른 목차 ID: ${id}`);
    }
    for (const id of referencedAssets(q)) if (!assetIds.has(id)) fail(`${path}.body`, `필수 그림 자산 ${id}가 없습니다.`);
    if (namespace === "real") {
      if ((q.qa.textStatus === "checked" || q.qa.answerStatus === "checked") && !q.source.examName.trim()) fail(`${path}.source.examName`, "대조 완료에는 공백이 아닌 공식 시험명이 필요합니다.");
      if (q.qa.textStatus === "checked" && !q.source.questionPdf) fail(`${path}.source.questionPdf`, "원문 대조 완료에는 시험지 파일명·페이지 근거가 필요합니다.");
      if (q.qa.textStatus === "checked" && !q.source.questionPdf!.fileName.trim()) fail(`${path}.source.questionPdf.fileName`, "원문 대조 완료에는 공백이 아닌 시험지 파일명이 필요합니다.");
      if (q.qa.answerStatus === "checked") {
        if (q.officialAnswer.status !== "final" || q.officialAnswer.kind === "unresolved" || !q.source.answerPdf) fail(`${path}.officialAnswer`, "정답 대조 완료에는 공식 최종 정답과 정답지 근거가 필요합니다.");
        if (!q.source.answerPdf!.fileName.trim()) fail(`${path}.source.answerPdf.fileName`, "정답 대조 완료에는 공백이 아닌 정답지 파일명이 필요합니다.");
        if (!q.source.answerPdf!.subjectColumn.trim()) fail(`${path}.source.answerPdf.subjectColumn`, "정답 대조 완료에는 공백이 아닌 공식 과목 열 이름이 필요합니다.");
        if (q.source.answerPdf!.subjectColumn !== subjectLabels[q.subjectId]) fail(`${path}.source.answerPdf.subjectColumn`, `공식 정답표 과목 열은 ${subjectLabels[q.subjectId]}이어야 합니다.`);
      }
    }
  }
  await validateAssets(pkg.assets);
  return structuredClone(pkg);
}
const packageContent = (p: OriginalPackage) => { const { exportedAt: _at, ...rest } = p; return stable(rest); };
const gradingContent = (q: Question) => stable({ body: q.body, choices: q.choices, kind: q.officialAnswer.kind, acceptedChoices: q.officialAnswer.acceptedChoices });
export async function previewMerge(data: OriginalData, value: unknown, namespace: Namespace) {
  const incoming = await validatePackage(value, namespace);
  const previous = data.packages.find((p) => p.packageId === incoming.packageId);
  if (previous && (incoming.packageVersion < previous.packageVersion || incoming.packageVersion === previous.packageVersion && packageContent(previous) !== packageContent(incoming))) throw new Error("packageVersion: 이전 버전 또는 같은 버전의 다른 내용은 가져올 수 없습니다.");
  const assets = new Map(data.assets.map((a) => [a.assetId, a]));
  for (const asset of incoming.assets) {
    const old = assets.get(asset.assetId);
    if (old && stable(old) !== stable(asset)) throw new Error(`assets.${asset.assetId}: 기존 자산은 불변입니다. 변경 그림에는 새 assetId를 사용하고 문항 gradingRevision을 증가시키세요.`);
    assets.set(asset.assetId, asset);
  }
  const questions = new Map(data.questions.map((q) => [q.id, q]));
  let added = 0, updated = 0, unchanged = 0;
  for (const q of incoming.questions) {
    const old = questions.get(q.id);
    if (!old) added++;
    else {
      if (q.revision < old.revision || q.revision === old.revision && stable(q) !== stable(old)) throw new Error(`questions.${q.id}.revision: 이전 버전 또는 같은 버전의 다른 내용입니다.`);
      if (q.gradingRevision < old.gradingRevision || gradingContent(q) !== gradingContent(old) && q.gradingRevision <= old.gradingRevision) throw new Error(`questions.${q.id}.gradingRevision: 본문·선택지·정답 변경에는 채점 버전을 증가시켜야 합니다.`);
      if (stable(q) === stable(old)) unchanged++; else updated++;
    }
    questions.set(q.id, q);
  }
  const packages = new Map(data.packages.map((p) => [p.packageId, p]));
  packages.set(incoming.packageId, incoming);
  return { data: { questions: [...questions.values()], assets: [...assets.values()], packages: [...packages.values()] }, added, updated, unchanged, held: incoming.questions.filter((q) => !isEligible(q, namespace)).length };
}

/** Export the latest aggregate, not historical payloads from overlapping sources. */
export function exportOriginalPackages(data: OriginalData, namespace: Namespace): OriginalPackage[] {
  const exportedAt = new Date().toISOString();
  const exportId = `local_export_${namespace}_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const assetMap = new Map(data.assets.map((a) => [a.assetId, a]));
  const assetBytes = new Map(data.assets.map((a) => [a.assetId, byteLength(a)]));
  const exportedAssets = new Set<string>();
  const result: OriginalPackage[] = [];
  const make = (): OriginalPackage => ({ format: "police-original-questions", schemaVersion: "1.0.0", packageId: `${exportId}_${result.length + 1}`, packageVersion: 1,
    exportedAt, dataKind: namespace, stage: "classified", unitRegistryVersion: "1.0.0", questions: [], assets: [] });
  let current = make(), bytes = byteLength(current), currentAssets = new Set<string>();
  const flush = () => { result.push(current); current = make(); bytes = byteLength(current); currentAssets = new Set(); };
  const addAssetSize = (assets: Asset[]) => assets.reduce((n, a) => n + assetBytes.get(a.assetId)!, 0) + Math.max(0, assets.length - (current.assets.length ? 0 : 1));
  for (const q of data.questions) {
    const required = [...new Set(referencedAssets(q))].map((id) => {
      const asset = assetMap.get(id);
      if (!asset) throw new Error(`questions.${q.id}: 내보낼 그림 자산 ${id}가 없습니다.`);
      return asset;
    });
    let additional = required.filter((a) => !currentAssets.has(a.assetId));
    const qBytes = byteLength(q);
    let extra = qBytes + (current.questions.length ? 1 : 0) + addAssetSize(additional);
    if (bytes + extra > MAX_ORIGINAL_BYTES && (current.questions.length || current.assets.length)) {
      flush(); additional = required;
      extra = qBytes + addAssetSize(additional);
    }
    if (bytes + extra > MAX_ORIGINAL_BYTES) throw new Error(`questions.${q.id}: 한 문항과 필수 그림이 20 MiB를 초과합니다. 전체 백업으로 보존하세요.`);
    current.questions.push(q);
    for (const asset of additional) { current.assets.push(asset); currentAssets.add(asset.assetId); exportedAssets.add(asset.assetId); }
    bytes += extra;
  }
  // Preserve unreferenced imported raster assets too; full backup additionally
  // preserves the original package metadata and all learning records.
  for (const asset of data.assets.filter((a) => !exportedAssets.has(a.assetId))) {
    let extra = assetBytes.get(asset.assetId)! + (current.assets.length ? 1 : 0);
    if (bytes + extra > MAX_ORIGINAL_BYTES && (current.questions.length || current.assets.length)) { flush(); extra = assetBytes.get(asset.assetId)!; }
    if (bytes + extra > MAX_ORIGINAL_BYTES) throw new Error(`assets.${asset.assetId}: 그림 하나가 20 MiB를 초과합니다. 전체 백업으로 보존하세요.`);
    current.assets.push(asset); currentAssets.add(asset.assetId); exportedAssets.add(asset.assetId); bytes += extra;
  }
  if (current.questions.length || current.assets.length || result.length === 0) result.push(current);
  return structuredClone(result);
}
