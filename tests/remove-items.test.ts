import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { initialState } from "../src/fixtures/data";
import { canonical, defaultSelection, stateSchema, type State } from "../src/domain/schema";
import { markKey, next, startSession, submit, latest, subjectSummaries } from "../src/domain/engine";
import { backup, mergeDataset, validateBackup } from "../src/data/transfer";
import { removalIds, removeItems } from "../src/data/remove-items";
import { ConflictError, Repository } from "../src/data/repository";

function fixture() {
  const s = initialState(true);
  s.dataset.datasetId = "police-personal";
  s.dataset.items = s.dataset.items.slice(0, 4);
  s.dataset.items.forEach((item, i) => {
    item.source.year = i === 1 ? 2025 : 2026;
    item.source.round = i === 2 ? "1차" : "2차";
  });
  s.dataset.taxonomies.push({ id: "police-leaf", parentId: null, label: "가상 경찰학", order: 0, subjectId: "police", origin: "custom", taxonomyVersion: 1 });
  s.dataset.items[3].subjectId = "police";
  s.dataset.items[3].primaryUnitId = "police-leaf";
  s.dataset.coverage = s.dataset.items.map((item, i) => ({ id: `coverage-${i}`, subjectId: item.subjectId, year: item.source.year, round: item.source.round, status: "complete", classificationComplete: true }));
  s.settings.fontScale = 1.5;
  return s;
}
function complete(s: State, indices: number[], balanced = false) {
  startSession(s, { ...defaultSelection, mode: balanced ? "balanced" : "cycle" }, indices.map(i => s.dataset.items[i]));
  const session = s.sessions.at(-1)!;
  while (session.status === "active") { submit(s, session.id, "unknown"); next(s, session.id); }
  return session;
}

describe("문제 삭제", () => {
  it("과목·연도·회차 AND 조건과 전체 선택", () => {
    const s = fixture();
    expect(removalIds(s, { subjectId: "constitution", year: "2026", round: "2차" })).toEqual([s.dataset.items[0].id]);
    expect(removalIds(s, { subjectId: "constitution", year: "", round: "" })).toHaveLength(3);
    expect(removalIds(s, { subjectId: "", year: "", round: "" })).toHaveLength(4);
    expect(removalIds(s, { subjectId: "police", year: "2025", round: "2차" })).toEqual([]);
  });

  it("혼합 세션의 비삭제 응답·스냅샷·통계를 보존하고 원본을 바꾸지 않는다", () => {
    const s = fixture();
    const session = complete(s, [0, 1, 2]);
    const untouched = complete(s, [2]);
    const target = s.dataset.items[0].id;
    s.marks[markKey(target, "exam")] = true;
    s.marks[markKey(target, "current")] = false;
    s.marks[markKey(s.dataset.items[1].id, "current")] = true;
    const before = canonical(s);
    const result = removeItems(s, new Set([target]));
    expect(canonical(s)).toBe(before);
    expect(result.state.dataset.items).toEqual(s.dataset.items.slice(1));
    expect(result.state.attempts).toEqual(s.attempts.filter(a => a.itemId !== target));
    expect(result.state.sessions[0]).toEqual({ ...session, items: session.items.slice(1), index: 1 });
    expect(result.state.sessions[1]).toEqual(untouched);
    expect(result.state.marks).toEqual({ [markKey(s.dataset.items[1].id, "current")]: true });
    expect(latest(result.state, s.dataset.items[1], "current")).toEqual(latest(s, s.dataset.items[1], "current"));
    expect(subjectSummaries(result.state, "current").constitution.answered).toBe(3);
    expect(result.counts).toMatchObject({ items: 1, attempts: 1, marks: 2, sessions: 0, sessionsPruned: 1, snapshots: 1 });
    expect(result.state.dataset.taxonomies).toEqual(s.dataset.taxonomies);
    expect(result.state.dataset.studyGroups).toEqual(s.dataset.studyGroups);
    expect(result.state.dataset.coverage).toEqual(s.dataset.coverage.slice(1));
    expect(result.state.settings).toEqual(s.settings);
    expect(result.state.dataset.datasetVersion).toBe(s.dataset.datasetVersion);
    expect(result.state.dataset.exportedAt).toBe(s.dataset.exportedAt);
    expect(() => stateSchema.parse(result.state)).not.toThrow();
    expect(() => validateBackup(backup(result.state, "real"), "real")).not.toThrow();
  });

  it.each([0, 1, 2])("종료 세션의 현재 위치 %i 삭제 후 공개 상태와 백업 참조를 유지한다", index => {
    for (const revealed of [false, true]) {
      const s = fixture();
      startSession(s, defaultSelection, s.dataset.items.slice(0, 3));
      const session = s.sessions[0];
      for (let i = 0; i < index; i++) { submit(s, session.id, "O"); next(s, session.id); }
      if (revealed) submit(s, session.id, "X");
      session.status = "ended";
      const result = removeItems(s, new Set([session.items[index].id]));
      expect(result.state.attempts).toEqual(s.attempts.filter(a => a.itemId !== session.items[index].id));
      expect(() => validateBackup(backup(result.state, "real"), "real")).not.toThrow();
    }
  });

  it("삭제 지문만 든 세션을 제거하고 모든 판단 버전 순회 토큰을 제거한다", () => {
    const s = fixture(); complete(s, [0]);
    const target = s.dataset.items[0].id, other = s.dataset.items[1].id;
    s.cycles.mixed = { candidates: [JSON.stringify([target, 1]), JSON.stringify([target, 2]), JSON.stringify([other, 1])], remaining: [JSON.stringify([target, 2]), JSON.stringify([other, 1])], round: 3 };
    s.cycles.only = { candidates: [JSON.stringify([target, 1])], remaining: [], round: 1 };
    s.cycles.unrelated = { candidates: [JSON.stringify([other, 1])], remaining: [], round: 8 };
    const { state, counts } = removeItems(s, new Set([target]));
    expect(state.sessions).toEqual([]); expect(state.attempts).toEqual([]);
    expect(counts.sessions).toBe(1);
    expect(state.cycles.only).toBeUndefined();
    expect(state.cycles.mixed).toEqual({ candidates: [JSON.stringify([other, 1])], remaining: [JSON.stringify([other, 1])], round: 3 });
    expect(state.cycles.unrelated).toEqual(s.cycles.unrelated);
  });

  it("같은 단원의 allocations에서 삭제 스냅샷 기여분만 차감한다", () => {
    const s = fixture(); s.dataset.items[1].primaryUnitId = s.dataset.items[0].primaryUnitId;
    complete(s, [0, 1], true); complete(s, [0], true);
    // Historical snapshot classification, not today's classification, is counted.
    const key = JSON.stringify(["constitution", "current", s.dataset.items[0].primaryUnitId]);
    s.dataset.items[0].primaryUnitId = "demo-2";
    const unrelatedKey = JSON.stringify(["constitution", "exam", "demo-2"]);
    s.allocations[unrelatedKey] = 6;
    const { state, counts } = removeItems(s, new Set([s.dataset.items[0].id]));
    expect(state.allocations[key]).toBe(1);
    expect(state.allocations[unrelatedKey]).toBe(6);
    expect(counts.allocationAssignments).toBe(2);
    expect(state.attempts).toEqual(s.attempts.filter(a => a.itemId === s.dataset.items[1].id));
  });

  it("단원별 배정 잔여량이 0이면 해당 항목만 제거한다", () => {
    const s = fixture(); complete(s, [0], true); complete(s, [1], true);
    const targetKey = JSON.stringify(["constitution", "current", s.dataset.items[0].primaryUnitId]);
    const otherKey = JSON.stringify(["constitution", "current", s.dataset.items[1].primaryUnitId]);
    const { state } = removeItems(s, new Set([s.dataset.items[0].id]));
    expect(state.allocations[targetKey]).toBeUndefined();
    expect(state.allocations[otherKey]).toBe(1);
  });

  it("전체 삭제 후 목차·설정·묶음·버전을 유지하고 새 Dataset 반입이 가능하다", () => {
    const s = fixture(); complete(s, [0, 1, 2], true);
    s.marks[markKey(s.dataset.items[0].id, "current")] = true;
    const { state } = removeItems(s, new Set(s.dataset.items.map(i => i.id)));
    expect(state.dataset.items).toEqual([]);
    expect(state.attempts).toEqual([]); expect(state.sessions).toEqual([]);
    expect(state.marks).toEqual({}); expect(state.cycles).toEqual({}); expect(state.allocations).toEqual({});
    expect(state.dataset.taxonomies).toEqual(s.dataset.taxonomies);
    expect(state.dataset.studyGroups).toEqual(s.dataset.studyGroups);
    expect(state.dataset.coverage).toEqual([]);
    expect(state.settings).toEqual(s.settings);
    expect(state.dataset.datasetVersion).toBe(s.dataset.datasetVersion);
    expect(() => validateBackup(backup(state, "real"), "real")).not.toThrow();
    expect(mergeDataset(state.dataset, s.dataset).added).toBe(4);
  });

  it("진행 중 세션은 삭제 대상이 아니어도 전체 작업을 거부한다", () => {
    const s = fixture(); startSession(s, defaultSelection, [s.dataset.items[1]]);
    const before = canonical(s);
    expect(() => removeItems(s, new Set([s.dataset.items[0].id]))).toThrow("진행 중 세션을 종료한 뒤 삭제하세요.");
    expect(canonical(s)).toBe(before);
  });

  it("대상 0개는 변경이 없고 같은 삭제를 반복해도 비삭제 기록은 유지된다", () => {
    const s = fixture(); complete(s, [1]);
    expect(removeItems(s, new Set(["missing"])).state).toEqual(s);
    const ids = new Set([s.dataset.items[0].id]);
    const once = removeItems(s, ids);
    expect(removeItems(once.state, ids).state).toEqual(once.state);
  });

  it.each(["real", "demo"] as const)("%s 삭제 저장은 다른 namespace에 영향을 주지 않는다", async namespace => {
    const repo = new Repository(crypto.randomUUID());
    const real = fixture(), demo = initialState(true);
    await repo.save("real", real, 0); await repo.save("demo", demo, 0);
    const current = await repo.load(namespace);
    const otherNamespace = namespace === "real" ? "demo" : "real";
    const before = await repo.load(otherNamespace);
    const removed = removeItems(current.state, new Set(current.state.dataset.items.map(i => i.id)));
    await repo.save(namespace, removed.state, current.generation);
    expect((await repo.load(namespace)).state.dataset.items).toEqual([]);
    expect(await repo.load(otherNamespace)).toEqual(before);
    await expect(repo.save(namespace, current.state, current.generation)).rejects.toBeInstanceOf(ConflictError);
    await repo.close();
  });
});
