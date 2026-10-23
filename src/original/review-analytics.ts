import registry from "./contracts/study-units.json";
import type { Attempt, OriginalState } from "./engine";
import type { Namespace, Question } from "./model";
import { isEligible, subjectLabels } from "./validation";

export const MIN_GRADED_QUESTIONS = 5;
export const MAX_RECOMMENDATIONS = 3;
export const DEFAULT_REVIEW_LIMIT = 20;
export const ACTIVE_SUBJECTS = ["constitution", "criminal", "police"] as const;
export type ActiveSubject = (typeof ACTIVE_SUBJECTS)[number];
export interface ReviewScope {
  subjectId: string;
  year: string;
  round: string;
}
export const defaultReviewScope: ReviewScope = {
  subjectId: "",
  year: "",
  round: "",
};

export interface RegistryUnit {
  code: string;
  subjectId: ActiveSubject;
  title: string;
  group: string;
  /** Registry sequence within the subject, including its existing group order. */
  order: number;
  isTemporary: boolean;
}
const subjectPositions = new Map<string, number>();
export const registryUnits: RegistryUnit[] = [
  ...registry.units.map((u) => ({ ...u, isTemporary: false })),
  ...registry.pendingAreas.map((u) => ({
    ...u,
    group: "형사소송법 임시 대분류",
    isTemporary: true,
  })),
].map((u) => {
  const order = (subjectPositions.get(u.subjectId) ?? 0) + 1;
  subjectPositions.set(u.subjectId, order);
  return {
    code: u.code,
    subjectId: u.subjectId as ActiveSubject,
    title: u.title,
    group: u.group,
    order,
    isTemporary: u.isTemporary,
  };
});
const unitsByCode = new Map(registryUnits.map((u) => [u.code, u]));
const subjectRanks = new Map<string, number>(
  ACTIVE_SUBJECTS.map((id, i) => [id, i]),
);

export interface Metrics {
  N: number;
  A: number;
  C: number;
  W: number;
  U: number;
  B: number;
  M: number;
  K: number;
  unresolved: number;
  repeated: number;
  completionRate: number | null;
  wrongRate: number | null;
  unresolvedRate: number | null;
  lastAnsweredAt: string | null;
}
export interface UnitStats extends Metrics {
  code: string | null;
  subjectId: ActiveSubject;
  title: string;
  group: string;
  order: number;
  isTemporary: boolean;
  questionIds: string[];
}
export interface SubjectStats extends Metrics {
  subjectId: ActiveSubject;
  title: string;
  units: UnitStats[];
  pending: UnitStats;
}
export interface QuestionState {
  question: Question;
  latestAttempt?: Attempt;
  /** Newest first in persisted commit order; unanswered records are absent. */
  recentAttempts: Attempt[];
  repeatedIncorrect: boolean;
  primaryUnitCode: string | null;
  orderConflict: boolean;
}
export interface ReviewRecommendation {
  unit: UnitStats;
  tier: "priority" | "supplemental";
  badge: string;
  reason: string;
  reviewCount: number;
}
export interface LearningAnalytics {
  scope: ReviewScope;
  questions: Map<string, QuestionState>;
  overall: Metrics;
  subjects: SubjectStats[];
  units: UnitStats[];
  recommendations: ReviewRecommendation[];
}

function emptyMetrics(): Metrics {
  return {
    N: 0,
    A: 0,
    C: 0,
    W: 0,
    U: 0,
    B: 0,
    M: 0,
    K: 0,
    unresolved: 0,
    repeated: 0,
    completionRate: null,
    wrongRate: null,
    unresolvedRate: null,
    lastAnsweredAt: null,
  };
}
function primaryUnitCode(q: Question): string | null {
  const c = q.classification;
  if (c?.studyStatus !== "confirmed" || !c.studyUnitCode) return null;
  return unitsByCode.get(c.studyUnitCode)?.subjectId === q.subjectId
    ? c.studyUnitCode
    : null;
}
function validResponse(a: Attempt): boolean {
  return (
    (a.response === "unknown" && a.result === "unknown") ||
    (typeof a.response === "number" &&
      Number.isInteger(a.response) &&
      a.response >= 1 &&
      a.response <= 4 &&
      (a.result === "correct" || a.result === "incorrect"))
  );
}
function laterTimestamp(
  current: string | null,
  candidate: string,
): string | null {
  const nextTime = Date.parse(candidate);
  if (!Number.isFinite(nextTime)) return current;
  return current === null || nextTime > Date.parse(current)
    ? candidate
    : current;
}
function include(
  metrics: Metrics,
  row: QuestionState,
  lastAnsweredAt: string | undefined,
): void {
  metrics.N++;
  const latest = row.latestAttempt;
  if (row.orderConflict && latest) metrics.K++;
  else if (latest) {
    metrics.A++;
    if (latest.result === "correct") metrics.C++;
    else if (latest.result === "incorrect") metrics.W++;
    else metrics.U++;
  }
  if (row.repeatedIncorrect) metrics.repeated++;
  if (lastAnsweredAt)
    metrics.lastAnsweredAt = laterTimestamp(
      metrics.lastAnsweredAt,
      lastAnsweredAt,
    );
}
function finishMetrics(metrics: Metrics): void {
  metrics.B = metrics.C + metrics.W;
  metrics.M = metrics.N - metrics.A - metrics.K;
  metrics.unresolved = metrics.W + metrics.U;
  metrics.completionRate = metrics.N ? metrics.A / metrics.N : null;
  metrics.wrongRate = metrics.B ? metrics.W / metrics.B : null;
  metrics.unresolvedRate = metrics.A ? metrics.unresolved / metrics.A : null;
}
function registryOrder(a: UnitStats, b: UnitStats): number {
  return (
    (subjectRanks.get(a.subjectId) ?? ACTIVE_SUBJECTS.length) -
      (subjectRanks.get(b.subjectId) ?? ACTIVE_SUBJECTS.length) ||
    a.order - b.order ||
    (a.code ?? "").localeCompare(b.code ?? "")
  );
}
function oldestFirst(a: string | null, b: string | null): number {
  const left = a === null ? Infinity : Date.parse(a),
    right = b === null ? Infinity : Date.parse(b);
  const l = Number.isFinite(left) ? left : Infinity,
    r = Number.isFinite(right) ? right : Infinity;
  return l === r ? 0 : l < r ? -1 : 1;
}
function recommendations(rows: UnitStats[]): ReviewRecommendation[] {
  const priority = rows
    .filter((u) => u.W > 0 && u.B >= MIN_GRADED_QUESTIONS)
    .sort(
      (a, b) =>
        b.wrongRate! - a.wrongRate! ||
        b.W - a.W ||
        b.repeated - a.repeated ||
        oldestFirst(a.lastAnsweredAt, b.lastAnsweredAt) ||
        registryOrder(a, b),
    );
  const supplemental = rows
    .filter(
      (u) => u.unresolved > 0 && !(u.W > 0 && u.B >= MIN_GRADED_QUESTIONS),
    )
    .sort(
      (a, b) =>
        b.unresolvedRate! - a.unresolvedRate! ||
        b.unresolved - a.unresolved ||
        b.repeated - a.repeated ||
        oldestFirst(a.lastAnsweredAt, b.lastAnsweredAt) ||
        registryOrder(a, b),
    );
  return [...priority, ...supplemental]
    .slice(0, MAX_RECOMMENDATIONS)
    .map((unit) => {
      const tier =
        unit.W > 0 && unit.B >= MIN_GRADED_QUESTIONS
          ? "priority"
          : "supplemental";
      return {
        unit,
        tier,
        badge:
          tier === "priority"
            ? "오답률 우선 복습"
            : unit.B < MIN_GRADED_QUESTIONS
              ? "표본 부족·추가 확인"
              : "모르겠음 복습",
        reason: `정오 판정 ${unit.B}문항 중 오답 ${unit.W}문항이며, 모르겠음 ${unit.U}문항이 남아 있습니다.`,
        reviewCount: Math.min(DEFAULT_REVIEW_LIMIT, unit.unresolved),
      };
    });
}

/** One pass over the eligible bank, one reverse pass over attempts, then totals.
 * No OX records, stored derived values, or changes to the original state are used.
 */
export function aggregateLearning(
  state: OriginalState,
  namespace: Namespace,
  scope: ReviewScope = defaultReviewScope,
  orderConflictIds: readonly string[] = [],
): LearningAnalytics {
  const orderConflicts = new Set(orderConflictIds);
  const removed = new Set(state.removedQuestionIds ?? []);
  const questions = new Map<string, QuestionState>();
  for (const question of state.data.questions) {
    if (
      removed.has(question.id) ||
      !subjectRanks.has(question.subjectId) ||
      !isEligible(question, namespace)
    )
      continue;
    if (
      (scope.subjectId && question.subjectId !== scope.subjectId) ||
      (scope.year && String(question.source.year) !== scope.year) ||
      (scope.round && question.source.round !== scope.round)
    )
      continue;
    questions.set(question.id, {
      question,
      recentAttempts: [],
      repeatedIncorrect: false,
      primaryUnitCode: primaryUnitCode(question),
      orderConflict: orderConflicts.has(question.id),
    });
  }
  const unsubmittedExams = new Set(
    state.sessions
      .filter((s) => s.mode === "exam" && s.status !== "completed")
      .map((s) => s.id),
  );
  const lastDates = new Map<string, string>();
  for (let i = state.attempts.length - 1; i >= 0; i--) {
    const attempt = state.attempts[i],
      row = questions.get(attempt.questionId);
    if (
      !row ||
      attempt.gradingRevision !== row.question.gradingRevision ||
      !validResponse(attempt) ||
      (attempt.mode === "exam" && unsubmittedExams.has(attempt.sessionId))
    )
      continue;
    if (!row.latestAttempt) row.latestAttempt = attempt;
    if (row.recentAttempts.length < 3) row.recentAttempts.push(attempt);
    const date = laterTimestamp(
      lastDates.get(attempt.questionId) ?? null,
      attempt.answeredAt,
    );
    if (date) lastDates.set(attempt.questionId, date);
  }
  const units: UnitStats[] = registryUnits.map((u) => ({
    ...u,
    ...emptyMetrics(),
    questionIds: [],
  }));
  const unitRows = new Map(units.map((u) => [u.code, u]));
  const subjects: SubjectStats[] = ACTIVE_SUBJECTS.map((subjectId) => ({
    ...emptyMetrics(),
    subjectId,
    title: subjectLabels[subjectId],
    units: units.filter((u) => u.subjectId === subjectId),
    pending: {
      ...emptyMetrics(),
      code: null,
      subjectId,
      title: "분류 대기",
      group: "분류 대기",
      order: Number.MAX_SAFE_INTEGER,
      isTemporary: false,
      questionIds: [],
    },
  }));
  const subjectRows = new Map<string, SubjectStats>(
    subjects.map((s) => [s.subjectId, s]),
  );
  const overall = emptyMetrics();
  for (const row of questions.values()) {
    row.orderConflict = row.orderConflict && !!row.latestAttempt;
    row.repeatedIncorrect =
      !row.orderConflict &&
      row.latestAttempt?.result !== "correct" &&
      row.recentAttempts.filter((a) => a.result === "incorrect").length >= 2;
    const subject = subjectRows.get(row.question.subjectId)!;
    const unit = row.primaryUnitCode
      ? unitRows.get(row.primaryUnitCode)!
      : subject.pending;
    unit.questionIds.push(row.question.id);
    const date = lastDates.get(row.question.id);
    include(unit, row, date);
    include(subject, row, date);
    include(overall, row, date);
  }
  units.forEach(finishMetrics);
  subjects.forEach((s) => {
    finishMetrics(s);
    finishMetrics(s.pending);
  });
  finishMetrics(overall);
  return {
    scope: { ...scope },
    questions,
    overall,
    subjects,
    units,
    recommendations: recommendations(units),
  };
}

/** Candidates use the same current scope and representative response as cards.
 * Call aggregateLearning again inside the save mutation before starting a session.
 */
export function reviewCandidates(
  analytics: LearningAnalytics,
  subjectId: string,
  unitCode: string | null,
  kind: "review" | "unanswered",
  limit = DEFAULT_REVIEW_LIMIT,
): Question[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const rows = [...analytics.questions.values()].filter(
    (row) =>
      !row.orderConflict &&
      row.question.subjectId === subjectId &&
      row.primaryUnitCode === unitCode &&
      (kind === "unanswered"
        ? !row.latestAttempt
        : row.latestAttempt?.result === "incorrect" ||
          row.latestAttempt?.result === "unknown"),
  );
  rows.sort((a, b) => {
    if (kind === "review") {
      const stateRank = (row: QuestionState) =>
        row.latestAttempt?.result === "incorrect" ? 0 : 1;
      const ranked =
        stateRank(a) - stateRank(b) ||
        Number(b.repeatedIncorrect) - Number(a.repeatedIncorrect) ||
        oldestFirst(
          a.latestAttempt?.answeredAt ?? null,
          b.latestAttempt?.answeredAt ?? null,
        );
      if (ranked) return ranked;
    }
    return a.question.id.localeCompare(b.question.id);
  });
  return rows
    .slice(0, Math.min(DEFAULT_REVIEW_LIMIT, limit))
    .map((row) => row.question);
}
export function sortUnitStats(
  rows: UnitStats[],
  sort: "registry" | "completion" | "wrong",
): UnitStats[] {
  return [...rows].sort((a, b) => {
    if (sort !== "registry") {
      const left = sort === "completion" ? a.completionRate : a.wrongRate,
        right = sort === "completion" ? b.completionRate : b.wrongRate;
      if (left === null && right !== null) return 1;
      if (left !== null && right === null) return -1;
      if (left !== null && right !== null && left !== right)
        return sort === "completion" ? left - right : right - left;
    }
    return registryOrder(a, b);
  });
}
export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
}
