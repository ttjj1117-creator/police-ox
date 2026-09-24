import type { Item, State } from "../domain/schema";
import { backup, validateBackup } from "./transfer";

export interface RemovalFilter {
  subjectId: Item["subjectId"] | "";
  year: string;
  round: string;
}

export function removalIds(state: State, filter: RemovalFilter): string[] {
  return state.dataset.items.filter(item =>
    (!filter.subjectId || item.subjectId === filter.subjectId) &&
    (!filter.year || String(item.source.year) === filter.year) &&
    (!filter.round || item.source.round === filter.round),
  ).map(item => item.id);
}

function referencedItem(key: string): string {
  const tuple: unknown = JSON.parse(key);
  if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string")
    throw new Error("학습 기록 참조 형식을 확인할 수 없어 삭제하지 않았습니다.");
  return tuple[0];
}

/** Preview and apply use this same pure operation. No storage or version bump. */
export function removeItems(state: State, requested: ReadonlySet<string>) {
  if (state.sessions.some(session => session.status === "active"))
    throw new Error("진행 중 세션을 종료한 뒤 삭제하세요.");
  const next = structuredClone(state);
  const removed = state.dataset.items.filter(item => requested.has(item.id));
  const ids = new Set(removed.map(item => item.id));
  const counts = {
    items: ids.size, attempts: 0, marks: 0, sessions: 0, sessionsPruned: 0,
    snapshots: 0, cyclesRemoved: 0, cyclesUpdated: 0, cycleTokens: 0,
    allocationsRemoved: 0, allocationsUpdated: 0, allocationAssignments: 0,
    coverage: 0,
  };
  if (!ids.size) return { state: next, counts };
  next.dataset.items = next.dataset.items.filter(item => !ids.has(item.id));
  next.attempts = next.attempts.filter(attempt => !ids.has(attempt.itemId));
  counts.attempts = state.attempts.length - next.attempts.length;
  for (const key of Object.keys(next.marks)) {
    if (ids.has(referencedItem(key))) { delete next.marks[key]; counts.marks++; }
  }

  const allocationsToRemove = new Map<string, number>();
  const answers = new Set(next.attempts.map(a => JSON.stringify([a.sessionId, a.itemId])));
  next.sessions = next.sessions.flatMap(session => {
    const removedSnapshots = session.items.filter(item => ids.has(item.id));
    if (!removedSnapshots.length) return [session];
    counts.snapshots += removedSnapshots.length;
    // Balanced allocations count every selected snapshot, even unanswered ones.
    if (session.selection.mode === "balanced") {
      for (const item of removedSnapshots) {
        const key = JSON.stringify([
          session.selection.subjectId, session.selection.basis,
          item.primaryUnitId ?? "unclassified",
        ]);
        allocationsToRemove.set(key, (allocationsToRemove.get(key) ?? 0) + 1);
      }
    }
    const preceding = session.items.slice(0, session.index).filter(item => !ids.has(item.id)).length;
    session.items = session.items.filter(item => !ids.has(item.id));
    if (!session.items.length) { counts.sessions++; return []; }
    // Keep the session ID and remaining snapshots so surviving attempts keep
    // their original sessionId and subject/statistics attribution.
    session.index = Math.min(preceding, session.items.length - 1);
    session.revealed = answers.has(JSON.stringify([session.id, session.items[session.index].id]));
    counts.sessionsPruned++;
    return [session];
  });

  const referencedCycles = new Set(next.sessions.map(s => s.cycleKey));
  for (const [key, cycle] of Object.entries(next.cycles)) {
    const candidates = cycle.candidates.filter(token => !ids.has(referencedItem(token)));
    const remaining = cycle.remaining.filter(token => !ids.has(referencedItem(token)));
    const removedTokens = cycle.candidates.length + cycle.remaining.length - candidates.length - remaining.length;
    if (!next.dataset.items.length || (removedTokens && !candidates.length && !referencedCycles.has(key))) {
      delete next.cycles[key]; counts.cyclesRemoved++;
    } else if (removedTokens) {
      cycle.candidates = candidates; cycle.remaining = remaining; counts.cyclesUpdated++;
    }
    counts.cycleTokens += removedTokens;
  }
  // If historical retained snapshots reference an empty cycle, keep its record.
  for (const session of next.sessions) {
    if (session.cycleKey && !next.cycles[session.cycleKey]) session.cycleKey = null;
  }
  for (const [key, count] of Object.entries(next.allocations)) {
    const deduction = allocationsToRemove.get(key) ?? 0;
    if (!next.dataset.items.length || (deduction && deduction >= count)) {
      delete next.allocations[key]; counts.allocationsRemoved++;
      counts.allocationAssignments += count;
    } else if (deduction) {
      next.allocations[key] = count - deduction; counts.allocationsUpdated++;
      counts.allocationAssignments += deduction;
    }
  }

  const scope = (subjectId: string, year: number, round: string) => JSON.stringify([subjectId, year, round]);
  const affected = new Set(removed.map(item => scope(item.subjectId, item.source.year, item.source.round)));
  next.dataset.coverage = next.dataset.coverage.filter(row => !affected.has(scope(row.subjectId, row.year, row.round)));
  counts.coverage = state.dataset.coverage.length - next.dataset.coverage.length;
  // Validate snapshots and attempt/session references as well as stateSchema.
  validateBackup(backup(next, "real"), "real");
  return { state: next, counts };
}
