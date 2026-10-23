import { describe, expect, it } from "vitest";
import type {
  Attempt,
  OriginalSession,
  OriginalState,
} from "../src/original/engine";
import { initialOriginalState, defaultSelection } from "../src/original/engine";
import { demoData } from "../src/original/demo";
import type { Question } from "../src/original/model";
import {
  ACTIVE_SUBJECTS,
  aggregateLearning,
  DEFAULT_REVIEW_LIMIT,
  defaultReviewScope,
  formatPercent,
  MAX_RECOMMENDATIONS,
  MIN_GRADED_QUESTIONS,
  registryUnits,
  reviewCandidates,
  sortUnitStats,
} from "../src/original/review-analytics";

const prototype = demoData().questions[0];
function question(
  n: number,
  code: string | null = "CONST-01",
  subjectId: "constitution" | "criminal" | "police" = "constitution",
): Question {
  const q = structuredClone(prototype);
  q.id = `demo_${{ constitution: "const", criminal: "crim", police: "police" }[subjectId]}_${n}`;
  q.subjectId = subjectId;
  q.source.questionNumber = n;
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
function state(...questions: Question[]): OriginalState {
  const s = initialOriginalState("real");
  s.data.questions = questions;
  return s;
}
function respond(
  s: OriginalState,
  q: Question,
  result: Attempt["result"],
  at = "2026-10-21T00:00:00.000Z",
  overrides: Partial<Attempt> = {},
): Attempt {
  const a: Attempt = {
    attemptId: `attempt_${s.attempts.length}`,
    sessionId: `session_${s.attempts.length}`,
    questionId: q.id,
    revision: q.revision,
    gradingRevision: q.gradingRevision,
    mode: "study",
    response:
      result === "correct"
        ? 1
        : result === "incorrect"
          ? 2
          : result === "unknown"
            ? "unknown"
            : null,
    expectedChoices: [1],
    result,
    answeredAt: at,
    ...overrides,
  };
  s.attempts.push(a);
  return a;
}
function session(
  q: Question,
  status: OriginalSession["status"] = "active",
  mode: OriginalSession["mode"] = "exam",
): OriginalSession {
  return {
    id: "known_session",
    mode,
    selection: structuredClone(defaultSelection),
    questions: [q],
    assets: [],
    responses: {},
    review: {},
    index: 0,
    status,
    startedAt: "2026-10-21T00:00:00.000Z",
    deadlineAt: mode === "exam" ? "2026-10-21T01:40:00.000Z" : null,
    finishedAt: status === "active" ? null : "2026-10-21T00:01:00.000Z",
  };
}
const unit = (s: OriginalState, code = "CONST-01") =>
  aggregateLearning(s, "demo").units.find((u) => u.code === code)!;
function fillUnit(
  s: OriginalState,
  code: string,
  counts: { C?: number; W?: number; U?: number; M?: number },
  start = 1,
  at = "2026-10-21T00:00:00.000Z",
) {
  const questions: Question[] = [];
  let number = start;
  for (const key of ["C", "W", "U", "M"] as const)
    for (let i = 0; i < (counts[key] ?? 0); i++) {
      const q = question(number++, code);
      s.data.questions.push(q);
      questions.push(q);
      if (key !== "M")
        respond(
          s,
          q,
          { C: "correct", W: "incorrect", U: "unknown" }[
            key
          ] as Attempt["result"],
          at,
        );
    }
  return questions;
}

describe("eligible unique population and primary-unit attribution", () => {
  it("keeps all 82 registered descriptors, three subjects and null ratios for empty banks", () => {
    const a = aggregateLearning(state(), "demo");
    expect(a.units).toHaveLength(82);
    expect(a.subjects.map((s) => s.subjectId)).toEqual(ACTIVE_SUBJECTS);
    expect(a.overall).toMatchObject({
      N: 0,
      A: 0,
      C: 0,
      W: 0,
      U: 0,
      B: 0,
      M: 0,
      unresolved: 0,
      completionRate: null,
      wrongRate: null,
      unresolvedRate: null,
    });
    expect(a.recommendations).toEqual([]);
    expect(
      registryUnits.filter((u) => u.isTemporary).map((u) => u.code),
    ).toEqual(["CRIM-P-INV", "CRIM-P-EVD"]);
  });
  it("uses registry group order so criminal general precedes special and temporary areas", () => {
    const codes = registryUnits
      .filter((u) => u.subjectId === "criminal")
      .map((u) => u.code);
    expect(codes.indexOf("CRIM-G-12")).toBeLessThan(codes.indexOf("CRIM-S-01"));
    expect(codes.indexOf("CRIM-S-20")).toBeLessThan(
      codes.indexOf("CRIM-P-INV"),
    );
    expect(
      new Set(
        registryUnits
          .filter((u) => u.subjectId === "criminal")
          .map((u) => u.order),
      ).size,
    ).toBe(34);
  });
  it("deduplicates question IDs before counting or selecting review candidates", () => {
    const q = question(1);
    const s = state(q, structuredClone(q));
    respond(s, q, "incorrect");
    const a = aggregateLearning(s, "demo");
    expect(a.overall).toMatchObject({ N: 1, A: 1, W: 1 });
    expect(
      reviewCandidates(a, "constitution", "CONST-01", "review"),
    ).toHaveLength(1);
  });
  it("keeps real and demo eligibility separate without reading OX attempts", () => {
    const demo = question(1);
    const real = question(2);
    real.id = "const_2026_1_2";
    real.source.examCode = "po";
    real.officialAnswer.status = "final";
    real.source.questionPdf = { fileName: "test.pdf", pages: [1] };
    real.source.answerPdf = {
      fileName: "answers.pdf",
      pages: [1],
      subjectColumn: "헌법",
    };
    const s = state(demo, real);
    respond(s, demo, "incorrect");
    respond(s, real, "correct");
    expect(aggregateLearning(s, "demo").overall).toMatchObject({
      N: 1,
      C: 0,
      W: 1,
    });
    expect(aggregateLearning(s, "real").overall).toMatchObject({
      N: 1,
      C: 1,
      W: 0,
    });
  });
  it("filters subject, exam year and round together and copies its scope", () => {
    const a = question(1),
      b = question(2),
      c = question(3),
      d = question(1, "POL-01", "police");
    b.source.year = 2025;
    c.source.round = "2";
    const s = state(a, b, c, d);
    s.data.questions.forEach((q) => respond(s, q, "incorrect"));
    const scope = { subjectId: "constitution", year: "2026", round: "1" };
    const data = aggregateLearning(s, "demo", scope);
    scope.year = "2025";
    expect(data.overall).toMatchObject({ N: 1, A: 1, W: 1 });
    expect(data.scope.year).toBe("2026");
    expect(data.questions.has(a.id)).toBe(true);
    expect(data.units).toHaveLength(82);
  });
  it.each([
    "deleted",
    "retired",
    "text hold",
    "answer pending",
    "missing answer",
    "future subject",
  ])("excludes %s from population and recommendations", (condition) => {
    const q = question(1),
      s = state(q);
    respond(s, q, "incorrect");
    if (condition === "deleted") s.removedQuestionIds = [q.id];
    if (condition === "retired") q.lifecycle = "retired";
    if (condition === "text hold") q.qa.textStatus = "hold";
    if (condition === "answer pending") q.qa.answerStatus = "pending";
    if (condition === "missing answer") q.officialAnswer.status = "missing";
    if (condition === "future subject") q.subjectId = "criminology";
    expect(aggregateLearning(s, "demo").overall.N).toBe(0);
  });
  it("ignores marks, related units and book mappings for primary attribution", () => {
    const q = question(1);
    q.classification!.relatedStudyUnitCodes = ["CONST-02"];
    q.classification!.bookUnitIds = ["existing-book-node"];
    const s = state(q);
    s.marks[q.id] = true;
    const data = aggregateLearning(s, "demo");
    expect(data.overall).toMatchObject({ N: 1, A: 0, W: 0, M: 1 });
    expect(data.units.find((u) => u.code === "CONST-01")!.N).toBe(1);
    expect(data.units.find((u) => u.code === "CONST-02")!.N).toBe(0);
  });
  it.each([
    "null",
    "pending",
    "unknown code",
    "wrong subject",
    "confirmed null",
  ])("puts %s classification into the subject pending row", (condition) => {
    const q = question(1),
      s = state(q);
    respond(s, q, "unknown");
    if (condition === "null") q.classification = null;
    if (condition === "pending") q.classification!.studyStatus = "pending";
    if (condition === "unknown code")
      q.classification!.studyUnitCode = "CONST-999";
    if (condition === "wrong subject")
      q.classification!.studyUnitCode = "POL-01";
    if (condition === "confirmed null") q.classification!.studyUnitCode = null;
    const a = aggregateLearning(s, "demo"),
      subject = a.subjects[0];
    expect(subject.pending).toMatchObject({
      code: null,
      N: 1,
      A: 1,
      U: 1,
      unresolved: 1,
    });
    expect(subject.N).toBe(
      subject.pending.N + subject.units.reduce((n, u) => n + u.N, 0),
    );
    expect(a.recommendations).toEqual([]);
    expect(
      reviewCandidates(a, "constitution", null, "review").map((q) => q.id),
    ).toEqual([q.id]);
  });
  it("moves a newly confirmed primary unit without changing the subject total or history", () => {
    const q = question(1, null),
      s = state(q);
    respond(s, q, "incorrect");
    const before = aggregateLearning(s, "demo");
    q.revision++;
    q.classification = question(2, "CONST-02").classification;
    const after = aggregateLearning(s, "demo");
    expect(before.subjects[0].pending.A).toBe(1);
    expect(after.subjects[0].pending.A).toBe(0);
    expect(after.units.find((u) => u.code === "CONST-02")!.W).toBe(1);
    expect(after.subjects[0].A).toBe(before.subjects[0].A);
    expect(s.attempts).toHaveLength(1);
  });
});

describe("latest valid committed responses and recent three", () => {
  it("counts ten wrong attempts as one answered and wrong question", () => {
    const q = question(1),
      s = state(q);
    for (let i = 0; i < 10; i++) respond(s, q, "incorrect");
    const a = aggregateLearning(s, "demo");
    expect(a.overall).toMatchObject({ N: 1, A: 1, W: 1, repeated: 1 });
    expect(a.questions.get(q.id)!.recentAttempts).toHaveLength(3);
  });
  it("clears current unresolved/repeated status on a later correct response and preserves history", () => {
    const q = question(1),
      s = state(q);
    respond(s, q, "incorrect");
    respond(s, q, "incorrect");
    respond(s, q, "correct");
    const a = aggregateLearning(s, "demo");
    expect(a.overall).toMatchObject({ C: 1, W: 0, unresolved: 0, repeated: 0 });
    expect(a.recommendations).toEqual([]);
    expect(s.attempts).toHaveLength(3);
  });
  it("does not overwrite a valid correct answer with a later submitted exam blank", () => {
    const q = question(1),
      s = state(q);
    respond(s, q, "correct");
    respond(s, q, "unanswered", undefined, { mode: "exam" });
    expect(unit(s)).toMatchObject({ A: 1, C: 1, W: 0, U: 0 });
  });
  it("keeps exam-only blanks and temporary selections unlearned", () => {
    const q = question(1),
      s = state(q),
      active = session(q);
    active.responses[q.id] = 2;
    s.sessions.push(active);
    respond(s, q, "unanswered", undefined, { mode: "exam" });
    expect(unit(s)).toMatchObject({ A: 0, M: 1, W: 0 });
    expect(
      reviewCandidates(
        aggregateLearning(s, "demo"),
        "constitution",
        "CONST-01",
        "unanswered",
      ),
    ).toEqual([q]);
  });
  it("excludes malformed premature exam attempts while including active study submissions", () => {
    const q = question(1),
      s = state(q);
    s.sessions.push(session(q));
    respond(s, q, "incorrect", undefined, {
      mode: "exam",
      sessionId: "known_session",
    });
    expect(unit(s).A).toBe(0);
    s.sessions[0].mode = "study";
    s.attempts[0].mode = "study";
    expect(unit(s)).toMatchObject({ A: 1, W: 1 });
  });
  it("accepts completed exam responses without altering exam grading", () => {
    const q = question(1),
      s = state(q);
    s.sessions.push(session(q, "completed"));
    respond(s, q, "incorrect", undefined, {
      mode: "exam",
      sessionId: "known_session",
    });
    expect(unit(s).W).toBe(1);
    expect(s.attempts[0].result).toBe("incorrect");
  });
  it("uses array commit order even when dates tie or run backwards, and displays max valid timestamp", () => {
    const q = question(1),
      s = state(q);
    respond(s, q, "incorrect", "2026-10-22T00:00:00Z");
    respond(s, q, "correct", "2026-10-21T00:00:00Z");
    expect(unit(s)).toMatchObject({
      C: 1,
      W: 0,
      lastAnsweredAt: "2026-10-22T00:00:00Z",
    });
    respond(s, q, "unknown", "2026-10-21T00:00:00Z");
    expect(unit(s)).toMatchObject({ C: 0, U: 1 });
  });
  it("ignores old grading revisions but retains responses through classification-only revisions", () => {
    const q = question(1),
      s = state(q);
    respond(s, q, "correct");
    q.revision++;
    expect(unit(s).C).toBe(1);
    q.gradingRevision++;
    expect(unit(s)).toMatchObject({ A: 0, M: 1 });
    respond(s, q, "unknown");
    expect(unit(s)).toMatchObject({ A: 1, U: 1, C: 0 });
  });
  it.each([
    [null, "incorrect"],
    ["unknown", "correct"],
    [2, "unknown"],
    [5, "incorrect"],
    [1.5, "correct"],
    [1, "unanswered"],
  ])(
    "ignores invalid response/result combination %s/%s",
    (response, result) => {
      const q = question(1),
        s = state(q);
      respond(s, q, result as Attempt["result"], undefined, {
        response: response as Attempt["response"],
      });
      expect(unit(s).A).toBe(0);
    },
  );
  it("includes unknown in the recent-three window without counting it as an incorrect attempt", () => {
    const q = question(1),
      s = state(q);
    respond(s, q, "incorrect");
    respond(s, q, "incorrect");
    respond(s, q, "unknown");
    expect(unit(s)).toMatchObject({ U: 1, W: 0, B: 0, repeated: 1 });
    respond(s, q, "unknown");
    expect(unit(s).repeated).toBe(0);
  });
  it("does not let blanks or old grading records displace the recent three valid responses", () => {
    const q = question(1),
      s = state(q);
    respond(s, q, "incorrect");
    respond(s, q, "incorrect");
    respond(s, q, "unknown");
    respond(s, q, "unanswered");
    respond(s, q, "correct", undefined, { gradingRevision: 99 });
    expect(unit(s)).toMatchObject({ U: 1, repeated: 1 });
  });
});

describe("metrics, recommendation tiers and deterministic ordering", () => {
  it("matches all acceptance-table metrics and ranks A before small-sample B", () => {
    const s = state();
    fillUnit(s, "CONST-01", { C: 6, W: 4, U: 2, M: 8 }, 1);
    fillUnit(s, "CONST-02", { W: 1, M: 19 }, 101);
    fillUnit(s, "CONST-03", { M: 12 }, 201);
    fillUnit(s, "CONST-04", { U: 3, M: 1 }, 301);
    fillUnit(s, "CONST-05", { C: 10 }, 401);
    const a = aggregateLearning(s, "demo"),
      rows = a.units;
    expect(rows.find((u) => u.code === "CONST-01")).toMatchObject({
      N: 20,
      A: 12,
      C: 6,
      W: 4,
      U: 2,
      B: 10,
      M: 8,
      unresolved: 6,
      completionRate: 0.6,
      wrongRate: 0.4,
      unresolvedRate: 0.5,
    });
    expect(rows.find((u) => u.code === "CONST-02")).toMatchObject({
      completionRate: 0.05,
      wrongRate: 1,
    });
    expect(rows.find((u) => u.code === "CONST-03")).toMatchObject({
      completionRate: 0,
      wrongRate: null,
    });
    expect(rows.find((u) => u.code === "CONST-04")).toMatchObject({
      completionRate: 0.75,
      wrongRate: null,
      unresolved: 3,
    });
    expect(rows.find((u) => u.code === "CONST-05")).toMatchObject({
      completionRate: 1,
      wrongRate: 0,
    });
    expect(a.recommendations.map((r) => r.unit.code)).toEqual([
      "CONST-01",
      "CONST-04",
      "CONST-02",
    ]);
    expect(a.recommendations.map((r) => r.tier)).toEqual([
      "priority",
      "supplemental",
      "supplemental",
    ]);
    expect(a.recommendations[1].badge).toBe("표본 부족·추가 확인");
    for (const row of [...rows, a.overall, ...a.subjects]) {
      expect(row.A).toBe(row.C + row.W + row.U);
      expect(row.N).toBe(row.C + row.W + row.U + row.M);
    }
  });
  it("handles unknown-only units without inventing an incorrect rate", () => {
    const s = state();
    fillUnit(s, "CONST-01", { U: 3 });
    expect(unit(s)).toMatchObject({
      A: 3,
      B: 0,
      wrongRate: null,
      unresolvedRate: 1,
    });
    expect(formatPercent(unit(s).wrongRate)).toBe("—");
  });
  it("uses the unknown-review badge when enough judged answers are all correct", () => {
    const s = state();
    fillUnit(s, "CONST-01", { C: 5, U: 1 });
    const recommendation = aggregateLearning(s, "demo").recommendations[0];
    expect(recommendation).toMatchObject({
      tier: "supplemental",
      badge: "모르겠음 복습",
      reviewCount: 1,
    });
  });
  it("prioritizes wrong rate then wrong count using raw rather than rounded percentages", () => {
    const s = state();
    fillUnit(s, "CONST-01", { C: 6, W: 4 }, 1);
    fillUnit(s, "CONST-02", { C: 3, W: 2 }, 101);
    fillUnit(s, "CONST-03", { C: 4, W: 3 }, 201);
    expect(
      aggregateLearning(s, "demo").recommendations.map((r) => r.unit.code),
    ).toEqual(["CONST-03", "CONST-01", "CONST-02"]);
  });
  it("prioritizes repeated errors, then older response dates, then registry sequence", () => {
    const s = state();
    const first = fillUnit(
      s,
      "CONST-01",
      { C: 4, W: 1 },
      1,
      "2026-10-20T00:00:00Z",
    );
    const second = fillUnit(
      s,
      "CONST-02",
      { C: 4, W: 1 },
      101,
      "2026-10-22T00:00:00Z",
    );
    fillUnit(s, "CONST-03", { C: 4, W: 1 }, 201, "2026-10-20T00:00:00Z");
    respond(s, second[4], "incorrect", "2026-10-22T00:00:00Z");
    expect(
      aggregateLearning(s, "demo").recommendations.map((r) => r.unit.code),
    ).toEqual(["CONST-02", "CONST-01", "CONST-03"]);
    expect(first).toHaveLength(5);
  });
  it("uses supplemental unresolved rate then unresolved count before age", () => {
    const s = state();
    fillUnit(s, "CONST-01", { C: 1, U: 2 }, 1);
    fillUnit(s, "CONST-02", { U: 1 }, 101);
    fillUnit(s, "CONST-03", { U: 2 }, 201);
    expect(
      aggregateLearning(s, "demo").recommendations.map((r) => r.unit.code),
    ).toEqual(["CONST-03", "CONST-02", "CONST-01"]);
  });
  it("caps recommendation count, uses central defaults and never fills with correct or unlearned units", () => {
    const s = state();
    for (let i = 1; i <= 4; i++) fillUnit(s, `CONST-0${i}`, { W: 1 }, 100 * i);
    fillUnit(s, "CONST-05", { C: 6 }, 501);
    fillUnit(s, "CONST-06", { M: 6 }, 601);
    expect(aggregateLearning(s, "demo").recommendations).toHaveLength(
      MAX_RECOMMENDATIONS,
    );
    expect([
      MIN_GRADED_QUESTIONS,
      MAX_RECOMMENDATIONS,
      DEFAULT_REVIEW_LIMIT,
    ]).toEqual([5, 3, 20]);
  });
  it("formats absent and zero ratios distinctly and does not expose nonfinite values", () => {
    expect([
      formatPercent(null),
      formatPercent(0),
      formatPercent(0.6),
      formatPercent(4 / 9),
      formatPercent(NaN),
      formatPercent(Infinity),
    ]).toEqual(["—", "0.0%", "60.0%", "44.4%", "—", "—"]);
  });
});

describe("exact review lists, sorting and fresh recalculation", () => {
  it("reviews wrong before unknown, repeated before single, then older dates and stable IDs", () => {
    const s = state();
    const a = question(1),
      b = question(2),
      c = question(3),
      d = question(4),
      e = question(5),
      f = question(6),
      g = question(7);
    s.data.questions = [g, f, e, d, c, b, a];
    respond(s, a, "incorrect", "2026-10-20T00:00:00Z");
    respond(s, b, "incorrect", "2026-10-22T00:00:00Z");
    respond(s, b, "incorrect", "2026-10-22T00:00:00Z");
    respond(s, c, "unknown", "2026-10-19T00:00:00Z");
    respond(s, d, "incorrect", "2026-10-20T00:00:00Z");
    respond(s, e, "incorrect");
    respond(s, e, "incorrect");
    respond(s, e, "unknown");
    respond(s, f, "correct");
    expect(
      reviewCandidates(
        aggregateLearning(s, "demo"),
        "constitution",
        "CONST-01",
        "review",
      ).map((q) => q.id),
    ).toEqual([b.id, a.id, d.id, e.id, c.id]);
  });
  it("limits exact primary/scope candidates to 20, without filling with related, correct or absent IDs", () => {
    const s = state();
    fillUnit(s, "CONST-01", { W: 25 }, 1);
    const other = fillUnit(s, "CONST-02", { W: 1 }, 101)[0];
    other.classification!.relatedStudyUnitCodes = ["CONST-01"];
    fillUnit(s, "CONST-01", { C: 1, M: 1 }, 201);
    const a = aggregateLearning(s, "demo"),
      candidates = reviewCandidates(
        a,
        "constitution",
        "CONST-01",
        "review",
        999,
      );
    expect(candidates).toHaveLength(20);
    expect(candidates.some((q) => q.id === other.id)).toBe(false);
    expect(new Set(candidates.map((q) => q.id)).size).toBe(20);
    expect(
      reviewCandidates(a, "constitution", "CONST-01", "review", 2),
    ).toHaveLength(2);
    expect(reviewCandidates(a, "police", "CONST-01", "review")).toEqual([]);
    expect(
      a.recommendations.find((r) => r.unit.code === "CONST-01")!.reviewCount,
    ).toBe(20);
  });
  it("treats only-blank submissions as unanswered and caps unanswered learning too", () => {
    const s = state();
    const list = fillUnit(s, "CONST-01", { M: 25 });
    respond(s, list[0], "unanswered", undefined, { mode: "exam" });
    const a = aggregateLearning(s, "demo");
    expect(a.overall.A).toBe(0);
    expect(
      reviewCandidates(a, "constitution", "CONST-01", "unanswered"),
    ).toHaveLength(20);
    expect(
      reviewCandidates(a, "constitution", "CONST-01", "unanswered", 0),
    ).toEqual([]);
  });
  it("sorts null rates last, preserves registry ties and never mutates its inputs", () => {
    const s = state();
    fillUnit(s, "CONST-01", { C: 1, M: 1 }, 1);
    fillUnit(s, "CONST-02", { W: 1, M: 1 }, 101);
    fillUnit(s, "CONST-03", { M: 1 }, 201);
    const rows = aggregateLearning(s, "demo").units.slice(0, 4),
      before = rows.map((u) => u.code);
    expect(sortUnitStats(rows, "completion").map((u) => u.code)).toEqual([
      "CONST-03",
      "CONST-01",
      "CONST-02",
      "CONST-04",
    ]);
    expect(sortUnitStats(rows, "wrong").map((u) => u.code)).toEqual([
      "CONST-02",
      "CONST-01",
      "CONST-03",
      "CONST-04",
    ]);
    expect(
      sortUnitStats([...rows].reverse(), "registry").map((u) => u.code),
    ).toEqual(before);
    expect(rows.map((u) => u.code)).toEqual(before);
  });
  it("recalculates immediately after answers, deletion, grading changes and restoration without persisting stats", () => {
    const q = question(1),
      s = state(q);
    respond(s, q, "incorrect");
    const backup = structuredClone(s);
    const before = JSON.stringify(s);
    aggregateLearning(s, "demo");
    expect(JSON.stringify(s)).toBe(before);
    respond(s, q, "correct");
    expect(aggregateLearning(s, "demo").recommendations).toEqual([]);
    s.removedQuestionIds = [q.id];
    expect(aggregateLearning(s, "demo").overall.N).toBe(0);
    expect(aggregateLearning(backup, "demo").overall.W).toBe(1);
    backup.data.questions[0].gradingRevision++;
    expect(aggregateLearning(backup, "demo").overall.A).toBe(0);
    expect(defaultReviewScope).toEqual({ subjectId: "", year: "", round: "" });
  });
});
