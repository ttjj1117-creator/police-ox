import { canonical, parseDataset, type Dataset } from "../src/domain/schema";
import { eligible } from "../src/domain/engine";
import { mergeDataset, parseFile, validateBackup } from "../src/data/transfer";
import { emptyDataset } from "../src/fixtures/data";

export function readBaseline(value: unknown): Dataset {
  const dataset = value && typeof value === "object" && "backupSchemaVersion" in value
    ? validateBackup(value, "real").dataset
    : parseDataset(value);
  if (dataset.datasetId !== "police-personal")
    throw new Error("기준 데이터의 datasetId는 police-personal이어야 합니다.");
  return dataset;
}

/** The user-authorized policy is an initial baseline, not legal verification. */
export function finalizeItems(
  value: unknown,
  options: { exportedAt: string; existing?: Dataset },
) {
  if (!Array.isArray(value) || !value.length)
    throw new Error("비어 있지 않은 Item[] 입력이 필요합니다.");
  const catalog = emptyDataset();
  const source = {
    ...catalog, exportedAt: options.exportedAt, items: structuredClone(value),
  };
  // Validate against the FULL catalog before selecting ancestors: otherwise a
  // non-leaf reference could appear to be a leaf in the reduced output.
  const checked = parseDataset(source);
  if (canonical(checked) !== canonical(source))
    throw new Error("스키마 정규화가 입력 내용을 변경합니다. 자동 변환하지 않습니다.");

  let promoted = 0;
  for (const item of checked.items) {
    const { exam, current } = item.judgments;
    if (canonical(current) === canonical(exam)) {
      if (!eligible(item, "current"))
        throw new Error(`${item.id}: 학습 가능한 verified 판단이 필요합니다.`);
      continue;
    }
    const emptyCurrent = current.status === "draft" && current.answer === null &&
      current.verifiedAt === null && current.asOfDate === null &&
      current.shortReason === "" && current.keyPoint === "" &&
      current.corrections.length === 0 && current.evidence.length === 0;
    if (!emptyCurrent)
      throw new Error(`${item.id}: 기존 current 내용은 덮어쓰지 않습니다.`);
    if (!eligible(item, "exam"))
      throw new Error(`${item.id}: baseline 원본은 active·원문 대조·verified 필수조건을 충족해야 합니다.`);
    if (exam.judgmentRevision < current.judgmentRevision)
      throw new Error(`${item.id}: current 판단 버전을 낮출 수 없습니다.`);
    item.judgments.current = structuredClone(exam);
    promoted++;
  }

  const byId = new Map(catalog.taxonomies.map(n => [n.id, n]));
  const selected = new Set<string>();
  for (const item of checked.items) {
    for (const ref of [item.areaId, item.primaryUnitId, ...item.relatedUnitIds]) {
      let id = ref;
      while (id) {
        if (selected.has(id)) break;
        const node = byId.get(id);
        if (!node) throw new Error(`${item.id}: canonical taxonomy에 없는 ID ${id}`);
        selected.add(id);
        id = node.parentId;
      }
    }
  }
  const existing = options.existing ? readBaseline(options.existing) : undefined;
  const output = {
    ...checked,
    datasetVersion: existing?.datasetVersion ?? 1,
    taxonomies: catalog.taxonomies.filter(n => selected.has(n.id)),
    studyGroups: [], coverage: [],
  };
  let dataset = parseDataset(output);
  let merge: { added: number; updated: number; unchanged: number } | null = null;
  if (existing) {
    const result = mergeDataset(existing, dataset);
    merge = { added: result.added, updated: result.updated, unchanged: result.unchanged };
  }
  // Verify the exact serialized artifact, including the app's file size limit.
  const json = JSON.stringify(dataset, null, 2) + "\n";
  dataset = parseDataset(parseFile(json));
  return {
    dataset, json,
    report: {
      policy: "exam-to-current-initial-baseline-v1",
      inputItems: value.length, outputItems: dataset.items.length,
      promoted, taxonomies: dataset.taxonomies.length,
      datasetId: dataset.datasetId, datasetVersion: dataset.datasetVersion,
      currentEligible: dataset.items.filter(item => eligible(item, "current")).length,
      datasetValidation: "passed", merge,
      mergeStatus: existing ? "passed against supplied baseline" : "not run: no real Dataset/backup supplied",
    },
  };
}
