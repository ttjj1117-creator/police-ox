import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { finalizeItems, readBaseline } from "../scripts/finalize-items";
import { emptyDataset, initialState } from "../src/fixtures/data";
import { canonical, defaultSelection, parseDataset } from "../src/domain/schema";
import { backup, mergeDataset, validateBackup } from "../src/data/transfer";
import { startSession, submit } from "../src/domain/engine";

const exportedAt = "2026-09-23T12:00:00.000Z";
function inputs() {
  const item = initialState(true).dataset.items[0];
  const catalog = emptyDataset().taxonomies;
  const leaf = catalog.find(n => n.subjectId === "constitution" && !catalog.some(c => c.parentId === n.id))!;
  item.primaryUnitId = leaf.id;
  item.areaId = null;
  item.judgments.current = {
    answer: null, status: "draft", judgmentRevision: 1,
    verifiedAt: null, asOfDate: null, shortReason: "", keyPoint: "",
    corrections: [], evidence: [],
  };
  return [item];
}

describe("Item[] 최종화", () => {
  it("원본과 exam 및 법률 필드를 보존하며 canonical 조상만 포함한다", () => {
    const input = inputs();
    const before = canonical(input);
    const { dataset, report, json } = finalizeItems(input, { exportedAt });
    expect(canonical(input)).toBe(before);
    expect(dataset.items[0]).toEqual({ ...input[0], judgments: {
      exam: input[0].judgments.exam, current: input[0].judgments.exam,
    } });
    expect(report.promoted).toBe(1);
    expect(report.currentEligible).toBe(1);
    const catalog = emptyDataset().taxonomies;
    const expected = new Set<string>();
    let id: string | null = input[0].primaryUnitId;
    while (id) { expected.add(id); id = catalog.find(n => n.id === id)!.parentId; }
    expect(dataset.taxonomies).toEqual(catalog.filter(n => expected.has(n.id)));
    expect(dataset.coverage).toEqual([]);
    expect(dataset.studyGroups).toEqual([]);
    expect(parseDataset(JSON.parse(json))).toEqual(dataset);
    expect(report.merge).toBeNull();
  });

  it("relatedUnitIds와 areaId의 조상도 수집하고 null 분류는 보존한다", () => {
    const input = inputs();
    const nodes = emptyDataset().taxonomies.filter(n => n.subjectId === "constitution");
    input[0].relatedUnitIds = [nodes.at(-1)!.id];
    input[0].primaryUnitId = null;
    input[0].areaId = nodes[0].id;
    const { dataset } = finalizeItems(input, { exportedAt });
    expect(dataset.items[0].primaryUnitId).toBeNull();
    expect(dataset.taxonomies.some(n => n.id === nodes.at(-1)!.id)).toBe(true);
    expect(dataset.taxonomies.some(n => n.id === nodes[0].id)).toBe(true);
  });

  it("비말단·없는 ID·과목 불일치 분류와 중복 ID는 실패한다", () => {
    for (const primary of ["missing", "criminal-law", emptyDataset().taxonomies[0].id]) {
      const input = inputs(); input[0].primaryUnitId = primary;
      expect(() => finalizeItems(input, { exportedAt })).toThrow();
    }
    const input = inputs(); input.push(structuredClone(input[0]));
    expect(() => finalizeItems(input, { exportedAt })).toThrow(/중복 ID/);
  });

  it("미허용 필드·암묵적 trim·빈 입력·잘못된 verified는 거부한다", () => {
    const extra = inputs(); (extra[0] as any).highlights = [];
    expect(() => finalizeItems(extra, { exportedAt })).toThrow();
    const spaced = inputs(); spaced[0].originalText += " ";
    expect(() => finalizeItems(spaced, { exportedAt })).toThrow(/정규화/);
    expect(() => finalizeItems([], { exportedAt })).toThrow();
    const invalid = inputs(); invalid[0].judgments.exam.evidence = [];
    expect(() => finalizeItems(invalid, { exportedAt })).toThrow();
  });

  it("내용 있는 current·hold·검증 안 된 exam을 자동 승격하지 않는다", () => {
    const note = inputs(); note[0].judgments.current.shortReason = "보존할 내용";
    expect(() => finalizeItems(note, { exportedAt })).toThrow(/덮어쓰지/);
    const hold = inputs(); hold[0].judgments.current.status = "hold";
    expect(() => finalizeItems(hold, { exportedAt })).toThrow(/덮어쓰지/);
    const draft = inputs(); draft[0].judgments.exam.status = "draft";
    expect(() => finalizeItems(draft, { exportedAt })).toThrow(/baseline/);
  });

  it("신규 변경 묶음도 정보성 datasetVersion을 올리지 않고 반복 실행은 미변경이다", () => {
    const existing = emptyDataset(); existing.datasetVersion = 7;
    const before = canonical(existing);
    const first = finalizeItems(inputs(), { exportedAt, existing });
    expect(first.dataset.datasetVersion).toBe(7);
    expect(first.report.merge).toEqual({ added: 1, updated: 0, unchanged: 0 });
    expect(canonical(existing)).toBe(before);
    const baseline = mergeDataset(existing, first.dataset).dataset;
    const again = finalizeItems(inputs(), { exportedAt, existing: baseline });
    expect(again.dataset.datasetVersion).toBe(7);
    expect(again.report.merge).toEqual({ added: 0, updated: 0, unchanged: 1 });
    const already = finalizeItems(first.dataset.items, { exportedAt });
    expect(already.report.promoted).toBe(0);
  });

  it("기존 같은 revision의 다른 판단은 버전 증가로 우회하지 않는다", () => {
    const first = finalizeItems(inputs(), { exportedAt }).dataset;
    const changed = inputs(); changed[0].judgments.exam.shortReason = "다른 이유";
    expect(() => finalizeItems(changed, { exportedAt, existing: first })).toThrow(/revision/);
    const input = inputs(); input[0].judgments.current.judgmentRevision = 2;
    expect(() => finalizeItems(input, { exportedAt })).toThrow(/버전/);
  });

  it("실제 백업을 읽고 기존 세션 스냅샷·응답·목차·묶음을 보존한다", () => {
    const state = initialState();
    const first = finalizeItems(inputs(), { exportedAt });
    state.dataset = mergeDataset(state.dataset, first.dataset).dataset;
    startSession(state, defaultSelection);
    submit(state, state.sessions[0].id, "unknown");
    const original = backup(state, "real");
    const before = canonical(original);
    const input = inputs(); input[0].id = "new-item";
    const result = finalizeItems(input, { exportedAt, existing: readBaseline(original) });
    expect(canonical(original)).toBe(before);
    const after = structuredClone(original);
    after.state.dataset = mergeDataset(after.state.dataset, result.dataset).dataset;
    expect(validateBackup(after, "real").attempts).toEqual(state.attempts);
    expect(after.state.sessions).toEqual(state.sessions);
    expect(after.state.dataset.items).toHaveLength(2);
    expect(after.state.dataset.taxonomies).toEqual(state.dataset.taxonomies);
    expect(() => readBaseline(backup(initialState(true), "demo"))).toThrow();
    const foreign = emptyDataset(); foreign.datasetId = "foreign";
    expect(() => readBaseline(foreign)).toThrow(/police-personal/);
  });

  it("taxonomy 충돌도 덮어쓰지 않고 실패한다", () => {
    const existing = emptyDataset();
    const input = inputs();
    existing.taxonomies.find(n => n.id === input[0].primaryUnitId)!.label = "사용자 변경";
    expect(() => finalizeItems(input, { exportedAt, existing })).toThrow(/taxonomyVersion/);
  });

  it("CLI는 원본·기존 출력 파일을 덮어쓰지 않으며 검증 실패 시 출력하지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "ox-finalize-"));
    try {
      const input = join(dir, "input.json"), output = join(dir, "output.json");
      const raw = JSON.stringify(inputs()); writeFileSync(input, raw);
      const run = (out: string) => spawnSync(process.execPath, [
        "--import", "tsx", resolve("scripts/finalize-items-cli.ts"),
        "--input", input, "--output", out,
      ], { encoding: "utf8" });
      expect(run(input).status).toBe(1);
      expect(readFileSync(input, "utf8")).toBe(raw);
      const success = run(output);
      expect(success.stderr).toBe(""); expect(success.status).toBe(0);
      const saved = readFileSync(output, "utf8");
      expect(run(output).status).toBe(1);
      expect(readFileSync(output, "utf8")).toBe(saved);
      writeFileSync(input, "[]");
      const invalid = join(dir, "invalid.json");
      expect(run(invalid).status).toBe(1); expect(existsSync(invalid)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
