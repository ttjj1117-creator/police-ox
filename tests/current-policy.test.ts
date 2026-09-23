import { expect, it } from "vitest";
import { initialState } from "../src/fixtures/data";
import { defaultSelection } from "../src/domain/schema";
import { useCurrentLearning } from "../src/domain/current-policy";
import { candidates, startSession, submit } from "../src/domain/engine";

it("현행 학습을 기본으로 하고 기존 세션은 기록을 보존하여 종료한다", () => {
  const s = initialState(true);
  expect(defaultSelection.basis).toBe("current");
  startSession(s, { ...defaultSelection, basis: "exam" });
  submit(s, s.sessions[0].id, "O");
  expect(useCurrentLearning(s, false)).toBe(true);
  expect(s.sessions[0].status).toBe("ended");
  expect(s.attempts).toHaveLength(1);
  expect(useCurrentLearning(s, false)).toBe(false);
});
it("현행 미검증 실제 지문을 이전 정답으로 대체하지 않는다", () => {
  const s = initialState(true);
  s.dataset.items.forEach((item) => {
    item.judgments.current.status = "draft";
  });
  useCurrentLearning(s, false);
  expect(candidates(s, defaultSelection)).toHaveLength(0);
});
