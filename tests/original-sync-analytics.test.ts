import { describe, expect, it } from "vitest";
import { demoData } from "../src/original/demo";
import { defaultSelection, initialOriginalState } from "../src/original/engine";
import type {
  Attempt,
  OriginalSession,
  OriginalState,
} from "../src/original/engine";
import type { Question } from "../src/original/model";
import {
  aggregateLearning,
  defaultReviewScope,
  reviewCandidates,
} from "../src/original/review-analytics";
import type { Metrics } from "../src/original/review-analytics";

const prototype = demoData().questions[0];
function question(n: number, code: string | null = "CONST-01"): Question {
  const q = structuredClone(prototype);
  q.id = `demo_const_sync_${n}`;
  q.source.questionNumber = n;
  q.source.year = 2026;
  q.source.round = "1";
  q.officialAnswer = { status: "demo", kind: "single", acceptedChoices: [1] };
  q.classification =
    code === null
      ? null
      : {
          studyUnitCode: code,
          relatedStudyUnitCodes: [],
          studyStatus: "confirmed",
          bookUnitIds: [],
          blueprintAreaCode: null,
          blueprintStatus: "pending",
        };
  return q;
}
function bank(...questions: Question[]): OriginalState {
  const state = initialOriginalState("real");
  state.data.questions = questions;
  return state;
}
function respond(
  state: OriginalState,
  q: Question,
  result: Attempt["result"],
  overrides: Partial<Attempt> = {},
): Attempt {
  const attempt: Attempt = {
    attemptId: `sync_attempt_${state.attempts.length}`,
    sessionId: `sync_session_${state.attempts.length}`,
    questionId: q.id,
    revision: q.revision,
    gradingRevision: q.gradingRevision,
    mode: "study",
    expectedChoices: [1],
    result,
    response:
      result === "correct"
        ? 1
        : result === "incorrect"
          ? 2
          : result === "unknown"
            ? "unknown"
            : null,
    answeredAt: new Date(
      Date.parse("2026-10-23T00:00:00Z") + state.attempts.length * 1000,
    ).toISOString(),
    ...overrides,
  };
  state.attempts.push(attempt);
  return attempt;
}
function assertPopulation(metrics: Metrics): void {
  expect(metrics.N).toBe(
    metrics.C + metrics.W + metrics.U + metrics.M + metrics.K,
  );
  expect(metrics.A).toBe(metrics.C + metrics.W + metrics.U);
  expect(metrics.B).toBe(metrics.C + metrics.W);
  expect(metrics.unresolved).toBe(metrics.W + metrics.U);
}

describe("synchronized response-order conflicts in learning analytics", () => {
  it("retains conflicted questions in N and isolates K from results, repeated errors and all study candidates", () => {
    const qs = [
      question(1),
      question(2),
      question(3),
      question(4),
      question(5),
      question(6, null),
    ];
    const state = bank(...qs);
    respond(state, qs[0], "correct");
    respond(state, qs[1], "incorrect");
    respond(state, qs[1], "incorrect");
    respond(state, qs[2], "incorrect");
    respond(state, qs[3], "unknown");
    respond(state, qs[5], "unknown");
    const before = structuredClone(state);
    const analytics = aggregateLearning(state, "demo", defaultReviewScope, [
      qs[1].id,
      qs[5].id,
    ]);
    expect(analytics.overall).toMatchObject({
      N: 6,
      A: 3,
      C: 1,
      W: 1,
      U: 1,
      B: 2,
      M: 1,
      K: 2,
      unresolved: 2,
      repeated: 0,
    });
    expect(analytics.overall.completionRate).toBe(0.5);
    expect(analytics.overall.wrongRate).toBe(0.5);
    expect(analytics.overall.unresolvedRate).toBeCloseTo(2 / 3);
    expect(analytics.units.find((u) => u.code === "CONST-01")).toMatchObject({
      N: 5,
      A: 3,
      M: 1,
      K: 1,
    });
    expect(analytics.subjects[0].pending).toMatchObject({
      N: 1,
      A: 0,
      M: 0,
      K: 1,
    });
    expect(analytics.questions.get(qs[1].id)).toMatchObject({
      orderConflict: true,
      repeatedIncorrect: false,
    });
    expect(
      reviewCandidates(analytics, "constitution", "CONST-01", "review").map(
        (q) => q.id,
      ),
    ).toEqual([qs[2].id, qs[3].id]);
    expect(
      reviewCandidates(analytics, "constitution", "CONST-01", "unanswered").map(
        (q) => q.id,
      ),
    ).toEqual([qs[4].id]);
    expect(reviewCandidates(analytics, "constitution", null, "review")).toEqual(
      [],
    );
    expect(
      reviewCandidates(analytics, "constitution", null, "unanswered"),
    ).toEqual([]);
    expect(analytics.recommendations).toHaveLength(1);
    expect(analytics.recommendations[0]).toMatchObject({
      reviewCount: 2,
      unit: { code: "CONST-01", unresolved: 2, K: 1 },
    });
    [
      analytics.overall,
      ...analytics.subjects,
      ...analytics.units,
      ...analytics.subjects.map((s) => s.pending),
    ].forEach(assertPopulation);
    expect(state).toEqual(before);
  });

  it("restores the selected representative response after resolution without changing immutable history", () => {
    const q = question(1),
      state = bank(q);
    respond(state, q, "incorrect");
    const latest = respond(state, q, "incorrect");
    const before = structuredClone(state);
    expect(
      aggregateLearning(state, "demo", defaultReviewScope, [q.id]).overall,
    ).toMatchObject({ K: 1, W: 0, repeated: 0 });
    const resolved = aggregateLearning(state, "demo", defaultReviewScope, []);
    expect(resolved.overall).toMatchObject({
      N: 1,
      K: 0,
      A: 1,
      W: 1,
      M: 0,
      repeated: 1,
    });
    expect(resolved.questions.get(q.id)?.latestAttempt).toBe(latest);
    expect(
      reviewCandidates(resolved, "constitution", "CONST-01", "review"),
    ).toEqual([q]);
    expect(resolved).toEqual(aggregateLearning(state, "demo"));
    expect(resolved).toEqual(
      aggregateLearning(state, "demo", defaultReviewScope, [
        "not-in-current-bank",
      ]),
    );
    expect(state).toEqual(before);
  });

  it("does not report a fully conflicted unit as completed, wrong, unanswered or recommended", () => {
    const qs = [question(1), question(2), question(3)],
      state = bank(...qs);
    respond(state, qs[0], "correct");
    respond(state, qs[1], "incorrect");
    respond(state, qs[2], "unknown");
    const analytics = aggregateLearning(
      state,
      "demo",
      defaultReviewScope,
      qs.map((q) => q.id),
    );
    expect(analytics.overall).toMatchObject({
      N: 3,
      A: 0,
      C: 0,
      W: 0,
      U: 0,
      B: 0,
      M: 0,
      K: 3,
      repeated: 0,
      completionRate: 0,
      wrongRate: null,
      unresolvedRate: null,
    });
    expect(analytics.recommendations).toEqual([]);
    expect(
      reviewCandidates(analytics, "constitution", "CONST-01", "review"),
    ).toEqual([]);
    expect(
      reviewCandidates(analytics, "constitution", "CONST-01", "unanswered"),
    ).toEqual([]);
    assertPopulation(analytics.overall);
  });

  it("only counts conflicts inside the current scope, namespace and eligible undeleted population", () => {
    const qs = Array.from({ length: 7 }, (_, i) => question(i + 1));
    qs[1].source.year = 2025;
    qs[2].source.round = "2";
    qs[3].lifecycle = "retired";
    qs[4].qa.textStatus = "hold";
    qs[6].source.examCode = "po";
    qs[6].officialAnswer.status = "final";
    qs[6].source.questionPdf = { fileName: "fixture.pdf", pages: [1] };
    qs[6].source.answerPdf = {
      fileName: "fixture-answer.pdf",
      pages: [1],
      subjectColumn: "헌법",
    };
    const state = bank(...qs);
    state.removedQuestionIds = [qs[5].id];
    qs.forEach((q) => respond(state, q, "incorrect"));
    const ids = qs.map((q) => q.id);
    const scoped = aggregateLearning(
      state,
      "demo",
      { subjectId: "constitution", year: "2026", round: "1" },
      ids,
    );
    expect([...scoped.questions.keys()]).toEqual([qs[0].id]);
    expect(scoped.overall).toMatchObject({ N: 1, K: 1, M: 0 });
    expect(scoped.subjects[0].N).toBe(
      scoped.subjects[0].units.reduce((n, u) => n + u.N, 0) +
        scoped.subjects[0].pending.N,
    );
    expect(
      aggregateLearning(state, "real", defaultReviewScope, ids).overall,
    ).toMatchObject({ N: 1, K: 1 });
  });

  it("clears stale conflict flags after an answer revision so the current question can be learned again", () => {
    const q = question(1),
      state = bank(q);
    respond(state, q, "incorrect");
    q.revision++;
    q.gradingRevision++;
    const analytics = aggregateLearning(state, "demo", defaultReviewScope, [
      q.id,
    ]);
    expect(analytics.overall).toMatchObject({
      N: 1,
      A: 0,
      M: 1,
      K: 0,
      B: 0,
      repeated: 0,
    });
    expect(analytics.questions.get(q.id)).toMatchObject({
      orderConflict: false,
      recentAttempts: [],
    });
    expect(
      reviewCandidates(analytics, "constitution", "CONST-01", "unanswered"),
    ).toEqual([q]);
    expect(
      reviewCandidates(analytics, "constitution", "CONST-01", "review"),
    ).toEqual([]);
  });

  it("attributes a held response to the current main unit after a classification-only revision", () => {
    const q = question(1),
      state = bank(q);
    respond(state, q, "incorrect");
    q.revision++;
    q.classification!.studyUnitCode = "CONST-02";
    const analytics = aggregateLearning(state, "demo", defaultReviewScope, [
      q.id,
    ]);
    expect(analytics.units.find((u) => u.code === "CONST-01")).toMatchObject({
      N: 0,
      K: 0,
    });
    expect(analytics.units.find((u) => u.code === "CONST-02")).toMatchObject({
      N: 1,
      K: 1,
      A: 0,
    });
    expect(analytics.questions.get(q.id)?.recentAttempts).toHaveLength(1);
    expect(analytics.subjects[0]).toMatchObject({ N: 1, K: 1 });
  });

  it("never turns an unanswered submission or unsubmitted exam draft into K", () => {
    const blank = question(1),
      draft = question(2),
      state = bank(blank, draft);
    respond(state, blank, "unanswered", { mode: "exam" });
    const session: OriginalSession = {
      id: "active_exam",
      mode: "exam",
      selection: structuredClone(defaultSelection),
      questions: [draft],
      assets: [],
      responses: { [draft.id]: 2 },
      review: {},
      index: 0,
      status: "active",
      startedAt: "2026-10-23T00:00:00Z",
      deadlineAt: "2026-10-23T01:40:00Z",
      finishedAt: null,
    };
    state.sessions.push(session);
    respond(state, draft, "incorrect", { sessionId: session.id, mode: "exam" });
    const analytics = aggregateLearning(state, "demo", defaultReviewScope, [
      blank.id,
      draft.id,
    ]);
    expect(analytics.overall).toMatchObject({ N: 2, A: 0, M: 2, K: 0 });
    expect(
      reviewCandidates(analytics, "constitution", "CONST-01", "unanswered").map(
        (q) => q.id,
      ),
    ).toEqual([blank.id, draft.id]);
    expect(
      [...analytics.questions.values()].every((row) => !row.orderConflict),
    ).toBe(true);
  });
});
