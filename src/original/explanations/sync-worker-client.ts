import type { AuthSession, CloudConfig } from "../sync/transport";
import type { ExplanationSyncCounts } from "./sync-runner-core";
import { notifyExplanationChange } from "./sync";

export type ExplanationWorkerRequest =
  | {
      type: "run";
      id: number;
      owner: string;
      auth: AuthSession;
      config: CloudConfig;
    }
  | { type: "current"; id: number; checkpoint: number; current: boolean };
export type ExplanationWorkerResponse =
  | { type: "checkpoint"; id: number; checkpoint: number }
  | { type: "changed" | "progress"; id: number }
  | { type: "result"; id: number; counts: ExplanationSyncCounts }
  | { type: "error"; id: number; message: string };
type Listener = (event: Event) => void;
export interface ExplanationWorkerPort {
  postMessage(message: ExplanationWorkerRequest): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: Listener,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: Listener,
  ): void;
  terminate(): void;
}
interface Pending {
  id: number;
  owner: string;
  epoch: number;
  current?: () => boolean | Promise<boolean>;
  resolve: (value: ExplanationSyncCounts) => void;
  reject: (error: Error) => void;
  changed: boolean;
  finishing: boolean;
  guards: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}
const scopeError = () => Error("계정이 바뀌어 해설 동기화를 중단했습니다.");
const asError = (value: unknown, fallback: string) =>
  value instanceof Error ? value : Error(fallback);

/** One persistent worker per active owner. Only small credentials/config/counts
 * cross the channel; the worker itself reads private IDB and transfers chunks. */
export class ExplanationSyncWorkerClient {
  private worker: ExplanationWorkerPort | null = null;
  private detach: (() => void) | null = null;
  private owner: string | null = null;
  private epoch = 0;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly createWorker: () => ExplanationWorkerPort = () =>
      new Worker(new URL("./sync-worker.ts", import.meta.url), {
        type: "module",
      }),
    private readonly notifyChanged: () => void = () =>
      notifyExplanationChange(false),
    private readonly idleTimeout = 10 * 60_000,
    private readonly guardTimeout = 60_000,
  ) {}
  private live(job: Pending): boolean {
    return (
      this.pending.get(job.id) === job &&
      job.epoch === this.epoch &&
      job.owner === this.owner
    );
  }
  private async isCurrent(job: Pending): Promise<boolean> {
    if (!this.live(job)) return false;
    if (!job.current) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(job.current),
        new Promise<boolean>((resolve) => {
          cancel = () => resolve(false);
          job.guards.add(cancel);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "해설 동기화 계정 확인 응답이 지연됐습니다. 다시 시도하세요.",
                ),
              ),
            this.guardTimeout,
          );
        }),
      ]);
      return this.live(job) && result === true;
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) job.guards.delete(cancel);
    }
  }
  private touch(job: Pending): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (this.live(job) && !job.finishing)
        this.breakWorker(
          Error("해설 동기화 작업의 응답이 중단됐습니다. 다시 시도하세요."),
        );
    }, this.idleTimeout);
  }
  private dropWorker(): void {
    this.detach?.();
    this.detach = null;
    this.worker?.terminate();
    this.worker = null;
  }
  /** Owner/area lifecycle cancellation never relays an old owner's notification. */
  cancel(error: Error = scopeError()): void {
    this.epoch++;
    this.owner = null;
    this.dropWorker();
    this.tail = Promise.resolve();
    for (const job of this.pending.values()) {
      if (job.timer) clearTimeout(job.timer);
      for (const cancel of job.guards) cancel();
      job.reject(error);
    }
    this.pending.clear();
  }
  private settle(
    job: Pending,
    counts?: ExplanationSyncCounts,
    error?: Error,
  ): void {
    if (!this.live(job) || job.finishing) return;
    job.finishing = true;
    if (job.timer) clearTimeout(job.timer);
    for (const cancel of job.guards) cancel();
    if (error && !job.changed) {
      this.pending.delete(job.id);
      job.reject(error);
      return;
    }
    void (async () => {
      let failure = error;
      try {
        if (!(await this.isCurrent(job))) failure = scopeError();
        else if (job.changed) this.notifyChanged();
      } catch (reason) {
        failure ??= asError(reason, "해설 동기화 계정 확인에 실패했습니다.");
      }
      if (!this.live(job)) return;
      this.pending.delete(job.id);
      if (failure) job.reject(failure);
      else if (counts) job.resolve(counts);
      else job.reject(Error("해설 동기화 결과 형식이 다릅니다."));
    })();
  }
  private breakWorker(error: Error): void {
    // Preserve a real content commit's notification even if a later request
    // fails. Lifecycle cancel increments the epoch and suppresses it instead.
    this.dropWorker();
    for (const job of [...this.pending.values()])
      this.settle(job, undefined, error);
  }
  private workerFor(job: Pending): ExplanationWorkerPort {
    if (this.worker) return this.worker;
    const worker = this.createWorker(),
      epoch = this.epoch;
    const onMessage: Listener = (event) => {
      if (this.worker !== worker || this.epoch !== epoch) return;
      const data = (event as MessageEvent<ExplanationWorkerResponse>).data;
      if (!data || !Number.isSafeInteger(data.id)) {
        this.breakWorker(Error("해설 동기화 작업 응답 형식이 다릅니다."));
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending || !this.live(pending) || pending.finishing) return;
      this.touch(pending);
      if (data.type === "checkpoint") {
        if (!Number.isSafeInteger(data.checkpoint)) {
          this.breakWorker(Error("해설 동기화 확인 요청 형식이 다릅니다."));
          return;
        }
        void this.isCurrent(pending)
          .then((current) => {
            if (
              !this.live(pending) ||
              pending.finishing ||
              this.worker !== worker
            )
              return;
            worker.postMessage({
              type: "current",
              id: pending.id,
              checkpoint: data.checkpoint,
              current,
            });
            if (!current) this.cancel(scopeError());
          })
          .catch((reason) => {
            if (
              this.live(pending) &&
              this.worker === worker &&
              this.epoch === epoch
            )
              this.cancel(
                asError(reason, "해설 동기화 계정 확인에 실패했습니다."),
              );
          });
      } else if (data.type === "changed") pending.changed = true;
      else if (data.type === "progress") {
        /* Activity already refreshed the idle watchdog. */
      } else if (data.type === "result") {
        if (
          !data.counts ||
          !Number.isSafeInteger(data.counts.legacy) ||
          data.counts.legacy < 0 ||
          !Number.isSafeInteger(data.counts.instructor) ||
          data.counts.instructor < 0
        ) {
          this.breakWorker(Error("해설 동기화 결과 형식이 다릅니다."));
          return;
        }
        this.settle(pending, data.counts);
      } else if (data.type === "error")
        this.settle(
          pending,
          undefined,
          Error(
            typeof data.message === "string"
              ? data.message
              : "해설 동기화에 실패했습니다.",
          ),
        );
      else this.breakWorker(Error("해설 동기화 작업 응답 형식이 다릅니다."));
    };
    const onError: Listener = (event) => {
      event.preventDefault();
      if (this.worker === worker && this.epoch === epoch)
        this.breakWorker(
          Error("해설 동기화 작업을 실행하지 못했습니다. 다시 시도하세요."),
        );
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onError);
    this.worker = worker;
    this.detach = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onError);
    };
    this.touch(job);
    return worker;
  }
  run(
    owner: string,
    auth: AuthSession,
    config: CloudConfig,
    current?: () => boolean | Promise<boolean>,
  ): Promise<ExplanationSyncCounts> {
    if (owner !== `${config.url}|${auth.user.id}`)
      return Promise.reject(Error("해설 동기화 계정이 다릅니다."));
    if (this.owner !== null && this.owner !== owner) this.cancel();
    this.owner = owner;
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const work = new Promise<ExplanationSyncCounts>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job: Pending = {
      id: ++this.sequence,
      owner,
      epoch: this.epoch,
      current,
      resolve,
      reject,
      changed: false,
      finishing: false,
      guards: new Set(),
    };
    this.pending.set(job.id, job);
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.live(job)) return;
        try {
          const current = await this.isCurrent(job);
          if (!this.live(job)) return;
          if (!current) {
            this.cancel();
            return;
          }
          const worker = this.workerFor(job);
          this.touch(job);
          worker.postMessage({ type: "run", id: job.id, owner, auth, config });
        } catch (reason) {
          this.settle(
            job,
            undefined,
            asError(reason, "해설 동기화 작업을 시작하지 못했습니다."),
          );
        }
        await work.catch(() => undefined);
      });
    return work;
  }
}

let client: ExplanationSyncWorkerClient | undefined;
export function runExplanationSyncWorker(
  owner: string,
  auth: AuthSession,
  config: CloudConfig,
  current?: () => boolean | Promise<boolean>,
) {
  return (client ??= new ExplanationSyncWorkerClient()).run(
    owner,
    auth,
    config,
    current,
  );
}
export function cancelExplanationSyncWorker(): void {
  client?.cancel();
}
