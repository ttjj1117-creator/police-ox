import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { Repository } from "../src/data/repository";
import { initialOriginalState, startSession, defaultSelection, answer, finish } from "../src/original/engine";
import { OriginalRepository, validateFullBackup } from "../src/original/storage";

const now = Date.parse("2026-10-21T00:00:00Z");
describe("원문 영구 저장·통합 백업", () => {
  it("기존 OX를 보존하고 두 탭의 같은 영역 쓰기를 충돌 감지한다", async () => {
    const name = crypto.randomUUID(), ox = new Repository(name), one = new OriginalRepository(name), two = new OriginalRepository(name);
    const legacy = await ox.load("demo"); legacy.state.settings.fontScale = 1.5;
    await ox.save("demo", legacy.state, legacy.generation);
    const loaded = await one.load("demo"), stale = await two.load("demo");
    loaded.state.marks[loaded.state.data.questions[0].id] = true;
    await one.save("demo", loaded.state, loaded.generation);
    await expect(two.save("demo", stale.state, stale.generation)).rejects.toThrow("다른 탭");
    expect((await ox.load("demo")).state.settings.fontScale).toBe(1.5);
    expect((await one.load("real")).state.data.questions).toHaveLength(0);
    await Promise.all([ox.close(), one.close(), two.close()]);
  });
  it("전체 백업은 원문·OX를 함께 복원하며 잘못된 복구는 기존 내용을 유지한다", async () => {
    const name = crypto.randomUUID(), repo = new OriginalRepository(name), ox = new Repository(name);
    const original = await repo.load("demo");
    const q = original.state.data.questions[0];
    const session = startSession(original.state, "demo", defaultSelection, "study", now, [q]);
    answer(original.state, session.id, "unknown", now + 1); finish(original.state, session.id, now + 2);
    original.state.marks[q.id] = true;
    await repo.save("demo", original.state, 0);
    const backup = await repo.fullBackup("demo");
    await expect(validateFullBackup(backup, "demo")).resolves.toBeDefined();
    await expect(validateFullBackup(backup, "real")).rejects.toThrow("영역");
    const changed = await repo.load("demo"); changed.state.settings.fontScale = 2;
    await repo.save("demo", changed.state, changed.generation);
    const bad = structuredClone(backup); bad.original.attempts[0].result = "correct";
    await expect(repo.restore("demo", bad, 2)).rejects.toThrow("불일치");
    expect((await repo.load("demo")).state.settings.fontScale).toBe(2);
    const restored = await repo.restore("demo", backup, 2);
    expect(restored.state.settings.fontScale).toBe(1);
    expect(restored.state.attempts).toHaveLength(1);
    expect(restored.state.marks[q.id]).toBe(true);
    expect((await ox.load("demo")).state.dataset.items.length).toBeGreaterThan(0);
    await Promise.all([repo.close(), ox.close()]);
  });
  it("쓰기 실패 시 성공으로 반환하지 않고 직전 원자적 상태를 보존한다", async () => {
    const repo = new OriginalRepository(crypto.randomUUID());
    const state = initialOriginalState("real");
    await repo.save("real", state, 0);
    const broken = { ...state, impossible: () => {} };
    await expect(repo.save("real", broken, 1)).rejects.toBeDefined();
    expect((await repo.load("real")).generation).toBe(1);
    expect((await repo.load("real")).state).toEqual(state);
    await repo.close();
  });
  it("활성 원문 세션 중 문제 데이터 변경을 저장 단계에서도 막는다", async () => {
    const repo = new OriginalRepository(crypto.randomUUID());
    const loaded = await repo.load("demo"); startSession(loaded.state, "demo", defaultSelection, "study", now);
    const saved = await repo.save("demo", loaded.state, loaded.generation);
    const originalCount = saved.state.data.questions.length;
    saved.state.data.questions.pop();
    await expect(repo.save("demo", saved.state, saved.generation)).rejects.toThrow("종료");
    expect((await repo.load("demo")).state.data.questions.length).toBe(originalCount);
    await repo.close();
  });
  it("복구 미리보기 이후 OX 변경 또는 진행 중 OX 세션을 덮어쓰지 않는다", async () => {
    const name = crypto.randomUUID(), repo = new OriginalRepository(name), ox = new Repository(name);
    const backup = await repo.fullBackup("demo");
    const oxBefore = await ox.load("demo");
    oxBefore.state.settings.fontScale = 1.5;
    await ox.save("demo", oxBefore.state, oxBefore.generation);
    await expect(repo.restore("demo", backup, 0, 0)).rejects.toThrow("다른 탭");
    expect((await ox.load("demo")).state.settings.fontScale).toBe(1.5);
    const { startSession: startOx } = await import("../src/domain/engine");
    const { defaultSelection: defaultOx } = await import("../src/domain/schema");
    const current = await ox.load("demo");
    startOx(current.state, { ...defaultOx, basis: "exam" });
    await ox.save("demo", current.state, current.generation);
    await expect(repo.restore("demo", backup, 0, 2)).rejects.toThrow("OX 풀이");
    expect((await repo.load("demo")).generation).toBe(0);
    await Promise.all([repo.close(), ox.close()]);
  });
  it("통합 복구의 두 번째 쓰기가 실패하면 원문과 OX가 함께 롤백된다", async () => {
    const name = crypto.randomUUID(), repo = new OriginalRepository(name), ox = new Repository(name);
    const original = await repo.load("demo");
    await repo.save("demo", original.state, 0);
    const oldOx = await ox.load("demo"); await ox.save("demo", oldOx.state, 0);
    const backup = await repo.fullBackup("demo");
    original.state.settings.fontScale = 2;
    await repo.save("demo", original.state, 1);
    const currentOx = await ox.load("demo"); currentOx.state.settings.fontScale = 1.5;
    await ox.save("demo", currentOx.state, 1);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value, key) {
      if (key === "demo") throw new DOMException("저장 공간 부족", "QuotaExceededError");
      return put.call(this, value, key);
    });
    try { await expect(repo.restore("demo", backup, 2, 2)).rejects.toThrow("저장 공간 부족"); }
    finally { spy.mockRestore(); }
    expect((await repo.load("demo")).generation).toBe(2);
    expect((await repo.load("demo")).state.settings.fontScale).toBe(2);
    expect((await ox.load("demo")).generation).toBe(2);
    expect((await ox.load("demo")).state.settings.fontScale).toBe(1.5);
    await Promise.all([repo.close(), ox.close()]);
  });
  it("풀이 스냅샷만 남기고 문제 은행을 누락한 백업을 거부하며 기존 상태를 보존한다", async () => {
    const repo = new OriginalRepository(crypto.randomUUID());
    const loaded = await repo.load("demo"), q = loaded.state.data.questions[0];
    const session = startSession(loaded.state, "demo", defaultSelection, "study", now, [q]);
    answer(loaded.state, session.id, "unknown", now + 1); finish(loaded.state, session.id, now + 2);
    await repo.save("demo", loaded.state, 0);
    const backup = await repo.fullBackup("demo");
    const missingBank = structuredClone(backup);
    missingBank.original.data.questions = [];
    missingBank.original.data.packages = [];
    await expect(repo.restore("demo", missingBank, 1)).rejects.toThrow("문제 은행");
    expect((await repo.load("demo")).generation).toBe(1);
    expect((await repo.load("demo")).state.data.questions).toHaveLength(100);
    const olderCurrent = structuredClone(backup);
    olderCurrent.original.data.packages = [];
    olderCurrent.original.sessions[0].questions[0].revision = 2;
    await expect(validateFullBackup(olderCurrent, "demo")).rejects.toThrow("문제 은행");
    const sameRevisionChanged = structuredClone(backup);
    sameRevisionChanged.original.sessions[0].questions[0].body = [{ type: "text", text: "스냅샷 내용 불일치" }];
    await expect(validateFullBackup(sameRevisionChanged, "demo")).rejects.toThrow("문제 은행");
    await repo.close();
  });
});
