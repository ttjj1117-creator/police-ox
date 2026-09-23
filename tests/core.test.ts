import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { initialState } from "../src/fixtures/data";
import {
  canonical,
  defaultSelection,
  parseDataset,
  Selection,
} from "../src/domain/schema";
import {
  candidates,
  cycleInfo,
  eligible,
  latest,
  markKey,
  next,
  selectItems,
  startSession,
  submit,
  summary,
  weak,
} from "../src/domain/engine";
import {
  backup,
  mergeDataset,
  parseFile,
  validateBackup,
} from "../src/data/transfer";
import { ConflictError, Repository } from "../src/data/repository";

const q: Selection = { ...defaultSelection, basis: "exam" };
describe("데이터·검증", () => {
  it("빈 실제 데이터와 시연 자료를 검증한다", () => {
    expect(parseDataset(initialState().dataset).items).toHaveLength(0);
    expect(parseDataset(initialState(true).dataset).items).toHaveLength(7);
  });
  it("draft/hold/retired/미확인 현행은 출제하지 않는다", () => {
    const s = initialState(true);
    s.dataset.items.forEach((item) => {
      item.judgments.current.status = "draft";
    });
    expect(candidates(s, { ...q, basis: "current" })).toHaveLength(0);
    s.dataset.items[0].judgments.exam.status = "draft";
    s.dataset.items[1].judgments.exam.status = "hold";
    s.dataset.items[2].lifecycle = "retired";
    s.dataset.items[3].originalVerified = false;
    expect(candidates(s, q)).toHaveLength(3);
  });
  it("검증 필수값, 잘못된 URL, 중복, 참조, 순환을 거부한다", () => {
    for (const mutate of [
      (d: any) => (d.items[0].judgments.exam.evidence = []),
      (d: any) =>
        (d.items[0].judgments.exam.evidence[0].url = "javascript:alert(1)"),
      (d: any) => d.items.push(d.items[0]),
      (d: any) => (d.items[0].primaryUnitId = "missing"),
      (d: any) => (d.taxonomies[0].parentId = "demo-0"),
      (d: any) => (d.schemaVersion = 2),
      (d: any) => (d.items[0].judgments.exam.asOfDate = "2026-02-31"),
    ]) {
      const d = initialState(true).dataset;
      mutate(d);
      expect(() => parseDataset(d)).toThrow();
    }
  });
  it("같은 ID 개정 충돌을 거부하고 누락 자료를 유지한다", () => {
    const d = initialState(true).dataset;
    const incoming = structuredClone(d);
    incoming.items = [incoming.items[0]];
    expect(mergeDataset(d, incoming).dataset.items).toHaveLength(7);
    incoming.items[0].displayText = "변경";
    expect(() => mergeDataset(d, incoming)).toThrow(/revision/);
    incoming.items[0].revision++;
    expect(mergeDataset(d, incoming).updated).toBe(1);
    incoming.items[0].judgments.exam.shortReason = "새 근거";
    expect(() => mergeDataset(d, incoming)).toThrow(/judgmentRevision/);
    incoming.items[0].judgments.exam.judgmentRevision++;
    expect(mergeDataset(d, incoming).updated).toBe(1);
  });
  it("자료형과 20MB 크기 제한을 검사한다", () => {
    expect(() => parseFile("{")).toThrow();
    expect(() => parseFile(" ".repeat(20 * 1024 * 1024 + 1))).toThrow(/20MB/);
    const d = initialState(true).dataset;
    (d.items[0] as any).revision = "1";
    expect(() => parseDataset(d)).toThrow();
  });
});
describe("출제·응답 엔진", () => {
  it("상위/하위 합집합에 중복이 없고 부족한 후보만 출제한다", () => {
    const s = initialState(true);
    const a = candidates(s, { ...q, unitIds: ["demo-root", "demo-0"] });
    expect(a).toHaveLength(7);
    expect(new Set(a.map((v) => v.id)).size).toBe(7);
    expect(selectItems(s, q).items).toHaveLength(7);
  });
  it("묶음 단원 조건 뒤 태그를 적용하고 분류 보류를 제외한다", () => {
    const s = initialState(true);
    s.dataset.items[0].primaryUnitId = null;
    s.dataset.studyGroups[0].optionalAnyTags = ["특정"];
    s.dataset.items[1].tags = ["특정"];
    expect(
      candidates(s, { ...q, view: "groups", groupIds: ["demo-group"] }),
    ).toHaveLength(1);
    expect(candidates(s, { ...q, unitIds: ["demo-root"] })).toHaveLength(6);
    expect(candidates(s, q)).toHaveLength(7);
  });
  it("단원 후보 2/8/20에서 9개를 균형 배정한다", () => {
    const s = initialState(true),
      base = s.dataset.items[0];
    s.dataset.items = [2, 8, 20].flatMap((n, b) =>
      Array.from({ length: n }, (_, i) => ({
        ...structuredClone(base),
        id: `b${b}-${i}`,
        primaryUnitId: `demo-${b}`,
      })),
    );
    const items = selectItems(s, { ...q, mode: "balanced", limit: 10 }).items;
    expect(items).toHaveLength(10);
    const result = selectItems(s, {
      ...q,
      mode: "balanced",
      limit: 9 as any,
    }).items;
    expect(
      [0, 1, 2]
        .map(
          (b) => result.filter((v) => v.primaryUnitId === `demo-${b}`).length,
        )
        .sort(),
    ).toEqual([2, 3, 4]);
    expect(new Set(result.map((v) => v.id)).size).toBe(9);
  });
  it("25개 순회를 10→10→5로 유지하고 완료 후 자동 반복하지 않는다", () => {
    const s = initialState(true),
      base = s.dataset.items[0];
    s.dataset.items = Array.from({ length: 25 }, (_, i) => ({
      ...structuredClone(base),
      id: `q-${i}`,
    }));
    const counts = [];
    for (let round = 0; round < 3; round++) {
      startSession(s, { ...q, limit: 10 });
      const ss = s.sessions.at(-1)!;
      counts.push(ss.items.length);
      while (ss.status === "active") {
        submit(s, ss.id, "O");
        next(s, ss.id);
      }
    }
    expect(counts).toEqual([10, 10, 5]);
    expect(new Set(s.attempts.map((a) => a.itemId)).size).toBe(25);
    expect(selectItems(s, q).complete).toBe(true);
  });
  it("중도 종료의 미응답은 순회에 남는다", () => {
    const s = initialState(true);
    startSession(s, q);
    const ss = s.sessions[0];
    submit(s, ss.id, "unknown");
    ss.status = "ended";
    expect(selectItems(s, q).items).toHaveLength(6);
    expect(summary(s.attempts)).toMatchObject({
      answered: 1,
      unknown: 1,
      rate: "0%",
    });
  });
  it("답을 한 번만 기록하고 이후 정답은 자동 오답을 해소한다", () => {
    const s = initialState(true);
    startSession(s, q);
    const ss = s.sessions[0],
      v = ss.items[0];
    submit(s, ss.id, "unknown");
    submit(s, ss.id, "O");
    expect(s.attempts).toHaveLength(1);
    expect(weak(s, v, "exam")).toBe(true);
    s.marks[markKey(v.id, "exam")] = true;
    ss.status = "ended";
    startSession(s, q, [v]);
    const later = s.sessions[1];
    submit(s, later.id, v.judgments.exam.answer!);
    s.attempts[1].answeredAt = "2099-01-01T00:00:00.000Z";
    expect(latest(s, v, "exam")?.result).toBe("correct");
    expect(weak(s, v, "exam")).toBe(true);
    s.marks[markKey(v.id, "exam")] = false;
    expect(weak(s, v, "exam")).toBe(false);
  });
  it("단원 이동은 기록 유지, 새 판단은 미풀이이고 과거 응답은 보존한다", () => {
    const s = initialState(true);
    startSession(s, q);
    const ss = s.sessions[0];
    submit(s, ss.id, "O");
    const v = s.dataset.items.find((v) => v.id === ss.items[0].id)!;
    v.primaryUnitId = "demo-2";
    v.revision++;
    expect(latest(s, v, "exam")).toBeDefined();
    v.judgments.exam.judgmentRevision++;
    expect(latest(s, v, "exam")).toBeUndefined();
    expect(s.attempts).toHaveLength(1);
    expect(cycleInfo(s, q).changed).toBe(true);
  });
  it("취약 후보가 없으면 일반 문제로 대체하지 않는다", () => {
    expect(
      selectItems(initialState(true), { ...q, mode: "weak" }).items,
    ).toHaveLength(0);
    expect(summary([]).rate).toBe("—");
  });
});
describe("백업·IndexedDB 원자성", () => {
  it("세션과 공개 상태까지 백업 왕복이 일치한다", () => {
    const s = initialState(true);
    startSession(s, q);
    submit(s, s.sessions[0].id, "X");
    expect(
      canonical(
        validateBackup(JSON.parse(JSON.stringify(backup(s, "demo"))), "demo"),
      ),
    ).toBe(canonical(s));
    expect(() => validateBackup(backup(s, "demo"), "real")).toThrow(/영역/);
    const b = backup(structuredClone(s), "demo");
    b.state.sessions[0].revealed = false;
    expect(() => validateBackup(b, "demo")).toThrow(/공개 상태/);
  });
  it("실제/시연 분리, 저장 복구, 낡은 탭의 쓰기 거부", async () => {
    const repo = new Repository(crypto.randomUUID());
    const real = await repo.load("real"),
      demo = await repo.load("demo");
    startSession(demo.state, q);
    submit(demo.state, demo.state.sessions[0].id, "unknown");
    await repo.save("demo", demo.state, 0);
    expect((await repo.load("real")).state.attempts).toHaveLength(0);
    expect((await repo.load("real")).state.dataset.items).toHaveLength(0);
    const restored = await repo.load("demo");
    expect(restored.state.sessions[0].revealed).toBe(true);
    await expect(repo.save("demo", real.state, 0)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await repo.load("demo")).state.attempts).toHaveLength(1);
    await repo.close();
  });
  it("쓰기 실패하면 저장된 원본을 유지한다", async () => {
    const repo = new Repository(crypto.randomUUID());
    const e = await repo.load("real");
    await repo.save("real", e.state, 0);
    const invalid: any = structuredClone(e.state);
    invalid.uncloneable = () => {};
    await expect(repo.save("real", invalid, 1)).rejects.toThrow();
    expect((await repo.load("real")).generation).toBe(1);
    await repo.close();
  });
});
