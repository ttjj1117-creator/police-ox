import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answer,
  defaultSelection,
  finish,
  initialOriginalState,
  move,
  startSession,
  type OriginalState,
} from "../src/original/engine";
import {
  applyLearningCommand,
  type LearningCommand,
} from "../src/original/learning";
import { OriginalRepository } from "../src/original/storage";
import { accountStateKey, SyncAccountStore } from "../src/original/sync/local";
import { expectedQuestionId } from "../src/original/validation";

const at = Date.parse("2026-11-05T00:00:00Z");
const ownerA = "https://test-only.example|11111111-1111-4111-8111-111111111111";
const ownerB = "https://test-only.example|22222222-2222-4222-8222-222222222222";
const resources: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

/** Neutral shapes in real-format test records, not actual exams or legal data. */
function bank(): OriginalState {
  const state = initialOriginalState("real");
  state.data.questions = initialOriginalState("demo").data.questions.map(
    (q) => {
      q.source.examCode = "po";
      q.source.examName = "TEST_ONLY neutral shape fixture";
      q.source.questionPdf = {
        fileName: "TEST_ONLY_questions.pdf",
        pages: [1],
      };
      q.source.answerPdf = {
        fileName: "TEST_ONLY_answers.pdf",
        pages: [1],
        subjectColumn: "TEST_ONLY",
      };
      q.officialAnswer.status = "final";
      q.id = expectedQuestionId(q);
      return q;
    },
  );
  return state;
}
function activeState(mode: "study" | "exam" = "study", real = false) {
  const state = real ? bank() : initialOriginalState("demo");
  const session = startSession(
    state,
    real ? "real" : "demo",
    defaultSelection,
    mode,
    at,
    mode === "study" ? state.data.questions.slice(0, 2) : undefined,
  );
  return { state, session };
}
function stores() {
  const name = `learning-${crypto.randomUUID()}`;
  const repo = new OriginalRepository(name);
  const account = new SyncAccountStore(name);
  resources.push(repo, account);
  return { name, repo, account };
}
function freezeTree(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}
function replay(
  state: OriginalState,
  steps: { command: LearningCommand; oldEngine: (s: OriginalState) => void }[],
) {
  let current = state;
  for (const { command, oldEngine } of steps) {
    const before = structuredClone(current);
    const expected = structuredClone(current);
    oldEngine(expected);
    const next = applyLearningCommand(current, command);
    expect(next).toEqual(expected);
    expect(current).toEqual(before);
    expect(applyLearningCommand(current, command)).toEqual(next);
    current = next;
  }
  return current;
}

describe("restricted learning operations retain grading and snapshot semantics", () => {
  it("replays a study answer/mark/font/move/finish exactly while preserving old snapshots and input state", () => {
    const state = initialOriginalState("demo");
    const historical = startSession(
      state,
      "demo",
      defaultSelection,
      "study",
      at - 10000,
      [state.data.questions[0]],
    );
    answer(state, historical.id, "unknown", at - 9000);
    finish(state, historical.id, at - 8000);
    const session = startSession(
      state,
      "demo",
      defaultSelection,
      "study",
      at,
      state.data.questions.slice(0, 2),
    );
    const q = session.questions[0];
    const original = structuredClone(state);
    freezeTree(state);
    const next = replay(state, [
      {
        command: {
          kind: "answer",
          sessionId: session.id,
          response: 1,
          at: at + 1,
        },
        oldEngine: (s) => {
          answer(s, session.id, 1, at + 1);
        },
      },
      {
        command: {
          kind: "mark",
          sessionId: session.id,
          questionId: q.id,
          at: at + 2,
        },
        oldEngine: (s) => {
          s.marks[q.id] = true;
        },
      },
      {
        command: { kind: "font", scale: 1.5, at: at + 3 },
        oldEngine: (s) => {
          s.settings.fontScale = 1.5;
        },
      },
      {
        command: { kind: "move", sessionId: session.id, index: 1, at: at + 4 },
        oldEngine: (s) => {
          move(s, session.id, 1, at + 4);
        },
      },
      {
        command: {
          kind: "answer",
          sessionId: session.id,
          response: "unknown",
          at: at + 5,
        },
        oldEngine: (s) => {
          answer(s, session.id, "unknown", at + 5);
        },
      },
      {
        command: { kind: "finish", sessionId: session.id, at: at + 6 },
        oldEngine: (s) => {
          finish(s, session.id, at + 6);
        },
      },
      {
        command: {
          kind: "mark",
          sessionId: session.id,
          questionId: q.id,
          at: at + 7,
        },
        oldEngine: (s) => {
          s.marks[q.id] = false;
        },
      },
    ]);
    expect(state).toEqual(original);
    expect(next.sessions[0]).toBe(historical);
    expect(next.data).toBe(state.data);
    expect(next.sessions[1].questions).toBe(session.questions);
    expect(next.sessions[1].assets).toBe(session.assets);
    expect(next.sessions[1].status).toBe("completed");
    expect(next.attempts).toHaveLength(3);
  });

  it("keeps editable exam answers and review flags private until the unchanged engine submits all snapshots", () => {
    const { state, session } = activeState("exam");
    const [first, second] = session.questions;
    const draft = replay(state, [
      {
        command: {
          kind: "answer",
          sessionId: session.id,
          response: 1,
          at: at + 1,
        },
        oldEngine: (s) => {
          answer(s, session.id, 1, at + 1);
        },
      },
      {
        command: {
          kind: "answer",
          sessionId: session.id,
          response: 2,
          at: at + 2,
        },
        oldEngine: (s) => {
          answer(s, session.id, 2, at + 2);
        },
      },
      {
        command: { kind: "move", sessionId: session.id, index: 1, at: at + 3 },
        oldEngine: (s) => {
          move(s, session.id, 1, at + 3);
        },
      },
      {
        command: {
          kind: "review",
          sessionId: session.id,
          questionId: second.id,
          at: at + 4,
        },
        oldEngine: (s) => {
          s.sessions[0].review[second.id] = true;
        },
      },
      {
        command: {
          kind: "mark",
          sessionId: session.id,
          questionId: second.id,
          at: at + 5,
        },
        oldEngine: (s) => {
          s.marks[second.id] = true;
        },
      },
      {
        command: {
          kind: "answer",
          sessionId: session.id,
          response: "unknown",
          at: at + 6,
        },
        oldEngine: (s) => {
          answer(s, session.id, "unknown", at + 6);
        },
      },
    ]);
    expect(draft.attempts).toEqual([]);
    expect(draft.sessions[0].responses[first.id]).toBe(2);
    expect(draft.sessions[0].review[second.id]).toBe(true);
    const submitted = replay(draft, [
      {
        command: { kind: "finish", sessionId: session.id, at: at + 10000 },
        oldEngine: (s) => {
          finish(s, session.id, at + 10000);
        },
      },
    ]);
    expect(submitted.attempts).toHaveLength(100);
    expect(
      submitted.attempts.filter((a) => a.result === "unanswered"),
    ).toHaveLength(98);
    expect(
      submitted.attempts.every(
        (a) => a.answeredAt === new Date(at + 10000).toISOString(),
      ),
    ).toBe(true);
    expect(submitted.sessions[0].deadlineAt).toBe(session.deadlineAt);
  });

  it("answer, navigation, mark, review and expiry after the deadline grade the last answers once at the absolute deadline", () => {
    const { state, session } = activeState("exam");
    answer(state, session.id, 1, at + 1);
    const deadline = Date.parse(session.deadlineAt!);
    const expected = structuredClone(state);
    finish(expected, session.id, deadline + 5000);
    const commands: LearningCommand[] = [
      {
        kind: "answer",
        sessionId: session.id,
        response: 4,
        at: deadline + 5000,
      },
      { kind: "move", sessionId: session.id, index: 1, at: deadline + 5000 },
      {
        kind: "mark",
        sessionId: session.id,
        questionId: session.questions[0].id,
        at: deadline + 5000,
      },
      {
        kind: "review",
        sessionId: session.id,
        questionId: session.questions[0].id,
        at: deadline + 5000,
      },
      { kind: "expire", at: deadline + 5000 },
      { kind: "finish", sessionId: session.id, at: deadline + 5000 },
    ];
    for (const command of commands) {
      const result = applyLearningCommand(state, command);
      expect(result).toEqual(expected);
      expect(
        applyLearningCommand(result, { kind: "expire", at: deadline + 10000 }),
      ).toEqual(expected);
      expect(
        result.attempts.every((a) => a.answeredAt === session.deadlineAt),
      ).toBe(true);
    }
    expect(state.sessions[0].status).toBe("active");
    expect(state.attempts).toEqual([]);
  });

  it("rejects invalid operation inputs without mutating any shared source or history", () => {
    const { state, session } = activeState();
    const before = structuredClone(state);
    const invalid = [
      { kind: "replace-bank", data: { questions: [] }, at },
      { kind: "font", scale: 0.5, at },
      { kind: "font", scale: NaN, at },
      { kind: "answer", sessionId: session.id, response: 9, at },
      { kind: "review", sessionId: session.id, questionId: "missing", at },
      { kind: "move", sessionId: session.id, index: 1, at: NaN },
    ];
    for (const value of invalid) {
      expect(() =>
        applyLearningCommand(state, value as unknown as LearningCommand),
      ).toThrow();
      expect(state).toEqual(before);
    }
  });
});

describe("restricted learning transactions", () => {
  it("replays the command on durable state and ignores an attempted caller bank/state replacement", async () => {
    const { repo } = stores();
    const { state, session } = activeState();
    const saved = await repo.save("demo", state, 0);
    const command = {
      kind: "answer",
      sessionId: session.id,
      response: "unknown",
      at: at + 1,
    } as const;
    const result = await repo.saveLearning(
      "demo",
      {
        ...command,
        data: { questions: [] },
        state: { sessions: [] },
      } as LearningCommand,
      saved.generation,
    );
    expect(result.generation).toBe(saved.generation + 1);
    expect(result.state).toEqual(applyLearningCommand(saved.state, command));
    expect((await repo.load("demo")).state.data).toEqual(saved.state.data);
    expect(result.state.attempts).toHaveLength(1);
    expect(result.state.attempts[0].response).toBe("unknown");
  });

  it("rolls back unknown commands and still rejects active-bank edits on the general save path", async () => {
    const { repo } = stores();
    const { state } = activeState();
    const before = await repo.save("demo", state, 0);
    await expect(
      repo.saveLearning(
        "demo",
        {
          kind: "replace-bank",
          at,
          data: { questions: [] },
        } as unknown as LearningCommand,
        before.generation,
      ),
    ).rejects.toThrow("지원하지");
    expect(await repo.load("demo")).toEqual(before);
    const edited = structuredClone(before.state);
    edited.data.questions[0].body = [
      { type: "text", text: "TEST_ONLY changed bank" },
    ];
    await expect(repo.save("demo", edited, before.generation)).rejects.toThrow(
      "종료",
    );
    expect(await repo.load("demo")).toEqual(before);
  });

  it("detects a two-tab stale generation and preserves the committed answer and its order metadata", async () => {
    const { name, repo, account } = stores();
    const other = new OriginalRepository(name);
    resources.push(other);
    repo.useAccount(ownerA);
    other.useAccount(ownerA);
    const { state, session } = activeState("study", true);
    const first = await repo.save("real", state, 0);
    const stale = await other.load("real");
    const saved = await repo.saveLearning(
      "real",
      {
        kind: "answer",
        sessionId: session.id,
        response: "unknown",
        at: at + 1,
      },
      first.generation,
    );
    await expect(
      other.saveLearning(
        "real",
        { kind: "move", sessionId: session.id, index: 1, at: at + 2 },
        stale.generation,
      ),
    ).rejects.toThrow("다른 탭");
    const durable = await account.read(ownerA);
    expect(durable.state).toEqual(saved.state);
    expect(durable.generation).toBe(saved.generation);
    expect(
      durable.meta.projection.order[saved.state.attempts[0].attemptId],
    ).toBeDefined();
    expect(durable.meta.outbox.filter((e) => e.kind === "session")).toEqual([]);
  });

  it("aborts an already queued metadata write when the state put fails, then retries the same answer atomically", async () => {
    const { repo, account } = stores();
    repo.useAccount(ownerA);
    const { state, session } = activeState("study", true);
    const saved = await repo.save("real", state, 0);
    const before = await account.read(ownerA);
    const command = {
      kind: "answer",
      sessionId: session.id,
      response: "unknown",
      at: at + 1,
    } as const;
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, value, key) {
        if (key === accountStateKey(ownerA))
          throw new DOMException("TEST_ONLY quota", "QuotaExceededError");
        return key === undefined
          ? put.call(this, value)
          : put.call(this, value, key);
      });
    try {
      await expect(
        repo.saveLearning("real", command, saved.generation),
      ).rejects.toThrow("quota");
    } finally {
      spy.mockRestore();
    }
    expect(await account.read(ownerA)).toEqual(before);
    const retried = await repo.saveLearning("real", command, saved.generation);
    const durable = await account.read(ownerA);
    expect(durable.state).toEqual(retried.state);
    expect(durable.generation).toBe(saved.generation + 1);
    expect(durable.state.attempts).toHaveLength(1);
    expect(
      durable.meta.projection.order[durable.state.attempts[0].attemptId],
    ).toBeDefined();
    expect(durable.meta.nextSequence).toBeGreaterThan(before.meta.nextSequence);
    expect(durable.meta.outbox.filter((e) => e.kind === "session")).toEqual([]);
  });

  it("separates linked owners, unlinked real data and demo commands in the existing stores", async () => {
    const { repo, account } = stores();
    const { state, session } = activeState("study", true);
    repo.useAccount(ownerA);
    let saved = await repo.save("real", state, 0);
    saved = await repo.saveLearning(
      "real",
      { kind: "answer", sessionId: session.id, response: 1, at: at + 1 },
      saved.generation,
    );
    const a = await account.read(ownerA);
    repo.useAccount(ownerB);
    await repo.save("real", bank(), 0);
    await repo.saveLearning("real", { kind: "font", scale: 1.5, at }, 1);
    const b = await account.read(ownerB);
    const demo = activeState();
    await repo.save("demo", demo.state, 0);
    await repo.saveLearning(
      "demo",
      {
        kind: "mark",
        sessionId: demo.session.id,
        questionId: demo.session.questions[0].id,
        at: at + 2,
      },
      1,
    );
    expect(await account.read(ownerA)).toEqual(a);
    expect(await account.read(ownerB)).toEqual(b);
    repo.useAccount(null);
    await repo.save("real", bank(), 0);
    await repo.saveLearning("real", { kind: "font", scale: 2, at }, 1);
    expect((await repo.load("real")).state.settings.fontScale).toBe(2);
    repo.useAccount(ownerA);
    expect((await repo.load("real")).state).toEqual(saved.state);
    expect(
      (await repo.load("demo")).state.marks[demo.session.questions[0].id],
    ).toBe(true);
    repo.useAccount(ownerB);
    expect((await repo.load("real")).state.settings.fontScale).toBe(1.5);
    expect((await repo.load("real")).state.attempts).toEqual([]);
  });

  it("queues a completed study snapshot once and never misclassifies ordinary learning as a bank replacement", async () => {
    const { repo, account } = stores();
    repo.useAccount(ownerA);
    const { state, session } = activeState("study", true);
    let saved = await repo.save("real", state, 0);
    for (const command of [
      {
        kind: "answer",
        sessionId: session.id,
        response: "unknown",
        at: at + 1,
      },
      { kind: "answer", sessionId: session.id, response: 1, at: at + 2 },
      { kind: "move", sessionId: session.id, index: 1, at: at + 3 },
    ] as LearningCommand[])
      saved = await repo.saveLearning("real", command, saved.generation);
    expect(saved.state.attempts).toHaveLength(1);
    expect(
      (await account.read(ownerA)).meta.outbox.filter(
        (e) => e.kind === "session",
      ),
    ).toEqual([]);
    saved = await repo.saveLearning(
      "real",
      { kind: "finish", sessionId: session.id, at: at + 4 },
      saved.generation,
    );
    saved = await repo.saveLearning(
      "real",
      { kind: "finish", sessionId: session.id, at: at + 5 },
      saved.generation,
    );
    const durable = await account.read(ownerA);
    const closed = durable.meta.outbox.filter((e) => e.kind === "session");
    expect(closed).toHaveLength(1);
    expect(closed[0].payload.session.status).toBe("ended");
    expect(closed[0].payload.attempts).toEqual(saved.state.attempts);
    expect(closed[0].payload.session.questions).toEqual(session.questions);
    expect(durable.meta.outbox.filter((e) => e.kind === "bank")).toHaveLength(
      1,
    );
    expect(durable.state.data).toEqual(state.data);
  });

  it("keeps active exam responses local, then persists one deadline-capped grade and closed-session outbox", async () => {
    const { repo, account } = stores();
    repo.useAccount(ownerA);
    const { state, session } = activeState("exam", true);
    let saved = await repo.save("real", state, 0);
    saved = await repo.saveLearning(
      "real",
      { kind: "answer", sessionId: session.id, response: 1, at: at + 1 },
      saved.generation,
    );
    saved = await repo.saveLearning(
      "real",
      { kind: "move", sessionId: session.id, index: 1, at: at + 2 },
      saved.generation,
    );
    let durable = await account.read(ownerA);
    expect(durable.state.sessions[0].responses[session.questions[0].id]).toBe(
      1,
    );
    expect(durable.state.attempts).toEqual([]);
    expect(durable.meta.outbox.filter((e) => e.kind === "session")).toEqual([]);
    expect(Object.keys(durable.meta.projection.order)).toEqual([]);
    const deadline = Date.parse(session.deadlineAt!);
    saved = await repo.saveLearning(
      "real",
      { kind: "expire", at: deadline + 1000 },
      saved.generation,
    );
    saved = await repo.saveLearning(
      "real",
      { kind: "expire", at: deadline + 2000 },
      saved.generation,
    );
    durable = await account.read(ownerA);
    expect(durable.state).toEqual(saved.state);
    expect(durable.state.sessions[0].finishedAt).toBe(session.deadlineAt);
    expect(durable.state.attempts).toHaveLength(100);
    expect(
      durable.state.attempts.every((a) => a.answeredAt === session.deadlineAt),
    ).toBe(true);
    expect(
      durable.meta.outbox.filter((e) => e.kind === "session"),
    ).toHaveLength(1);
    expect(durable.meta.outbox.filter((e) => e.kind === "bank")).toHaveLength(
      1,
    );
  });
});
