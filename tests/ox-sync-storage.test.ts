import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository, ConflictError } from "../src/data/repository";
import { backup } from "../src/data/transfer";
import { defaultSelection, canonical, type State } from "../src/domain/schema";
import { latest, next, startSession, submit } from "../src/domain/engine";
import { initialState } from "../src/fixtures/data";
import { OxController, type SharedAuth } from "../src/ox-sync/controller";
import { OxSyncStore, oxStateKey, oxMetaKey } from "../src/ox-sync/store";
import { OxTransport } from "../src/ox-sync/transport";
import { stampClock } from "../src/original/sync/clock";
import { CloudError, type AuthSession } from "../src/original/sync/transport";
import { keyOf } from "../src/ox-sync/protocol";
import type { ReceivedEvent, SyncEvent, WireEvent } from "../src/ox-sync/types";
const config = { url: "https://sync-test.supabase.co", key: "public-test" };
const auth: AuthSession = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_at: 9999999999,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
  },
};
const owner = config.url + "|" + auth.user.id,
  other = config.url + "|22222222-2222-4222-8222-222222222222";
class Shared implements SharedAuth {
  view = {
    ready: true,
    ownerId: owner,
    auth: auth as AuthSession | null,
    config,
  };
  listeners = new Set<() => void>();
  async init() {}
  snapshot = () => this.view;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  async getAuth() {
    if (!this.view.auth) throw new Error("login required");
    return this.view.auth;
  }
  setOwner(id: string | null) {
    this.view = {
      ...this.view,
      ownerId: id,
      auth: id
        ? { ...auth, user: { ...auth.user, id: id.split("|")[1] } }
        : null,
    };
    this.listeners.forEach((fn) => fn());
  }
}
class Server {
  records: ReceivedEvent[] = [];
  events = new Map<string, SyncEvent>();
  versions: Record<string, number> = {};
  bankVersion = 0;
  calls = 0;
  loseAck = false;
}
class MockTransport extends OxTransport {
  constructor(readonly server: Server) {
    super(config);
  }
  override async upload(event: SyncEvent): Promise<WireEvent> {
    this.server.calls++;
    this.server.events.set(event.eventId, structuredClone(event));
    return {
      protocolVersion: 1,
      eventId: event.eventId,
      deviceId: event.deviceId,
      deviceSequence: event.deviceSequence,
      baseCursor: event.baseCursor,
      createdAt: event.createdAt,
      kind: event.kind,
      bodyPath: `${auth.user.id}/ox/test/${event.eventId}`,
      bodySha256: "a".repeat(64),
      bodyBytes: 1,
      baseVersion: event.kind === "bank" ? event.payload.baseVersion : null,
      markQuestionId: event.kind === "mark" ? event.payload.questionId : null,
      baseMarkVersion:
        event.kind === "mark" ? event.payload.baseMarkVersion : null,
    };
  }
  override async push(wire: WireEvent) {
    this.server.calls++;
    const old = this.server.records.find(
      (r) => r.event.eventId === wire.eventId,
    );
    if (old) return { seq: old.seq, duplicate: true };
    const event = this.server.events.get(wire.eventId)!;
    if (
      (event.kind === "bank" &&
        event.payload.baseVersion !== this.server.bankVersion) ||
      (event.kind === "mark" &&
        event.payload.baseMarkVersion !==
          (this.server.versions[event.payload.questionId] ?? 0))
    )
      throw new CloudError("version_conflict", 409, "version_conflict");
    if (event.kind === "bank") this.server.bankVersion++;
    const markVersion =
      event.kind === "mark"
        ? (this.server.versions[event.payload.questionId] =
            (this.server.versions[event.payload.questionId] ?? 0) + 1)
        : undefined;
    const seq = this.server.records.length + 1;
    this.server.records.push({
      event: structuredClone(event),
      seq,
      bankVersion: this.server.bankVersion,
      ...(markVersion ? { markVersion } : {}),
    });
    if (this.server.loseAck) {
      this.server.loseAck = false;
      throw new CloudError("response lost");
    }
    return { seq, duplicate: false };
  }
  override async pull(cursor: number) {
    this.server.calls++;
    const events = structuredClone(
      this.server.records.filter((e) => e.seq > cursor).slice(0, 50),
    );
    return {
      events,
      cursor: events.at(-1)?.seq ?? cursor,
      clock: stampClock(0, 1000),
    };
  }
}
const resources: { close(): Promise<void> }[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(async () => {
  await Promise.all(resources.splice(0).map((r) => r.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function bank() {
  const s = initialState(true);
  s.dataset.datasetId = "police-personal";
  return s;
}
function closed() {
  const s = bank();
  startSession(s, defaultSelection, [s.dataset.items[0]]);
  submit(s, s.sessions[0].id, "O");
  next(s, s.sessions[0].id);
  s.settings.fontScale = 1.5;
  return s;
}
async function setup(
  server = new Server(),
  name = `ox-sync-${crypto.randomUUID()}`,
  shared = new Shared(),
) {
  const store = new OxSyncStore(name),
    legacy = new Repository(name),
    controller = new OxController(
      store,
      shared,
      legacy,
      new MockTransport(server),
    );
  resources.push(controller);
  await controller.init();
  return { name, store, legacy, controller, server, shared };
}
describe("OX durable account store and controller", () => {
  it("finishes anonymous initialization with a local-storage message", async () => {
    const shared = new Shared();
    shared.setOwner(null);
    const { controller } = await setup(new Server(), undefined, shared);
    expect(controller.snapshot()).toMatchObject({
      ready: true,
      ownerId: null,
      message: "OX 기록은 이 기기에 보관됩니다. 원문 학습과 같은 계정으로 로그인하세요.",
    });
  });
  it("keeps owner A, owner B, legacy real and demo separate", async () => {
    const { store, legacy } = await setup();
    await legacy.save("real", closed(), 0);
    await legacy.save("demo", initialState(true), 0);
    await store.save(owner, bank(), 0);
    expect((await store.read(other)).state.dataset.items).toHaveLength(0);
    expect((await store.readLegacy()).sessions).toHaveLength(1);
    expect((await legacy.load("demo")).state.dataset.items).toHaveLength(7);
    expect((await store.read(owner)).meta.outbox).toHaveLength(1);
    expect(await store.getValue("ox-sync:real:user:demo")).toBeNull();
  });
  it("saves state and its outbox atomically, rolling both back on metadata failure", async () => {
    const { store } = await setup(),
      put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (key === oxMetaKey(owner))
          throw new DOMException("quota exhausted", "QuotaExceededError");
        return put.call(this, value, key);
      });
    await expect(store.save(owner, bank(), 0)).rejects.toThrow("quota");
    spy.mockRestore();
    expect(await store.getValue(oxStateKey(owner))).toBeNull();
    expect(await store.getValue(oxMetaKey(owner))).toBeNull();
  });
  it("rolls controller state back if the second transactional metadata put fails", async () => {
    const { store } = await setup();
    await store.save(owner, bank(), 0);
    const before = await store.read(owner),
      next = structuredClone(before);
    next.meta.cursor = 10;
    next.state.settings.fontScale = 1.5;
    const put = IDBObjectStore.prototype.put,
      spy = vi
        .spyOn(IDBObjectStore.prototype, "put")
        .mockImplementation(function (
          this: IDBObjectStore,
          value: unknown,
          key?: IDBValidKey,
        ) {
          if (key === oxMetaKey(owner)) throw new Error("second write failure");
          return put.call(this, value, key);
        });
    await expect(store.write(owner, next, before.generation)).rejects.toThrow(
      "second write",
    );
    spy.mockRestore();
    expect(await store.read(owner)).toEqual(before);
  });
  it("rejects stale UI generations as ConflictError", async () => {
    const { store } = await setup();
    await store.save(owner, bank(), 0);
    await expect(store.save(owner, bank(), 0)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await store.read(owner)).meta.outbox).toHaveLength(1);
  });
  it("retains original IDs and outbox across store close/reopen", async () => {
    const name = `reopen-${crypto.randomUUID()}`,
      s = new OxSyncStore(name);
    await s.save(owner, closed(), 0);
    const before = await s.read(owner);
    await s.close();
    const reopened = new OxSyncStore(name);
    resources.push(reopened);
    const after = await reopened.read(owner);
    expect(after.meta.outbox.map((e) => e.eventId)).toEqual(
      before.meta.outbox.map((e) => e.eventId),
    );
    expect(after.state.attempts).toEqual(before.state.attempts);
  });
  it("saves offline and transfers completed snapshots to a second independent store after reconnect", async () => {
    const server = new Server(),
      a = await setup(server),
      b = await setup(server);
    vi.stubGlobal("navigator", { onLine: false });
    await a.controller.save("real", closed(), 0);
    await a.controller.sync();
    expect(server.records).toHaveLength(0);
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(2);
    vi.stubGlobal("navigator", { onLine: true });
    await a.controller.sync();
    await b.controller.sync();
    const copied = await b.controller.load("real");
    expect(copied.state.attempts).toEqual(
      (await a.controller.load("real")).state.attempts,
    );
    expect(copied.state.sessions[0].items).toEqual(
      (await a.controller.load("real")).state.sessions[0].items,
    );
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(0);
    expect(server.records).toHaveLength(2);
  });
  it("retries the same event ID after a lost response without duplicating records", async () => {
    const a = await setup();
    await a.controller.save("real", closed(), 0);
    const ids = (await a.store.read(owner)).meta.outbox.map((e) => e.eventId);
    a.server.loseAck = true;
    await a.controller.sync();
    expect(a.controller.snapshot().error).toContain("response lost");
    expect((await a.store.read(owner)).meta.outbox[0].eventId).toBe(ids[0]);
    await a.controller.sync();
    expect(a.server.records.map((e) => e.event.eventId)).toEqual(ids);
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(0);
    expect((await a.store.read(owner)).state.attempts).toHaveLength(1);
  });
  it("migrates existing data idempotently while leaving the legacy source untouched", async () => {
    const a = await setup(),
      source = closed();
    await a.legacy.save("real", source, 0);
    const preview = await a.controller.previewLegacy();
    expect(preview).toMatchObject({
      items: 7,
      sessions: 1,
      attempts: 1,
      conflicts: 0,
    });
    await a.controller.connectExisting(preview.state, preview.source);
    const first = await a.store.read(owner);
    await a.controller.connectExisting(preview.state, preview.source);
    const second = await a.store.read(owner);
    expect(second.meta.outbox.map((e) => e.eventId)).toEqual(
      first.meta.outbox.map((e) => e.eventId),
    );
    expect(second.state.attempts).toEqual(source.attempts);
    expect(second.state.settings.fontScale).toBe(1.5);
    expect((await a.store.readLegacy()).sessions[0].cycleKey).toBe(
      source.sessions[0].cycleKey,
    );
    expect(second.state.sessions[0].cycleKey).toBeNull();
    expect(
      await a.store.getValue<unknown[]>(`ox-sync:migration-source:${owner}`),
    ).toHaveLength(1);
  });
  it("accepts native and integrated real OX backups and rejects demo", async () => {
    const a = await setup(),
      source = closed();
    expect(
      (await a.controller.importPreview(backup(source, "real"))).items,
    ).toBe(7);
    expect(
      (
        await a.controller.importPreview({
          format: "police-learning-backup",
          namespace: "real",
          ox: backup(source, "real"),
        })
      ).attempts,
    ).toBe(1);
    await expect(
      a.controller.importPreview(backup(source, "demo")),
    ).rejects.toThrow("실제/시연");
  });
  it("keeps both same-revision bank originals and imports safe historical records", async () => {
    const a = await setup(),
      source = closed();
    await a.controller.save("real", bank(), 0);
    source.dataset.items[0].displayText += " conflicting text";
    source.sessions[0].items[0].displayText += " conflicting text";
    const p = await a.controller.importPreview(backup(source, "real"));
    expect(p.conflicts).toBe(1);
    await a.controller.connectExisting(p.state, p.source);
    const stored = await a.store.read(owner);
    expect(stored.state.dataset.items[0].displayText).toBe(
      bank().dataset.items[0].displayText,
    );
    expect(stored.state.sessions[0].items[0].displayText).toContain(
      "conflicting text",
    );
    expect(stored.meta.projection.conflicts[0].event?.kind).toBe("bank");
    expect(await a.controller.exportRecovery()).toHaveProperty("source");
  });
  it("does not treat an old imported response as newer than a live response", async () => {
    const a = await setup(),
      live = closed(),
      old = closed();
    old.attempts[0].answeredAt = "2000-01-01T00:00:00.000Z";
    await a.controller.save("real", live, 0);
    const p = await a.controller.importPreview(backup(old, "real"));
    await a.controller.connectExisting(p.state, p.source);
    const state = (await a.controller.load("real")).state;
    expect(state.attempts).toHaveLength(2);
    expect(latest(state, state.dataset.items[0], "current")).toBeUndefined();
    expect(
      a.controller.snapshot().conflicts.some((c) => c.kind === "order"),
    ).toBe(true);
  });
  it("holds an active legacy upgrade session in its original namespace until explicit migration", async () => {
    const name = `lease-${crypto.randomUUID()}`,
      legacy = new Repository(name),
      active = bank();
    startSession(active, defaultSelection, [active.dataset.items[0]]);
    submit(active, active.sessions[0].id, "O");
    await legacy.save("real", active, 0);
    await legacy.close();
    const a = await setup(new Server(), name);
    expect(a.controller.snapshot().legacyMode).toBe(true);
    let local = await a.controller.load("real");
    expect(local.state.sessions[0].status).toBe("active");
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(0);
    next(local.state, local.state.sessions[0].id);
    local = await a.controller.save("real", local.state, local.generation);
    expect(a.controller.snapshot().legacyMode).toBe(true);
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(0);
    const preview = await a.controller.previewLegacy();
    await a.controller.connectExisting(preview.state, preview.source);
    expect(a.controller.snapshot().legacyMode).toBe(false);
    expect((await a.controller.load("real")).state.attempts).toHaveLength(1);
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(2);
  });
  it("makes corrupt legacy data a recoverable error without deleting it", async () => {
    const name = `bad-${crypto.randomUUID()}`,
      store = new OxSyncStore(name);
    await store.setValue("real", { generation: 3, state: { broken: true } });
    await store.close();
    const a = await setup(new Server(), name);
    expect(a.controller.snapshot().ready).toBe(true);
    expect(a.controller.snapshot().error).not.toBe("");
    expect(await a.store.getValue("real")).toEqual({
      generation: 3,
      state: { broken: true },
    });
  });
  it("quarantines concurrent mark versions, then explicitly retries local false", async () => {
    const server = new Server(),
      a = await setup(server),
      b = await setup(server),
      key = keyOf(bank().dataset.items[0].id, "current");
    const state = bank();
    state.marks[key] = true;
    await a.controller.save("real", state, 0);
    await a.controller.sync();
    await b.controller.sync();
    let sa = await a.controller.load("real"),
      sb = await b.controller.load("real");
    sa.state.marks[key] = false;
    sb.state.marks[key] = false;
    await a.controller.save("real", sa.state, sa.generation);
    await b.controller.save("real", sb.state, sb.generation);
    await a.controller.sync();
    await b.controller.sync();
    let meta = (await b.store.read(owner)).meta;
    expect(Object.keys(meta.failures)).toHaveLength(1);
    const failed = Object.keys(meta.failures)[0];
    await b.controller.retryVersionConflict(failed);
    await b.controller.sync();
    meta = (await b.store.read(owner)).meta;
    expect(meta.outbox).toHaveLength(0);
    expect((await b.controller.load("real")).state.marks[key]).toBe(false);
  });
  it("keeps a rejected bank plus current remote data when CAS versions differ", async () => {
    const server = new Server(),
      a = await setup(server),
      b = await setup(server);
    await a.controller.save("real", bank(), 0);
    await a.controller.sync();
    await b.controller.sync();
    const sa = await a.controller.load("real"),
      sb = await b.controller.load("real");
    sa.state.dataset.items[0].revision++;
    sa.state.dataset.items[0].tags.push("pc edit");
    sb.state.dataset.items[1].revision++;
    sb.state.dataset.items[1].tags.push("tab edit");
    await a.controller.save("real", sa.state, sa.generation);
    await b.controller.save("real", sb.state, sb.generation);
    await a.controller.sync();
    await b.controller.sync();
    const meta = (await b.store.read(owner)).meta;
    expect(Object.keys(meta.failures)).toHaveLength(1);
    expect(meta.outbox[0].payload).toHaveProperty("dataset");
    expect(meta.projection.conflicts.some((c) => c.kind === "bank")).toBe(true);
  });
  it("never revives an offline local deletion from an unrelated concurrent remote bank", async () => {
    const server = new Server(),
      a = await setup(server),
      b = await setup(server);
    await a.controller.save("real", bank(), 0);
    await a.controller.sync();
    await b.controller.sync();
    const sa = await a.controller.load("real"),
      sb = await b.controller.load("real"),
      deleted = sa.state.dataset.items[0].id;
    sa.state.dataset.items = sa.state.dataset.items.slice(1);
    await a.controller.save("real", sa.state, sa.generation);
    expect(
      (await a.store.read(owner)).meta.projection.itemTombstones,
    ).toContain(deleted);
    sb.state.dataset.items[1].revision++;
    sb.state.dataset.items[1].tags.push("unrelated remote change");
    await b.controller.save("real", sb.state, sb.generation);
    await b.controller.sync();
    await a.controller.sync();
    expect(
      (await a.controller.load("real")).state.dataset.items.some(
        (i) => i.id === deleted,
      ),
    ).toBe(false);
    const failed = (await a.store.read(owner)).meta;
    expect(Object.keys(failed.failures)).toHaveLength(1);
    await a.controller.retryVersionConflict(Object.keys(failed.failures)[0]);
    await a.controller.sync();
    await b.controller.sync();
    expect(
      (await b.controller.load("real")).state.dataset.items.some(
        (i) => i.id === deleted,
      ),
    ).toBe(false);
  });
  it("rejects bank mutation through the data layer while a session is active", async () => {
    const a = await setup();
    let e = await a.controller.save("real", bank(), 0);
    const active = structuredClone(e.state);
    startSession(active, defaultSelection, [active.dataset.items[0]]);
    e = await a.controller.save("real", active, e.generation);
    const next = structuredClone(e.state);
    next.dataset.items.pop();
    await expect(a.controller.save("real", next, e.generation)).rejects.toThrow(
      "진행 중",
    );
    expect((await a.controller.load("real")).state.dataset.items).toHaveLength(
      7,
    );
  });
  it("automatically schedules the next successful batch when more than 100 events remain", async () => {
    const a = await setup();
    await a.controller.save("real", bank(), 0);
    await a.controller.sync();
    const s = await a.store.read(owner),
      key = keyOf(s.state.dataset.items[0].id, "current");
    for (let i = 0; i < 103; i++)
      s.meta.outbox.push({
        protocolVersion: 1,
        eventId: crypto.randomUUID(),
        deviceId: s.meta.deviceId,
        deviceSequence: s.meta.nextSequence++,
        baseCursor: s.meta.cursor,
        createdAt: new Date().toISOString(),
        kind: "mark",
        payload: { questionId: key, value: i % 2 === 0, baseMarkVersion: i },
      });
    await a.store.write(owner, s, s.generation);
    await a.controller.sync();
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(500);
    await a.controller.sync();
    expect((await a.store.read(owner)).meta.outbox).toHaveLength(0);
    expect(a.server.records).toHaveLength(104);
  });
  it("blocks a guessed-version bank successor after the first CAS conflict and after explicit rebase", async () => {
    const server = new Server(),
      a = await setup(server),
      b = await setup(server);
    await a.controller.save("real", bank(), 0);
    await a.controller.sync();
    await b.controller.sync();
    let local = await a.controller.load("real");
    local.state.dataset.items[0].revision++;
    local.state.dataset.items[0].tags.push("local one");
    local = await a.controller.save("real", local.state, local.generation);
    local.state.dataset.items[0].revision++;
    local.state.dataset.items[0].tags.push("local two");
    await a.controller.save("real", local.state, local.generation);
    const remote = await b.controller.load("real");
    remote.state.dataset.items[1].revision++;
    remote.state.dataset.items[1].tags.push("remote must survive");
    await b.controller.save("real", remote.state, remote.generation);
    await b.controller.sync();
    await a.controller.sync();
    await a.controller.sync();
    expect(server.bankVersion).toBe(2);
    expect(server.records.at(-1)!.event.kind).toBe("bank");
    let pending = await a.store.read(owner);
    expect(pending.meta.outbox.filter((e) => e.kind === "bank")).toHaveLength(
      2,
    );
    expect(Object.keys(pending.meta.failures)).toHaveLength(1);
    const first = pending.meta.outbox[0].eventId;
    await a.controller.retryVersionConflict(first);
    await a.controller.sync();
    expect(server.bankVersion).toBe(3);
    pending = await a.store.read(owner);
    expect(pending.meta.outbox).toHaveLength(1);
    expect(pending.meta.failures[pending.meta.outbox[0].eventId]).toContain(
      "직접 재시도",
    );
    await a.controller.sync();
    expect(server.bankVersion).toBe(3);
    const last = server.records.at(-1)!.event;
    expect(
      last.kind === "bank" && last.payload.dataset.items[1].tags,
    ).toContain("remote must survive");
  });
  it("blocks same-key mark successors and requires review after keeping the remote value", async () => {
    const server = new Server(),
      a = await setup(server),
      b = await setup(server),
      key = keyOf(bank().dataset.items[0].id, "current");
    await a.controller.save("real", bank(), 0);
    await a.controller.sync();
    await b.controller.sync();
    let local = await a.controller.load("real");
    local.state.marks[key] = true;
    local = await a.controller.save("real", local.state, local.generation);
    local.state.marks[key] = false;
    await a.controller.save("real", local.state, local.generation);
    const remote = await b.controller.load("real");
    remote.state.marks[key] = true;
    await b.controller.save("real", remote.state, remote.generation);
    await b.controller.sync();
    await a.controller.sync();
    await a.controller.sync();
    expect(server.versions[key]).toBe(1);
    let pending = await a.store.read(owner);
    expect(pending.meta.outbox).toHaveLength(2);
    await a.controller.keepRemoteMark(pending.meta.outbox[0].eventId);
    await a.controller.sync();
    expect(server.versions[key]).toBe(1);
    pending = await a.store.read(owner);
    expect(pending.meta.failures[pending.meta.outbox[0].eventId]).toContain(
      " 이어진 변경",
    );
    await a.controller.retryVersionConflict(pending.meta.outbox[0].eventId);
    await a.controller.sync();
    expect(server.versions[key]).toBe(2);
    expect((await a.controller.load("real")).state.marks[key]).toBe(false);
  });
});
