import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudController } from "../src/original/sync/controller";
import {
  SyncAccountStore,
  accountStateKey,
  syncMetaKey,
  emptySyncLocal,
} from "../src/original/sync/local";
import { SupabaseTransport } from "../src/original/sync/transport";
import { initialOriginalState } from "../src/original/engine";
import { buildEvents } from "../src/original/sync/protocol";
import type { SyncEvent, WireEvent } from "../src/original/sync/types";
import { explanationSyncFixture } from "./fixtures/explanation-sync";
import * as storage from "../src/original/storage";
import { syncExplanationLibraries } from "../src/original/explanations/sync-runner";

vi.mock("../src/original/explanations/sync-runner", () => ({
  cancelExplanationSyncWorker: vi.fn(),
  syncExplanationLibraries: vi
    .fn()
    .mockResolvedValue({ legacy: 0, instructor: 0 }),
}));
const project = "https://controller-hot-path.test",
  uid = "11111111-1111-4111-8111-111111111111",
  owner = project + "|" + uid;
const resources: SyncAccountStore[] = [];
beforeEach(() => {
  vi.mocked(syncExplanationLibraries).mockResolvedValue({
    legacy: 0,
    instructor: 0,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(resources.splice(0).map((store) => store.close()));
});
async function setup() {
  const network = { onLine: true };
  vi.stubGlobal("navigator", network);
  const store = new SyncAccountStore(
    "controller-hot-path-" + crypto.randomUUID(),
  );
  resources.push(store);
  const state = initialOriginalState("real"),
    fixture = await explanationSyncFixture();
  state.data.questions = fixture.source.questions;
  state.data.assets = fixture.source.assets;
  await store.setValue(accountStateKey(owner), { generation: 7, state });
  await store.setValue(syncMetaKey(owner), emptySyncLocal());
  await store.setValue("sync:auth:" + project, {
    access_token: "TEST_ONLY_access",
    refresh_token: "TEST_ONLY_refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: uid },
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          events: [],
          cursor: 0,
          bankVersion: 0,
          serverTime: new Date().toISOString(),
        }),
        { status: 200 },
      ),
  );
  const transport = new SupabaseTransport(
    { url: project, key: "sb_publishable_TEST_ONLY" },
    fetcher,
  );
  const controller = new CloudController(store, transport, { kind: "none" });
  controller.setEnabled(false);
  await controller.init();
  return { store, state, controller, fetcher, transport, network };
}

async function queueMark(store: SyncAccountStore) {
  const before = await store.read(owner),
    next = structuredClone(before.state),
    questionId = next.data.questions[0].id;
  next.marks[questionId] = true;
  const built = buildEvents(before.state, next, {
    deviceId: before.meta.deviceId,
    nextSequence: before.meta.nextSequence,
    baseCursor: before.meta.cursor,
    bankVersion: before.meta.projection.bankVersion,
    order: before.meta.projection.order,
    markVersions: before.meta.projection.markVersions,
    pendingEvents: before.meta.outbox,
    clock: before.meta.clock,
  });
  const event = built.events.find((event) => event.kind === "mark");
  if (!event) throw Error("Expected an actual queued mark change");
  const saved = await store.write(
    owner,
    {
      ...before,
      state: next,
      meta: {
        ...before.meta,
        nextSequence: built.nextSequence,
        projection: { ...before.meta.projection, order: built.order },
        outbox: [...before.meta.outbox, ...built.events],
      },
    },
    before.generation,
  );
  return { saved, event };
}
function markWire(event: Extract<SyncEvent, { kind: "mark" }>): WireEvent {
  return {
    protocolVersion: 1,
    eventId: event.eventId,
    deviceId: event.deviceId,
    deviceSequence: event.deviceSequence,
    baseCursor: event.baseCursor,
    createdAt: event.createdAt,
    kind: "mark",
    bodyPath: "TEST_ONLY_mark_body",
    bodySha256: "0".repeat(64),
    bodyBytes: 1,
    baseVersion: null,
    markQuestionId: event.payload.questionId,
    baseMarkVersion: event.payload.baseMarkVersion,
  };
}

describe("proven metadata-only original sync work", () => {
  it("preserves a queued mark when the connection drops while awaiting a pull", async () => {
    const { store, controller, transport, network } = await setup();
    const { saved, event } = await queueMark(store);
    const pull = transport.pull.bind(transport);
    vi.spyOn(transport, "pull").mockImplementationOnce(async (...args) => {
      const received = await pull(...args);
      network.onLine = false;
      return received;
    });
    const upload = vi
      .spyOn(transport, "upload")
      .mockResolvedValue(markWire(event));
    const push = vi.spyOn(transport, "push").mockResolvedValue({
      seq: 1,
      bankVersion: 0,
      markVersion: 1,
      duplicate: false,
      serverTime: new Date().toISOString(),
    });
    controller.setEnabled(true);
    try {
      await controller.sync();
    } finally {
      controller.setEnabled(false);
    }
    expect(upload).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    const after = await store.read(owner);
    expect(after.state).toEqual(saved.state);
    expect(after.generation).toBe(saved.generation);
    expect(after.meta.outbox).toEqual(saved.meta.outbox);
    expect(after.meta.failures).toEqual(saved.meta.failures);
    expect(after.meta.lastSuccess).toBe(saved.meta.lastSuccess);
  });

  it("does not push or acknowledge an upload after going offline and retries the same queued mark online", async () => {
    const { store, controller, transport, network } = await setup();
    const { saved, event } = await queueMark(store),
      wire = markWire(event);
    const upload = vi
      .spyOn(transport, "upload")
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        network.onLine = false;
        return wire;
      })
      .mockResolvedValue(wire);
    const push = vi.spyOn(transport, "push").mockResolvedValue({
      seq: 1,
      bankVersion: 0,
      markVersion: 1,
      duplicate: false,
      serverTime: new Date().toISOString(),
    });
    controller.setEnabled(true);
    try {
      await controller.sync();
    } finally {
      controller.setEnabled(false);
    }
    expect(upload, controller.snapshot().error).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    const interrupted = await store.read(owner);
    expect(interrupted.state).toEqual(saved.state);
    expect(interrupted.generation).toBe(saved.generation);
    expect(interrupted.meta.outbox).toEqual([event]);
    expect(interrupted.meta.failures).toEqual({});
    expect(interrupted.meta.lastSuccess).toBe(saved.meta.lastSuccess);

    network.onLine = true;
    controller.setEnabled(true);
    try {
      await controller.sync();
    } finally {
      controller.setEnabled(false);
    }
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map(([queued]) => queued.eventId)).toEqual([
      event.eventId,
      event.eventId,
    ]);
    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0][0]).toEqual(wire);
    const retried = await store.read(owner);
    expect(retried.state).toEqual(saved.state);
    expect(retried.generation).toBe(saved.generation);
    expect(retried.meta.outbox).toEqual([]);
    expect(retried.meta.failures).toEqual({});
    expect(retried.meta.lastSuccess).toBeTruthy();
  });
  it("validates a cold generation once, polls normally, and does not rewrite study data for unchanged sync metadata", async () => {
    const { store, controller, state, fetcher } = await setup();
    const validate = vi.spyOn(storage, "validateOriginalState");
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    const conflicts = controller.snapshot().conflictIds;
    controller.setEnabled(true);
    await controller.sync();
    controller.setEnabled(false);
    expect(controller.snapshot().error).toBe("");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(
      put.mock.calls.filter(([, key]) => key === accountStateKey(owner)),
    ).toHaveLength(0);
    const first = await store.read(owner);
    expect(first.generation).toBe(7);
    expect(first.state).toEqual(state);
    expect(first.meta.lastSuccess).toBeTruthy();
    expect(controller.snapshot().conflictIds).toBe(conflicts);
    validate.mockClear();
    controller.setEnabled(true);
    await controller.sync();
    controller.setEnabled(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(validate).not.toHaveBeenCalled();
    expect((await store.read(owner)).state).toEqual(state);
  });
  it("does not reuse validation when another existing writer changes the durable generation", async () => {
    const { store, controller } = await setup();
    await (controller as any).apply(owner, []);
    const saved = await store.read(owner),
      questionId = saved.state.data.questions[0].id;
    saved.state.marks[questionId] = true;
    await store.write(owner, saved, saved.generation);
    const validate = vi.spyOn(storage, "validateOriginalState");
    await (controller as any).apply(owner, []);
    expect(validate).toHaveBeenCalledTimes(1);
    expect((await store.read(owner)).state.marks[questionId]).toBe(true);
  });
  it("fully validates and writes actual newly received state even after an unchanged generation was verified", async () => {
    const { store, controller } = await setup();
    await (controller as any).apply(owner, []);
    const before = await store.read(owner),
      draft = structuredClone(before.state),
      questionId = draft.data.questions[0].id;
    draft.marks[questionId] = true;
    const built = buildEvents(before.state, draft, {
      deviceId: crypto.randomUUID(),
      nextSequence: 1,
      baseCursor: 0,
      bankVersion: 0,
      order: {},
      markVersions: {},
      pendingEvents: [],
      clock: null,
    });
    const event = built.events.find((e) => e.kind === "mark")!;
    const validate = vi.spyOn(storage, "validateOriginalState"),
      put = vi.spyOn(IDBObjectStore.prototype, "put");
    await (controller as any).apply(
      owner,
      [{ seq: 1, bankVersion: 0, markVersion: 1, event }],
      1,
    );
    expect(validate).toHaveBeenCalledTimes(1);
    expect(
      put.mock.calls.filter(([, key]) => key === accountStateKey(owner)),
    ).toHaveLength(1);
    const after = await store.read(owner);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.state.marks[questionId]).toBe(true);
    expect(after.meta.cursor).toBe(1);
  });
  it("retries metadata CAS after a concurrent study write without overwriting the newer answers or marks", async () => {
    const { store, controller } = await setup();
    const writeMetadata = store.writeMetadata.bind(store),
      questionId = (await store.read(owner)).state.data.questions[0].id;
    vi.spyOn(store, "writeMetadata").mockImplementationOnce(
      async (id, meta, generation, revision) => {
        const concurrent = await store.read(owner);
        concurrent.state.marks[questionId] = true;
        await store.write(owner, concurrent, concurrent.generation);
        return writeMetadata(id, meta, generation, revision);
      },
    );
    await (controller as any).apply(owner, [], 4);
    const after = await store.read(owner);
    expect(after.generation).toBe(8);
    expect(after.state.marks[questionId]).toBe(true);
    expect(after.meta.cursor).toBe(4);
  });
});
