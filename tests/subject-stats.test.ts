import { expect, it } from "vitest";
import { initialState } from "../src/fixtures/data";
import { defaultSelection } from "../src/domain/schema";
import { startSession, submit, subjectSummaries } from "../src/domain/engine";

it("과목 통계는 제출 당시 과목과 정답 기준을 구분하고 반복·모르겠음도 포함한다", () => {
  const s = initialState(true);
  const item = structuredClone(s.dataset.items[0]);
  const answer = (
    subjectId: typeof item.subjectId,
    basis: "exam" | "current",
    response: "O" | "unknown",
  ) => {
    const snapshot = { ...structuredClone(item), subjectId };
    snapshot.judgments.current = structuredClone(snapshot.judgments.exam);
    startSession(s, { ...defaultSelection, subjectId, basis }, [snapshot]);
    const session = s.sessions.at(-1)!;
    submit(s, session.id, response);
    session.status = "ended";
  };
  answer("constitution", "exam", "O");
  answer("constitution", "exam", "unknown");
  answer("criminal", "exam", "O");
  answer("constitution", "current", "O");
  s.dataset.items[0].subjectId = "police";
  const exam = subjectSummaries(s, "exam");
  expect(exam.constitution).toMatchObject({
    answered: 2,
    correct: 1,
    rate: "50%",
  });
  expect(exam.criminal).toMatchObject({ answered: 1, rate: "100%" });
  expect(exam.police).toMatchObject({ answered: 0, rate: "—" });
  expect(subjectSummaries(s, "current").constitution).toMatchObject({
    answered: 1,
    rate: "100%",
  });
});
