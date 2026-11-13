import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { initialOriginalState } from "../src/original/engine";
import {
  createReport,
  QuestionReportRepository,
  reportScope,
} from "../src/original/reports/repository";

it("keeps reports isolated by signed-in account, guest, and study area", async () => {
  const name = crypto.randomUUID();
  const repository = new QuestionReportRepository(name);
  const question = initialOriginalState("demo").data.questions[0];
  const owner = reportScope("real", "learner-a");
  const other = reportScope("real", "learner-b");
  const guest = reportScope("real", null);
  const demo = reportScope("demo", "learner-a");
  const original = createReport(question, "both");
  await repository.change(owner, question.id, undefined, original);
  const reopened = new QuestionReportRepository(name);
  await expect(reopened.list(owner)).resolves.toEqual([original]);
  await expect(reopened.list(other)).resolves.toEqual([]);
  await expect(reopened.list(guest)).resolves.toEqual([]);
  await expect(reopened.list(demo)).resolves.toEqual([]);
  expect(demo).toBe(reportScope("demo", "learner-b"));
});

it("serializes edits and deletion without overwriting another tab's newer report", async () => {
  const name = crypto.randomUUID();
  const first = new QuestionReportRepository(name);
  const second = new QuestionReportRepository(name);
  const scope = reportScope("demo", null);
  const [question, another] = initialOriginalState("demo").data.questions;
  const report = createReport(question, "question");
  const otherReport = createReport(another, "explanation");
  await Promise.all([
    first.change(scope, question.id, undefined, report),
    second.change(scope, another.id, undefined, otherReport),
  ]);
  const resolved = { ...report, resolved: true, changeId: crypto.randomUUID() };
  await second.change(scope, question.id, report.changeId, resolved);
  await expect(
    first.change(scope, question.id, report.changeId, null),
  ).rejects.toThrow("다른 탭");
  await expect(first.list(scope)).resolves.toEqual(
    expect.arrayContaining([resolved, otherReport]),
  );
  await first.change(scope, question.id, resolved.changeId, null);
  await expect(second.list(scope)).resolves.toEqual([otherReport]);
});
