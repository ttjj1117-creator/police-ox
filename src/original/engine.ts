import type { Asset, Namespace, OriginalData, Question } from "./model";
import { demoData, emptyData } from "./demo";
import { areas, isEligible, profile, units } from "./validation";
import { bookTaxonomies } from "../data/book-taxonomies";

export type Response = 1 | 2 | 3 | 4 | "unknown" | null;
export type Mode = "study" | "round" | "exam";
export interface OriginalSelection {
  subjectId: string;
  unitCodes: string[];
  bookUnitIds: string[];
  year: string;
  round: string;
  examCode: string;
  filter: "all" | "unanswered" | "incorrect" | "unknown" | "marked" | "weak";
  order: "ordered" | "random";
  limit: number;
}
export const defaultSelection: OriginalSelection = {
  subjectId: "constitution", unitCodes: [], bookUnitIds: [], year: "", round: "",
  examCode: "", filter: "all", order: "ordered", limit: 20,
};
export interface Attempt {
  attemptId: string;
  sessionId: string;
  questionId: string;
  revision: number;
  gradingRevision: number;
  mode: Mode;
  response: Response;
  expectedChoices: number[];
  result: "correct" | "incorrect" | "unknown" | "unanswered";
  answeredAt: string;
}
export interface OriginalSession {
  id: string;
  mode: Mode;
  selection: OriginalSelection;
  questions: Question[];
  assets: Asset[];
  responses: Record<string, Response>;
  review: Record<string, boolean>;
  index: number;
  status: "active" | "completed" | "ended";
  startedAt: string;
  deadlineAt: string | null;
  finishedAt: string | null;
}
export interface OriginalState {
  data: OriginalData;
  attempts: Attempt[];
  marks: Record<string, boolean>;
  sessions: OriginalSession[];
  settings: { fontScale: number };
  /** Local deletion markers; exchange question content and historical snapshots stay unchanged. */
  removedQuestionIds?: string[];
}
export function initialOriginalState(namespace: Namespace): OriginalState {
  return { data: namespace === "demo" ? demoData() : emptyData(), attempts: [], marks: {}, sessions: [], settings: { fontScale: 1 } };
}
export const activeSession = (state: OriginalState) => state.sessions.find((s) => s.status === "active");
export function latestAttempt(state: OriginalState, question: Question): Attempt | undefined {
  // Array order is the atomic commit order, including equal timestamps.
  return [...state.attempts].reverse().find((a) => a.questionId === question.id && a.gradingRevision === question.gradingRevision);
}
const subjectOrder = ["constitution", "criminal", "police"];
export function shuffled<T>(values: T[], random = Math.random): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function descendantIds(ids: string[]) {
  const result = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of bookTaxonomies) if (node.parentId && result.has(node.parentId) && !result.has(node.id)) {
      result.add(node.id); changed = true;
    }
  }
  return result;
}
export function selectQuestions(state: OriginalState, namespace: Namespace, selection: OriginalSelection): Question[] {
  const books = descendantIds(selection.bookUnitIds);
  const selectedUnits = new Set(selection.unitCodes);
  const removed = new Set(state.removedQuestionIds ?? []);
  const candidates = state.data.questions.filter((q) => {
    if (removed.has(q.id)) return false;
    if (!isEligible(q, namespace) || !subjectOrder.includes(q.subjectId)) return false;
    if (namespace === "real" && q.source.examCode !== "po") return false;
    if (selection.subjectId && q.subjectId !== selection.subjectId) return false;
    if (selection.year && String(q.source.year) !== selection.year) return false;
    if (selection.round && q.source.round !== selection.round) return false;
    if (selection.examCode && q.source.examCode !== selection.examCode) return false;
    const c = q.classification;
    if (selectedUnits.size) {
      if (c?.studyStatus !== "confirmed") return false;
      const assigned = [c.studyUnitCode, ...c.relatedStudyUnitCodes].filter(Boolean);
      // A confirmed code or an explicitly preserved book position can connect a
      // question to a registered learning group. Missing book links stay absent.
      const matched = assigned.some((code) => selectedUnits.has(code!)) || units.some((unit) => {
        if (!selectedUnits.has(unit.code) || !unit.bookNodeIds.length) return false;
        const range = unit.includeDescendants ? descendantIds(unit.bookNodeIds) : new Set(unit.bookNodeIds);
        return c.bookUnitIds.some((id) => range.has(id));
      });
      if (!matched) return false;
    }
    if (books.size && (!c || !c.bookUnitIds.some((id) => books.has(id)))) return false;
    const latest = latestAttempt(state, q);
    switch (selection.filter) {
      case "unanswered": return !latest;
      case "incorrect": return latest?.result === "incorrect";
      case "unknown": return latest?.result === "unknown";
      case "marked": return !!state.marks[q.id];
      case "weak": return !!latest && latest.result !== "correct";
      default: return true;
    }
  });
  const unique = [...new Map(candidates.map((q) => [q.id, q])).values()];
  unique.sort((a, b) => subjectOrder.indexOf(a.subjectId) - subjectOrder.indexOf(b.subjectId) || a.source.year - b.source.year || Number(a.source.round) - Number(b.source.round) || a.source.questionNumber - b.source.questionNumber || a.id.localeCompare(b.id));
  return selection.order === "random" ? shuffled(unique) : unique;
}
export function examAvailability(state: OriginalState, namespace: Namespace, selection: OriginalSelection) {
  const pool = selectQuestions(state, namespace, { ...selection, subjectId: "", unitCodes: [], bookUnitIds: [], filter: "all", limit: 0, order: "ordered", examCode: namespace === "real" ? "po" : "demo" });
  return areas.map((area) => {
    const candidates = pool.filter((q) => q.subjectId === area.subjectId && q.classification?.blueprintStatus === "confirmed" && q.classification.blueprintAreaCode === area.code);
    return { ...area, available: candidates.length, shortage: Math.max(0, area.targetQuestions - candidates.length), candidates };
  });
}
export function startSession(state: OriginalState, namespace: Namespace, selection: OriginalSelection, mode: Mode = "study", now = Date.now(), overrideQuestions?: Question[]): OriginalSession {
  if (activeSession(state)) throw new Error("진행 중인 원문 풀이를 이어 풀거나 종료하세요.");
  if (!Number.isInteger(selection.limit) || selection.limit < 0) throw new Error("문항 수는 양의 정수 또는 전체여야 합니다.");
  if (mode === "round" && (!selection.subjectId || !selection.year || !selection.round)) throw new Error("회차별 풀이는 과목·연도·회차를 선택하세요.");
  let questions: Question[];
  if (mode === "exam") {
    const allocation = examAvailability(state, namespace, selection);
    if (allocation.some((a) => a.shortage)) throw new Error("영역별 문항이 부족하여 모의고사를 시작할 수 없습니다.");
    questions = allocation.flatMap((area) => shuffled(area.candidates).slice(0, area.targetQuestions));
    // Shuffle within each subject, retaining the configured subject order.
    questions = subjectOrder.flatMap((subject) => shuffled(questions.filter((q) => q.subjectId === subject)));
  } else {
    // A result page holds historical snapshots. Retrying selects those IDs from
    // today's data so a later correction or retirement is respected.
    const currentById = new Map(state.data.questions.map((q) => [q.id, q]));
    questions = overrideQuestions
      ? overrideQuestions.map((q) => currentById.get(q.id)).filter((q): q is Question => !!q)
      : selectQuestions(state, namespace, mode === "round" ? { ...selection, order: "ordered" } : selection);
    const removed = new Set(state.removedQuestionIds ?? []);
    questions = [...new Map(questions.map((q) => [q.id, q])).values()].filter((q) => !removed.has(q.id) && isEligible(q, namespace));
    if (mode === "round") questions.sort((a, b) => a.source.questionNumber - b.source.questionNumber);
    if (!overrideQuestions && selection.limit && mode !== "round") questions = questions.slice(0, selection.limit);
  }
  if (!questions.length) throw new Error("이 범위에서 풀 수 있는 문항이 없습니다.");
  if (new Set(questions.map((q) => q.id)).size !== questions.length) throw new Error("중복 문항이 있습니다.");
  const session: OriginalSession = {
    id: crypto.randomUUID(), mode, selection: structuredClone(selection), questions: structuredClone(questions), assets: structuredClone(state.data.assets),
    responses: {}, review: {}, index: 0, status: "active", startedAt: new Date(now).toISOString(),
    deadlineAt: mode === "exam" ? new Date(now + profile.durationSeconds * 1000).toISOString() : null, finishedAt: null,
  };
  state.sessions.push(session);
  return session;
}
export function responseResult(response: Response, expected: number[]): Attempt["result"] {
  return response === null ? "unanswered" : response === "unknown" ? "unknown" : expected.includes(response) ? "correct" : "incorrect";
}
function record(state: OriginalState, session: OriginalSession, question: Question, response: Response, now: number) {
  const attemptId = `${session.id}:${question.id}`;
  if (state.attempts.some((a) => a.attemptId === attemptId)) return;
  state.attempts.push({ attemptId, sessionId: session.id, questionId: question.id, revision: question.revision, gradingRevision: question.gradingRevision, mode: session.mode, response,
    expectedChoices: [...question.officialAnswer.acceptedChoices], result: responseResult(response, question.officialAnswer.acceptedChoices), answeredAt: new Date(now).toISOString() });
}
function getSession(state: OriginalState, id: string) {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) throw new Error("풀이 기록을 찾을 수 없습니다.");
  return session;
}
export function finish(state: OriginalState, id: string, now = Date.now()): boolean {
  const session = getSession(state, id);
  if (session.status !== "active") return false;
  if (session.mode === "exam") {
    const submittedAt = Math.min(now, Date.parse(session.deadlineAt!));
    for (const question of session.questions) record(state, session, question, session.responses[question.id] ?? null, submittedAt);
    session.status = "completed";
  } else session.status = session.questions.every((q) => session.responses[q.id] != null) ? "completed" : "ended";
  session.finishedAt = new Date(session.deadlineAt ? Math.min(now, Date.parse(session.deadlineAt)) : now).toISOString();
  return true;
}
export function expire(state: OriginalState, now = Date.now()): boolean {
  const session = activeSession(state);
  return !!session && session.mode === "exam" && now >= Date.parse(session.deadlineAt!) && finish(state, session.id, now);
}
export function answer(state: OriginalState, id: string, response: Response, now = Date.now()): boolean {
  const session = getSession(state, id);
  if (session.status !== "active") return false;
  if (session.deadlineAt && now >= Date.parse(session.deadlineAt)) return finish(state, id, now);
  if (![null, "unknown", 1, 2, 3, 4].includes(response)) throw new Error("선택지는 1~4 또는 모르겠음이어야 합니다.");
  const question = session.questions[session.index];
  if (session.mode !== "exam" && (session.responses[question.id] != null || response === null)) return false;
  if ((session.responses[question.id] ?? null) === response) return false;
  session.responses[question.id] = response;
  if (session.mode !== "exam") record(state, session, question, response, now);
  return true;
}
export function move(state: OriginalState, id: string, index: number, now = Date.now()): boolean {
  const session = getSession(state, id);
  if (session.status !== "active") return false;
  if (session.deadlineAt && now >= Date.parse(session.deadlineAt)) return finish(state, id, now);
  if (!Number.isInteger(index) || index < 0 || index >= session.questions.length) return false;
  if (session.index === index) return false;
  session.index = index;
  return true;
}
export function weakQuestions(state: OriginalState, session: OriginalSession) {
  const weakIds = new Set(state.attempts.filter((a) => a.sessionId === session.id && a.result !== "correct").map((a) => a.questionId));
  return session.questions.flatMap((snapshot) => {
    const current = state.data.questions.find((q) => q.id === snapshot.id);
    if (!current || !weakIds.has(current.id) || state.removedQuestionIds?.includes(current.id)) return [];
    return isEligible(current, current.source.examCode === "demo" ? "demo" : "real") ? [current] : [];
  });
}
export function resultSummary(state: OriginalState, session: OriginalSession) {
  const attempts = state.attempts.filter((a) => a.sessionId === session.id);
  const counts = (questions: Question[]) => {
    const ids = new Set(questions.map((q) => q.id)), rows = attempts.filter((a) => ids.has(a.questionId));
    const correct = rows.filter((a) => a.result === "correct").length;
    const total = questions.length;
    return { total, answered: rows.filter((a) => a.result !== "unanswered").length, correct, incorrect: rows.filter((a) => a.result === "incorrect").length,
      unknown: rows.filter((a) => a.result === "unknown").length, unanswered: rows.filter((a) => a.result === "unanswered").length,
      points: correct * profile.pointsPerQuestion, maxPoints: total * profile.pointsPerQuestion,
      rate: total ? Math.round(100 * correct / (session.mode === "exam" ? total : Math.max(rows.length, 1))) : 0 };
  };
  return { ...counts(session.questions), subjects: subjectOrder.map((subjectId) => ({ subjectId, ...counts(session.questions.filter((q) => q.subjectId === subjectId)) })) };
}
