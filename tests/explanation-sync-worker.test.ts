import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExplanationSyncWorkerClient,
  type ExplanationWorkerPort,
  type ExplanationWorkerRequest,
} from "../src/original/explanations/sync-worker-client";
import {
  cancelExplanationSyncWorker,
  syncExplanationLibraries,
} from "../src/original/explanations/sync-runner";
import { syncExplanationLibrariesCore } from "../src/original/explanations/sync-runner-core";
import type { AuthSession } from "../src/original/sync/transport";

vi.mock("../src/original/explanations/sync-runner-core", () => ({
  syncExplanationLibrariesCore: vi.fn(),
}));

type WorkerEvent = "message" | "error" | "messageerror";
type WorkerListener = (event: Event) => void;
type RunMessage = Extract<ExplanationWorkerRequest, { type: "run" }>;
const config = {
  url: "https://worker-lifecycle.test",
  key: "sb_publishable_TEST_ONLY",
};
const authA: AuthSession = {
  access_token: "TEST_ONLY_access",
  refresh_token: "TEST_ONLY_refresh",
  expires_at: 4_000_000_000,
  user: { id: "11111111-1111-4111-8111-111111111111" },
};
const authB: AuthSession = {
  ...authA,
  user: { id: "22222222-2222-4222-8222-222222222222" },
};
const ownerFor = (auth: AuthSession) => `${config.url}|${auth.user.id}`;
const clients: ExplanationSyncWorkerClient[] = [];

class FakeWorker implements ExplanationWorkerPort {
  private listeners = new Map<WorkerEvent, Set<WorkerListener>>();
  sent: ExplanationWorkerRequest[] = [];
  postMessage = vi.fn((message: ExplanationWorkerRequest) => {
    this.sent.push(structuredClone(message));
  });
  terminate = vi.fn();
  addEventListener(type: WorkerEvent, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WorkerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: WorkerEvent, listener: WorkerListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(data: unknown): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
  fail(type: "error" | "messageerror"): Event {
    const event = new Event(type, { cancelable: true });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  runs(): RunMessage[] {
    return this.sent.filter(
      (message): message is RunMessage => message.type === "run",
    );
  }
  lastRun(): RunMessage {
    const message = this.runs().at(-1);
    expect(message).toBeDefined();
    return message!;
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

function harness(idleTimeout = 120_000, guardTimeout = 5_000) {
  const workers: FakeWorker[] = [];
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const notifyChanged = vi.fn();
  const client = new ExplanationSyncWorkerClient(
    createWorker,
    notifyChanged,
    idleTimeout,
    guardTimeout,
  );
  clients.push(client);
  return { client, workers, createWorker, notifyChanged };
}
function start(
  client: ExplanationSyncWorkerClient,
  auth = authA,
  current?: () => boolean | Promise<boolean>,
) {
  const result = client.run(ownerFor(auth), auth, config, current);
  // Keep failures observed even when a failed assertion reaches cleanup early.
  void result.catch(() => undefined);
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
function succeed(worker: FakeWorker, legacy = 0, instructor = 0) {
  worker.emit({
    type: "result",
    id: worker.lastRun().id,
    counts: { legacy, instructor },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(syncExplanationLibrariesCore).mockResolvedValue({
    legacy: 99,
    instructor: 99,
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.cancel();
  cancelExplanationSyncWorker();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("explanation sync worker lifecycle", () => {
  it("returns count-only results and does not notify for unchanged content", async () => {
    const { client, workers, notifyChanged } = harness();
    const current = vi.fn(() => true);
    const result = start(client, authA, current);
    await flush();
    const worker = workers[0];
    expect(worker.sent).toEqual([
      { type: "run", id: 1, owner: ownerFor(authA), auth: authA, config },
    ]);
    succeed(worker, 7, 3);
    await expect(result).resolves.toEqual({ legacy: 7, instructor: 3 });
    expect(current).toHaveBeenCalledTimes(2);
    expect(notifyChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks current at each checkpoint and cancels when the current owner is invalid", async () => {
    const { client, workers, notifyChanged } = harness();
    const current = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const result = start(client, authA, current);
    const failure = expect(result).rejects.toThrow("계정이 바뀌어");
    await flush();
    const worker = workers[0],
      id = worker.lastRun().id;
    worker.emit({ type: "checkpoint", id, checkpoint: 11 });
    await flush();
    expect(worker.sent.at(-1)).toEqual({
      type: "current",
      id,
      checkpoint: 11,
      current: true,
    });
    worker.emit({ type: "checkpoint", id, checkpoint: 12 });
    await failure;
    expect(worker.sent.at(-1)).toEqual({
      type: "current",
      id,
      checkpoint: 12,
      current: false,
    });
    expect(current).toHaveBeenCalledTimes(3);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(notifyChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies once after actual committed changes on successful completion", async () => {
    const { client, workers, notifyChanged } = harness();
    const result = start(client);
    await flush();
    const worker = workers[0],
      id = worker.lastRun().id;
    worker.emit({ type: "changed", id });
    worker.emit({ type: "changed", id });
    expect(notifyChanged).not.toHaveBeenCalled();
    succeed(worker, 1, 2);
    await expect(result).resolves.toEqual({ legacy: 1, instructor: 2 });
    worker.emit({ type: "changed", id });
    succeed(worker, 1, 2);
    expect(notifyChanged).toHaveBeenCalledOnce();
  });

  it("still notifies once for an actual commit when the worker later fails", async () => {
    const { client, workers, notifyChanged } = harness();
    const current = vi.fn(() => true);
    const result = start(client, authA, current);
    const failure = expect(result).rejects.toThrow("실행하지 못했습니다");
    await flush();
    const worker = workers[0],
      id = worker.lastRun().id;
    worker.emit({ type: "changed", id });
    worker.fail("error");
    await failure;
    expect(current).toHaveBeenCalledTimes(2);
    expect(notifyChanged).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["error", "messageerror"] as const)(
    "rejects a browser worker %s without main-thread fallback and retries a new worker next time",
    async (eventType) => {
      const workers: FakeWorker[] = [];
      vi.stubGlobal(
        "Worker",
        class extends FakeWorker {
          constructor() {
            super();
            workers.push(this);
          }
        },
      );
      const result = syncExplanationLibraries(ownerFor(authA), authA, config);
      const failure = expect(result).rejects.toThrow("실행하지 못했습니다");
      await flush();
      expect(workers).toHaveLength(1);
      const event = workers[0].fail(eventType);
      await failure;
      expect(event.defaultPrevented).toBe(true);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(workers[0].listenerCount()).toBe(0);
      expect(syncExplanationLibrariesCore).not.toHaveBeenCalled();
      const retry = syncExplanationLibraries(ownerFor(authA), authA, config);
      void retry.catch(() => undefined);
      await flush();
      expect(workers).toHaveLength(2);
      succeed(workers[1], 2, 4);
      await expect(retry).resolves.toEqual({ legacy: 2, instructor: 4 });
      expect(syncExplanationLibrariesCore).not.toHaveBeenCalled();
    },
  );

  it("rejects active and queued old-owner jobs, releases guards, and cleans timers on explicit cancel", async () => {
    const { client, workers, notifyChanged } = harness();
    const oldGuard = deferred<boolean>();
    const oldCurrent = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValue(oldGuard.promise);
    const old = start(client, authA, oldCurrent);
    const oldFailure = expect(old).rejects.toThrow("계정이 바뀌어");
    await flush();
    const oldWorker = workers[0],
      id = oldWorker.lastRun().id;
    oldWorker.emit({ type: "changed", id });
    oldWorker.emit({ type: "checkpoint", id, checkpoint: 1 });
    const queued = start(client);
    const queuedFailure = expect(queued).rejects.toThrow("계정이 바뀌어");
    await flush();
    expect(vi.getTimerCount()).toBe(2);
    const nextGuard = deferred<boolean>();
    const nextCurrent = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValue(nextGuard.promise);
    const next = start(client, authB, nextCurrent);
    const nextFailure = expect(next).rejects.toThrow("explicit cancellation");
    await flush();
    await Promise.all([oldFailure, queuedFailure]);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(oldWorker.listenerCount()).toBe(0);
    expect(oldWorker.runs()).toHaveLength(1);
    expect(workers).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    const nextWorker = workers[1];
    nextWorker.emit({
      type: "checkpoint",
      id: nextWorker.lastRun().id,
      checkpoint: 2,
    });
    await flush();
    expect(vi.getTimerCount()).toBe(2);
    client.cancel(Error("explicit cancellation"));
    await nextFailure;
    await flush();
    expect(nextWorker.terminate).toHaveBeenCalledOnce();
    expect(nextWorker.listenerCount()).toBe(0);
    expect(notifyChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores late initial-guard false and rejection after a new owner has started", async () => {
    for (const outcome of ["false", "rejection"] as const) {
      const { client, workers } = harness();
      const oldGuard = deferred<boolean>();
      const old = start(client, authA, () => oldGuard.promise);
      const oldFailure = expect(old).rejects.toThrow("계정이 바뀌어");
      await flush();
      expect(workers).toHaveLength(0);
      const next = start(client, authB);
      await flush();
      await oldFailure;
      expect(workers).toHaveLength(1);
      if (outcome === "false") oldGuard.resolve(false);
      else oldGuard.reject(Error("late initial guard failure"));
      await flush();
      expect(workers[0].terminate).not.toHaveBeenCalled();
      expect(workers[0].lastRun().owner).toBe(ownerFor(authB));
      succeed(workers[0], 0, 1);
      await expect(next).resolves.toEqual({ legacy: 0, instructor: 1 });
      client.cancel();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a late checkpoint rejection cancel a new owner's worker", async () => {
    const { client, workers, notifyChanged } = harness();
    const checkpointGuard = deferred<boolean>();
    const current = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValue(checkpointGuard.promise);
    const old = start(client, authA, current);
    const oldFailure = expect(old).rejects.toThrow("계정이 바뀌어");
    await flush();
    const oldWorker = workers[0],
      id = oldWorker.lastRun().id;
    oldWorker.emit({ type: "changed", id });
    oldWorker.emit({ type: "checkpoint", id, checkpoint: 9 });
    await flush();
    checkpointGuard.reject(Error("late checkpoint failure"));
    const next = start(client, authB);
    await flush();
    await oldFailure;
    expect(workers).toHaveLength(2);
    expect(workers[1].terminate).not.toHaveBeenCalled();
    expect(
      oldWorker.sent.filter((message) => message.type === "current"),
    ).toHaveLength(0);
    expect(notifyChanged).not.toHaveBeenCalled();
    succeed(workers[1], 1, 0);
    await expect(next).resolves.toEqual({ legacy: 1, instructor: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes same-owner jobs on one worker and continues the queue after a job failure", async () => {
    const { client, workers, createWorker } = harness();
    const first = start(client),
      second = start(client),
      third = start(client);
    const secondFailure = expect(second).rejects.toThrow("second job failed");
    await flush();
    const worker = workers[0];
    expect(worker.runs()).toHaveLength(1);
    succeed(worker, 1, 0);
    await expect(first).resolves.toEqual({ legacy: 1, instructor: 0 });
    await flush();
    expect(worker.runs()).toHaveLength(2);
    worker.emit({
      type: "error",
      id: worker.lastRun().id,
      message: "second job failed",
    });
    await secondFailure;
    await flush();
    expect(worker.runs()).toHaveLength(3);
    succeed(worker, 0, 3);
    await expect(third).resolves.toEqual({ legacy: 0, instructor: 3 });
    expect(new Set(worker.runs().map((message) => message.id)).size).toBe(3);
    expect(createWorker).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed counts instead of accepting a worker's invalid success result", async () => {
    const { client, workers, notifyChanged } = harness();
    const result = start(client);
    const failure = expect(result).rejects.toThrow("결과 형식이 다릅니다");
    await flush();
    const worker = workers[0];
    worker.emit({
      type: "result",
      id: worker.lastRun().id,
      counts: { legacy: 0, instructor: -1 },
    });
    await failure;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listenerCount()).toBe(0);
    expect(notifyChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a progressing job beyond 60 seconds and only times out genuinely idle work", async () => {
    const { client, workers, notifyChanged } = harness(45_000);
    const result = start(client);
    const completed = vi.fn();
    void result.then(completed, completed);
    await flush();
    const worker = workers[0],
      id = worker.lastRun().id;
    for (let progress = 0; progress < 3; progress++) {
      await vi.advanceTimersByTimeAsync(40_000);
      expect(completed).not.toHaveBeenCalled();
      worker.emit({ type: "progress", id });
    }
    expect(worker.terminate).not.toHaveBeenCalled();
    succeed(worker, 1, 1);
    await expect(result).resolves.toEqual({ legacy: 1, instructor: 1 });
    const stalled = start(client);
    const failure = expect(stalled).rejects.toThrow("응답이 중단됐습니다");
    await flush();
    await vi.advanceTimersByTimeAsync(45_001);
    await failure;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(notifyChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
