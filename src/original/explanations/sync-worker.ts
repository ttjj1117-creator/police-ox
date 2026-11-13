import { syncExplanationLibrariesCore } from "./sync-runner-core";
import { ExplanationSyncRepository } from "./sync";
import { ExplanationCloudTransport } from "./sync-transport";
import type {
  ExplanationWorkerRequest,
  ExplanationWorkerResponse,
} from "./sync-worker-client";

const scope = globalThis as unknown as {
  postMessage(message: ExplanationWorkerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ExplanationWorkerRequest>) => void,
  ): void;
};
let active: number | null = null;
let checkpointSequence = 0;
const checkpoints = new Map<
  number,
  {
    id: number;
    resolve: (value: boolean) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const repository = new ExplanationSyncRepository(undefined, undefined, () => {
  if (active !== null) scope.postMessage({ type: "changed", id: active });
});
const current = (id: number): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const checkpoint = ++checkpointSequence;
    const timer = setTimeout(() => {
      checkpoints.delete(checkpoint);
      reject(
        Error("해설 동기화 계정 확인 응답이 지연됐습니다. 다시 시도하세요."),
      );
    }, 60_000);
    checkpoints.set(checkpoint, { id, resolve, reject, timer });
    scope.postMessage({ type: "checkpoint", id, checkpoint });
  });
const guard = async (id: number) => {
  if (!(await current(id)))
    throw Error("계정이 바뀌어 해설 동기화를 중단했습니다.");
};
/** Bound one existing small HTTP request/body, never the total file or job.
 * A failed request leaves immutable chunks and local originals available for retry. */
function fetcher(id: number): typeof fetch {
  return async (input, init) => {
    await guard(id);
    scope.postMessage({ type: "progress", id });
    const controller = new AbortController();
    const abort = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });
      const bytes = await response.arrayBuffer();
      await guard(id);
      scope.postMessage({ type: "progress", id });
      return new Response(
        [204, 205, 304].includes(response.status) ? null : bytes,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    } finally {
      clearTimeout(timeout);
      init?.signal?.removeEventListener("abort", abort);
    }
  };
}
async function run(
  message: Extract<ExplanationWorkerRequest, { type: "run" }>,
) {
  active = message.id;
  try {
    const counts = await syncExplanationLibrariesCore(
      message.owner,
      message.auth,
      message.config,
      {
        repository,
        transport: new ExplanationCloudTransport(
          message.config,
          fetcher(message.id),
        ),
        current: () => current(message.id),
        shared: message.shared,
        sharedFetch: fetcher(message.id),
      },
    );
    scope.postMessage({ type: "result", id: message.id, counts });
  } catch (reason) {
    scope.postMessage({
      type: "error",
      id: message.id,
      message:
        reason instanceof Error
          ? reason.message
          : "해설 동기화에 실패했습니다.",
    });
  } finally {
    active = null;
    for (const [key, pending] of checkpoints)
      if (pending.id === message.id) {
        clearTimeout(pending.timer);
        checkpoints.delete(key);
        pending.resolve(false);
      }
  }
}
let queue: Promise<void> = Promise.resolve();
scope.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || !Number.isSafeInteger(message.id)) return;
  if (message.type === "current") {
    const pending = checkpoints.get(message.checkpoint);
    if (!pending || pending.id !== message.id) return;
    checkpoints.delete(message.checkpoint);
    clearTimeout(pending.timer);
    pending.resolve(message.current === true);
  } else if (message.type === "run")
    queue = queue.catch(() => undefined).then(() => run(message));
});
