import { describe, expect, it } from "vitest";
import {
  activeSession, answer, defaultSelection, examAvailability, expire, finish,
  initialOriginalState, latestAttempt, move, resultSummary, selectQuestions,
  startSession, weakQuestions,
} from "../src/original/engine";

const now = Date.parse("2026-10-21T00:00:00Z");
const selection = { ...defaultSelection, subjectId: "", limit: 0 };
describe("원문 학습·모의고사", () => {
  it("한 번만 제출하고 모르겠음·오답 해소·수동 표시·학습 중도 종료를 구분한다", () => {
    const state = initialOriginalState("demo");
    const q = state.data.questions[0];
    const session = startSession(state, "demo", selection, "study", now, [q]);
    answer(state, session.id, "unknown", now + 1);
    answer(state, session.id, 1, now + 2);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].result).toBe("unknown");
    state.marks[q.id] = true;
    finish(state, session.id, now + 3);
    expect(weakQuestions(state, session)).toHaveLength(1);
    const next = startSession(state, "demo", selection, "study", now + 4, [q]);
    answer(state, next.id, q.officialAnswer.acceptedChoices[0] as 1, now + 5);
    finish(state, next.id, now + 6);
    expect(latestAttempt(state, q)?.result).toBe("correct");
    expect(state.marks[q.id]).toBe(true);
    expect(state.attempts).toHaveLength(2);
    const unanswered = startSession(state, "demo", selection, "study", now + 7, [q]);
    finish(state, unanswered.id, now + 8);
    expect(state.attempts).toHaveLength(2);
    expect(unanswered.status).toBe("ended");
  });
  it("현재 채점 버전의 기록으로 필터링하고 관련 단원 중복을 제거한다", () => {
    const state = initialOriginalState("demo");
    const q = state.data.questions[0];
    const unit = q.classification!.studyUnitCode!;
    q.classification!.relatedStudyUnitCodes = [q.subjectId === "constitution" ? "CONST-02" : unit];
    const selected = selectQuestions(state, "demo", { ...selection, unitCodes: [unit, ...q.classification!.relatedStudyUnitCodes] });
    expect(selected.filter((v) => v.id === q.id)).toHaveLength(1);
    const session = startSession(state, "demo", selection, "study", now, [q]);
    answer(state, session.id, "unknown", now + 1); finish(state, session.id, now + 2);
    expect(selectQuestions(state, "demo", { ...selection, filter: "unknown" })).toHaveLength(1);
    q.revision++; q.gradingRevision++;
    expect(selectQuestions(state, "demo", { ...selection, filter: "unknown" })).toHaveLength(0);
    expect(selectQuestions(state, "demo", { ...selection, filter: "unanswered" }).some((v) => v.id === q.id)).toBe(true);
    expect(state.attempts).toHaveLength(1);
  });
  it("11개 영역의 목표를 정확히 선별하고 한 문항이라도 부족하면 막는다", () => {
    const state = initialOriginalState("demo");
    const allocation = examAvailability(state, "demo", selection);
    expect(allocation).toHaveLength(11);
    expect(allocation.every((v) => v.shortage === 0)).toBe(true);
    const exam = startSession(state, "demo", selection, "exam", now);
    expect(exam.questions).toHaveLength(100);
    expect(new Set(exam.questions.map((q) => q.id)).size).toBe(100);
    expect(exam.questions.filter((q) => q.subjectId === "constitution")).toHaveLength(20);
    expect(exam.questions.filter((q) => q.subjectId === "criminal")).toHaveLength(40);
    expect(exam.questions.filter((q) => q.subjectId === "police")).toHaveLength(40);
    for (const area of allocation) expect(exam.questions.filter((q) => q.classification?.blueprintAreaCode === area.code)).toHaveLength(area.targetQuestions);
    finish(state, exam.id, now + 1);
    state.data.questions.pop();
    expect(examAvailability(state, "demo", selection).reduce((n, a) => n + a.shortage, 0)).toBe(1);
    expect(() => startSession(state, "demo", selection, "exam", now + 2)).toThrow("부족");
    expect(() => startSession(state, "demo", selection, "study", now + 2)).not.toThrow();
  });
  it("실제 종료 시각 정각에서 입력을 차단하고 마지막 저장 답안을 한 번만 채점한다", () => {
    const state = initialOriginalState("demo");
    const exam = startSession(state, "demo", selection, "exam", now);
    const first = exam.questions[0], second = exam.questions[1];
    answer(state, exam.id, "unknown", now + 1);
    answer(state, exam.id, first.officialAnswer.acceptedChoices[0] as 1, now + 2);
    expect(state.attempts).toHaveLength(0);
    move(state, exam.id, 1, now + 3);
    answer(state, exam.id, "unknown", now + 4);
    const restored = structuredClone(state);
    expect(Date.parse(activeSession(restored)!.deadlineAt!) - (now + 600000)).toBe(5400000);
    expect(expire(restored, now + 5999999)).toBe(false);
    answer(restored, exam.id, second.officialAnswer.acceptedChoices[0] as 1, now + 6000000);
    expect(restored.attempts).toHaveLength(100);
    expect(restored.attempts.find((a) => a.questionId === first.id)?.result).toBe("correct");
    expect(restored.attempts.find((a) => a.questionId === second.id)?.result).toBe("unknown");
    expect(resultSummary(restored, restored.sessions[0]).unanswered).toBe(98);
    expect(resultSummary(restored, restored.sessions[0]).points).toBe(2.5);
    expect(answer(restored, exam.id, 1, now + 6000001)).toBe(false);
    expect(finish(restored, exam.id, now + 6000002)).toBe(false);
    expect(expire(restored, now + 6000003)).toBe(false);
    expect(restored.attempts).toHaveLength(100);
  });
  it("모두 정답이면 과목별 50·100·100점, 총 250점이다", () => {
    const state = initialOriginalState("demo");
    const exam = startSession(state, "demo", selection, "exam", now);
    exam.questions.forEach((q, i) => { move(state, exam.id, i, now + i); answer(state, exam.id, q.officialAnswer.acceptedChoices[0] as 1, now + i); });
    finish(state, exam.id, now + 1000);
    expect(resultSummary(state, exam).points).toBe(250);
    expect(resultSummary(state, exam).subjects.map((s) => s.points)).toEqual([50, 100, 100]);
  });
  it("공식 복수 정답의 한 번호만 골라도 맞으며 모든 오답은 0점이다", () => {
    const state = initialOriginalState("demo");
    const q = state.data.questions[0];
    q.officialAnswer = { ...q.officialAnswer, kind: "multiple", acceptedChoices: [1, 3] };
    const study = startSession(state, "demo", selection, "study", now, [q]);
    answer(state, study.id, 3, now + 1); finish(state, study.id, now + 2);
    expect(state.attempts[0].result).toBe("correct");
    const exam = startSession(state, "demo", selection, "exam", now + 3);
    exam.questions.forEach((item, i) => {
      move(state, exam.id, i, now + 4 + i);
      const wrong = ([1, 2, 3, 4] as const).find((n) => !item.officialAnswer.acceptedChoices.includes(n))!;
      answer(state, exam.id, wrong, now + 4 + i);
    });
    finish(state, exam.id, now + 1000);
    expect(resultSummary(state, exam).points).toBe(0);
    expect(resultSummary(state, exam).incorrect).toBe(100);
  });
  it("과거 결과에서 다시 풀 때 최신 채점 버전을 사용하고 폐기 문항을 제외한다", () => {
    const state = initialOriginalState("demo");
    const q = state.data.questions[0];
    const first = startSession(state, "demo", selection, "study", now, [q]);
    answer(state, first.id, "unknown", now + 1); finish(state, first.id, now + 2);
    const oldSnapshot = structuredClone(first.questions[0]);
    const oldAttempt = structuredClone(state.attempts[0]);
    // Simulate a validated newer import after the first session ended.
    q.revision = 2; q.gradingRevision = 2;
    q.body = [{ type: "text", text: "기능 확인용 최신 문항" }];
    q.officialAnswer.acceptedChoices = [4];
    expect(latestAttempt(state, q)).toBeUndefined();
    const retry = startSession(state, "demo", selection, "study", now + 3, first.questions);
    expect(retry.questions[0].revision).toBe(2);
    expect(retry.questions[0].gradingRevision).toBe(2);
    expect(retry.questions[0].body).toEqual(q.body);
    expect(retry.questions[0]).not.toBe(q);
    answer(state, retry.id, 4, now + 4); finish(state, retry.id, now + 5);
    expect(latestAttempt(state, q)?.result).toBe("correct");
    expect(latestAttempt(state, q)?.gradingRevision).toBe(2);
    expect(selectQuestions(state, "demo", { ...selection, filter: "unknown" })).toHaveLength(0);
    expect(state.attempts[0]).toEqual(oldAttempt);
    expect(first.questions[0]).toEqual(oldSnapshot);
    expect(weakQuestions(state, first)[0]).toBe(q);
    q.lifecycle = "retired";
    expect(weakQuestions(state, first)).toHaveLength(0);
    expect(() => startSession(state, "demo", selection, "study", now + 6, first.questions)).toThrow("없습니다");
    expect(state.sessions).toHaveLength(2);
    expect(activeSession(state)).toBeUndefined();
    expect(state.attempts[0]).toEqual(oldAttempt);
  });
});
