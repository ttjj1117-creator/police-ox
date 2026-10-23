import { activeSession, type OriginalState } from "./engine";
import { referencedAssets } from "./validation";

export interface PackageDeletionPreview {
  packageIds: string[];
  includeUnassigned: boolean;
  /** Exclusively selected questions affected; shared questions are omitted. */
  questionIds: string[];
  removeCount: number;
  archiveCount: number;
  sharedCount: number;
  /** Number of assets removed after all remaining data/history references. */
  assetCount: number;
}

/** Older partial imports may leave current bank questions outside the latest files. */
export function unassignedQuestionIds(state: OriginalState): string[] {
  const assigned = new Set(state.data.packages.flatMap((source) => source.questions.map((q) => q.id)));
  const removed = new Set(state.removedQuestionIds ?? []);
  return state.data.questions.filter((q) => !assigned.has(q.id) && !removed.has(q.id)).map((q) => q.id);
}

function deletionPlan(state: OriginalState, packageIds: string[], includeUnassigned: boolean) {
  if (activeSession(state)) throw new Error("진행 중인 원문 풀이를 종료한 뒤 문제 파일을 삭제하세요.");
  if (!Array.isArray(packageIds) || packageIds.some((id) => typeof id !== "string" || !id.length) || typeof includeUnassigned !== "boolean") throw new Error("삭제할 문제 파일을 선택하세요.");
  const selected = new Set(packageIds);
  if (selected.size !== packageIds.length) throw new Error("같은 문제 파일을 중복 선택할 수 없습니다.");
  const known = new Set(state.data.packages.map((source) => source.packageId));
  for (const id of selected) if (!known.has(id)) throw new Error(`선택한 문제 파일 ${id}이 변경되었거나 이미 삭제되었습니다. 목록을 다시 확인하세요.`);
  const unassigned = includeUnassigned ? unassignedQuestionIds(state) : [];
  if (!selected.size && !unassigned.length) throw new Error("삭제할 문제 파일이나 파일 연결이 없는 문제를 선택하세요.");
  const retainedPackages = state.data.packages.filter((source) => !selected.has(source.packageId));
  const retainedIds = new Set(retainedPackages.flatMap((source) => source.questions.map((q) => q.id)));
  const selectedIds = new Set(state.data.packages.filter((source) => selected.has(source.packageId)).flatMap((source) => source.questions.map((q) => q.id)));
  const affectedIds = new Set([...selectedIds].filter((id) => !retainedIds.has(id)));
  unassigned.forEach((id) => affectedIds.add(id));
  const bankIds = new Set(state.data.questions.map((q) => q.id));
  if ([...affectedIds].some((id) => !bankIds.has(id))) throw new Error("선택한 파일과 현재 문제 목록이 일치하지 않습니다. 목록을 다시 불러오세요.");
  const historyIds = new Set(state.sessions.flatMap((session) => session.questions.map((q) => q.id)));
  const archivedIds = new Set([...affectedIds].filter((id) => historyIds.has(id)));
  const removedIds = new Set([...affectedIds].filter((id) => !historyIds.has(id)));
  const retainedQuestions = state.data.questions.filter((q) => !removedIds.has(q.id));
  const retainedAssetIds = new Set([
    ...retainedPackages.flatMap((source) => source.assets.map((asset) => asset.assetId)),
    ...retainedQuestions.flatMap(referencedAssets),
    ...state.sessions.flatMap((session) => session.assets.map((asset) => asset.assetId)),
  ]);
  const retainedAssets = state.data.assets.filter((asset) => retainedAssetIds.has(asset.assetId));
  const preview: PackageDeletionPreview = {
    packageIds: [...packageIds], includeUnassigned, questionIds: [...affectedIds],
    removeCount: removedIds.size, archiveCount: archivedIds.size,
    sharedCount: [...selectedIds].filter((id) => retainedIds.has(id)).length,
    assetCount: state.data.assets.length - retainedAssets.length,
  };
  return { preview, retainedPackages, retainedQuestions, retainedAssets, archivedIds, affectedIds, removedIds };
}

export function previewPackageDeletion(state: OriginalState, packageIds: string[], includeUnassigned = false): PackageDeletionPreview {
  return deletionPlan(state, packageIds, includeUnassigned).preview;
}

/** The caller saves this draft as one optimistic-generation transaction. */
export function applyPackageDeletion(state: OriginalState, packageIds: string[], includeUnassigned = false): PackageDeletionPreview {
  const plan = deletionPlan(state, packageIds, includeUnassigned);
  state.data.packages = plan.retainedPackages;
  state.data.questions = plan.retainedQuestions;
  state.data.assets = plan.retainedAssets;
  for (const id of plan.affectedIds) delete state.marks[id];
  const archived = new Set((state.removedQuestionIds ?? []).filter((id) => !plan.removedIds.has(id)));
  plan.archivedIds.forEach((id) => archived.add(id));
  if (archived.size) state.removedQuestionIds = [...archived];
  else if (state.removedQuestionIds !== undefined) delete state.removedQuestionIds;
  return plan.preview;
}
