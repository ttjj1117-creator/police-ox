import { describe, expect, it } from "vitest";
import { applyPackageDeletion, previewPackageDeletion, unassignedQuestionIds } from "../src/original/deletion";
import { answer, defaultSelection, finish, initialOriginalState, selectQuestions, startSession, weakQuestions } from "../src/original/engine";
import { validateOriginalState } from "../src/original/storage";
import { previewMerge } from "../src/original/validation";
import type { Asset } from "../src/original/model";

const now = Date.parse("2026-10-22T00:00:00Z");
const selection = { ...defaultSelection, subjectId: "", limit: 0 };
function fixture() {
  const state = initialOriginalState("demo");
  const source = state.data.packages[0];
  const [one, shared, three] = structuredClone(state.data.questions.slice(0, 3));
  const oldShared = structuredClone(shared);
  shared.revision = 2;
  shared.qa.notes.push("새 묶음에서 확인한 메모");
  state.data.questions = [one, shared, three];
  state.data.packages = [
    { ...source, packageId: "file-a", questions: structuredClone([one, shared]), assets: [] },
    { ...source, packageId: "file-b", questions: structuredClone([oldShared, three]), assets: [] },
  ];
  return { state, one, shared, three };
}
async function png(assetId: string): Promise<Asset> {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=";
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { assetId, mimeType: "image/png", base64, sha256 };
}

describe("가져온 원문 파일 선택 삭제", () => {
  it("미리보기는 변경하지 않고 선택 파일 전용 문항만 제거하며 공유 문항 최신 버전을 유지한다", async () => {
    const { state, one, shared } = fixture();
    state.marks[one.id] = true; state.marks[shared.id] = true;
    const before = structuredClone(state);
    const preview = previewPackageDeletion(state, ["file-a"]);
    expect(preview).toMatchObject({ packageIds: ["file-a"], includeUnassigned: false, questionIds: [one.id], removeCount: 1, archiveCount: 0, sharedCount: 1, assetCount: 0 });
    expect(state).toEqual(before);
    expect(applyPackageDeletion(state, ["file-a"])).toEqual(preview);
    expect(state.data.packages.map((p) => p.packageId)).toEqual(["file-b"]);
    expect(state.data.questions).toHaveLength(2);
    expect(state.data.questions.find((q) => q.id === shared.id)).toEqual(shared);
    expect(state.data.questions.find((q) => q.id === shared.id)?.revision).toBe(2);
    expect(state.marks[one.id]).toBeUndefined();
    expect(state.marks[shared.id]).toBe(true);
    expect(state.removedQuestionIds).toBeUndefined();
    await expect(validateOriginalState(state, "demo")).resolves.toBeDefined();
  });
  it("풀이 이력 문항은 내용·버전을 그대로 보관하고 출제·다시 풀기에서 숨긴 뒤 같은 파일을 재등록할 수 있다", async () => {
    const { state, one } = fixture();
    const originalFile = structuredClone(state.data.packages[0]);
    const session = startSession(state, "demo", selection, "study", now, [one]);
    answer(state, session.id, "unknown", now + 1); finish(state, session.id, now + 2);
    state.marks[one.id] = true;
    const history = structuredClone({ sessions: state.sessions, attempts: state.attempts });
    const originalQuestion = structuredClone(one);
    expect(applyPackageDeletion(state, ["file-a"])).toMatchObject({ removeCount: 0, archiveCount: 1, sharedCount: 1 });
    expect(state.removedQuestionIds).toEqual([one.id]);
    expect(state.data.questions.find((q) => q.id === one.id)).toEqual(originalQuestion);
    expect({ sessions: state.sessions, attempts: state.attempts }).toEqual(history);
    expect(state.marks[one.id]).toBeUndefined();
    expect(selectQuestions(state, "demo", selection).some((q) => q.id === one.id)).toBe(false);
    expect(weakQuestions(state, session)).toHaveLength(0);
    expect(() => startSession(state, "demo", selection, "study", now + 3, session.questions)).toThrow("없습니다");
    await expect(validateOriginalState(state, "demo")).resolves.toBeDefined();
    const restored = await previewMerge(state.data, originalFile, "demo");
    state.data = restored.data;
    // The import UI clears these explicit local markers for incoming IDs.
    state.removedQuestionIds = state.removedQuestionIds.filter((id) => !originalFile.questions.some((q) => q.id === id));
    expect(restored.unchanged).toBe(2);
    expect(selectQuestions(state, "demo", selection).some((q) => q.id === one.id)).toBe(true);
    expect({ sessions: state.sessions, attempts: state.attempts }).toEqual(history);
    await expect(validateOriginalState(state, "demo")).resolves.toBeDefined();
  });
  it("진행 중 풀이·빈 선택·중복·오래된 파일 선택은 전체를 변경하지 않고 거부한다", () => {
    const { state } = fixture(), before = structuredClone(state);
    for (const ids of [[], ["missing"], ["file-a", "missing"], ["file-a", "file-a"], [""]]) {
      expect(() => applyPackageDeletion(state, ids)).toThrow();
      expect(state).toEqual(before);
    }
    startSession(state, "demo", selection, "study", now);
    const activeBefore = structuredClone(state);
    expect(() => previewPackageDeletion(state, ["file-a"])).toThrow("진행 중");
    expect(() => applyPackageDeletion(state, ["file-a"])).toThrow("진행 중");
    expect(state).toEqual(activeBefore);
  });
  it("파일 연결이 없는 문제는 별도로 선택했을 때만 삭제하고 기존 보관 표시는 대상에서 제외한다", async () => {
    const { state, three } = fixture();
    state.data.packages[1].questions = state.data.packages[1].questions.filter((q) => q.id !== three.id);
    expect(unassignedQuestionIds(state)).toEqual([three.id]);
    expect(previewPackageDeletion(state, ["file-a"]).questionIds).not.toContain(three.id);
    const preview = previewPackageDeletion(state, [], true);
    expect(preview).toMatchObject({ packageIds: [], includeUnassigned: true, questionIds: [three.id], removeCount: 1 });
    applyPackageDeletion(state, [], true);
    expect(state.data.packages).toHaveLength(2);
    expect(state.data.questions.some((q) => q.id === three.id)).toBe(false);
    expect(() => applyPackageDeletion(state, [], true)).toThrow("선택");
    await expect(validateOriginalState(state, "demo")).resolves.toBeDefined();
    const { state: archived, one } = fixture();
    const session = startSession(archived, "demo", selection, "study", now, [one]); finish(archived, session.id, now + 1);
    applyPackageDeletion(archived, ["file-a"]);
    expect(unassignedQuestionIds(archived)).not.toContain(one.id);
  });
  it("연결 없는 문제까지 전체 선택하면 공유 문항도 한 번만 제거하고 학습 기록은 유지한다", async () => {
    const { state, one } = fixture();
    const session = startSession(state, "demo", selection, "study", now, [one]);
    answer(state, session.id, "unknown", now + 1); finish(state, session.id, now + 2);
    const preview = applyPackageDeletion(state, ["file-a", "file-b"], true);
    expect(preview).toMatchObject({ removeCount: 2, archiveCount: 1, sharedCount: 0 });
    expect(state.data.packages).toHaveLength(0);
    expect(state.data.questions.map((q) => q.id)).toEqual([one.id]);
    expect(state.attempts).toHaveLength(1);
    expect(selectQuestions(state, "demo", selection)).toHaveLength(0);
    await expect(validateOriginalState(state, "demo")).resolves.toBeDefined();
  });
  it("남은 파일·문제·세션에서 쓰는 그림은 유지하고 사용처 없는 그림만 정리한다", async () => {
    for (const retainSession of [false, true]) {
      const { state, one, three, shared } = fixture();
      const [exclusive, retained, unused] = await Promise.all([png("exclusive"), png("retained"), png("unused")]);
      one.body.push({ type: "image", assetId: exclusive.assetId, alt: "기능 시연" });
      three.body.push({ type: "image", assetId: retained.assetId, alt: "기능 시연" });
      state.data.assets = [exclusive, retained, unused];
      state.data.packages[0].questions = structuredClone([one, shared]);
      state.data.packages[0].assets = [exclusive, unused];
      state.data.packages[1].questions[1] = structuredClone(three);
      state.data.packages[1].assets = [retained];
      if (retainSession) { const session = startSession(state, "demo", selection, "study", now, [shared]); finish(state, session.id, now + 1); }
      const preview = applyPackageDeletion(state, ["file-a"]);
      expect(preview.assetCount).toBe(retainSession ? 0 : 2);
      expect(state.data.assets.map((a) => a.assetId)).toEqual(retainSession ? ["exclusive", "retained", "unused"] : ["retained"]);
      await expect(validateOriginalState(state, "demo")).resolves.toBeDefined();
    }
  });
  it("백업은 보관 삭제 표시를 보존하며 알 수 없는·중복·파일에 남은 문제 표시는 거부한다", async () => {
    const { state, one, shared } = fixture();
    const session = startSession(state, "demo", selection, "study", now, [one]); finish(state, session.id, now + 1);
    applyPackageDeletion(state, ["file-a"]);
    const valid = await validateOriginalState(state, "demo");
    expect(valid.removedQuestionIds).toEqual([one.id]);
    for (const ids of [["missing"], [one.id, one.id], [shared.id]]) {
      await expect(validateOriginalState({ ...state, removedQuestionIds: ids }, "demo")).rejects.toThrow("보관 표시");
    }
    const active = structuredClone(state);
    active.sessions[0].status = "active"; active.sessions[0].finishedAt = null;
    await expect(validateOriginalState(active, "demo")).rejects.toThrow("진행 중");
  });
});
