import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OriginalRepository } from "../src/original/storage";
import {
  answer,
  defaultSelection,
  finish,
  initialOriginalState,
  startSession,
} from "../src/original/engine";
import { demoData } from "../src/original/demo";
import {
  SyncAccountStore,
  accountStateKey,
  syncMetaKey,
} from "../src/original/sync/local";
import { CloudController } from "../src/original/sync/controller";
import {
  SupabaseTransport,
  type AuthSession,
} from "../src/original/sync/transport";
import { Repository as OxRepository } from "../src/data/repository";
import { initialState as initialOxState } from "../src/fixtures/data";

const ownerA =
  "https://sync-test.supabase.co|11111111-1111-4111-8111-111111111111";
const ownerB =
  "https://sync-test.supabase.co|22222222-2222-4222-8222-222222222222";
const resources: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});
function stores() {
  const name = `sync-storage-${crypto.randomUUID()}`;
  const original = new OriginalRepository(name),
    account = new SyncAccountStore(name),
    ox = new OxRepository(name);
  resources.push(original, account, ox);
  return { original, account, ox };
}
function bank() {
  const s = initialOriginalState("real"),
    q = structuredClone(demoData().questions[0]);
  q.id = "const_2026_1_1";
  q.source.examCode = "po";
  q.officialAnswer.status = "final";
  q.officialAnswer.acceptedChoices = [1];
  q.source.questionPdf = { fileName: "test.pdf", pages: [1] };
  q.source.answerPdf = {
    fileName: "answers.pdf",
    pages: [1],
    subjectColumn: "헌법",
  };
  s.data.questions = [q];
  return s;
}
describe("account state and outbox commit atomically in the existing IndexedDB", () => {
  it("keeps unlinked, account A, account B, demo and OX state separate", async () => {
    const { original, account, ox } = stores();
    await original.save("real", bank(), 0);
    const oxState = initialOxState(false);
    oxState.settings.fontScale = 1.5;
    await ox.save("real", oxState, 0);
    original.useAccount(ownerA);
    expect((await original.load("real")).state.data.questions).toEqual([]);
    const linked = bank();
    linked.settings.fontScale = 1.25;
    await original.save("real", linked, 0);
    original.useAccount(ownerB);
    expect((await original.load("real")).state.data.questions).toEqual([]);
    await original.save("demo", initialOriginalState("demo"), 0);
    expect((await account.read(ownerB)).meta.outbox).toEqual([]);
    expect((await original.load("demo")).state.data.questions).toHaveLength(
      100,
    );
    original.useAccount(null);
    expect((await original.load("real")).state.data.questions).toHaveLength(1);
    expect((await account.read(ownerA)).state.settings.fontScale).toBe(1.25);
    expect((await ox.load("real")).state.settings.fontScale).toBe(1.5);
  });
  it("writes linked bank data and its durable event together with one generation", async () => {
    const { original, account } = stores();
    original.useAccount(ownerA);
    const saved = await original.save("real", bank(), 0),
      durable = await account.read(ownerA);
    expect(saved.generation).toBe(1);
    expect(durable.generation).toBe(1);
    expect(durable.state).toEqual(saved.state);
    expect(durable.meta.outbox).toHaveLength(1);
    expect(durable.meta.outbox[0].kind).toBe("bank");
    expect(durable.meta.cursor).toBe(0);
  });
  it("stores active study answers locally but enqueues their bundle only when ended", async () => {
    const { original, account } = stores();
    original.useAccount(ownerA);
    let saved = await original.save("real", bank(), 0),
      draft = structuredClone(saved.state);
    const session = startSession(
      draft,
      "real",
      { ...defaultSelection, limit: 1 },
      "study",
      Date.parse("2026-10-23T00:00:00Z"),
    );
    answer(draft, session.id, 2, Date.parse("2026-10-23T00:00:01Z"));
    saved = await original.save("real", draft, saved.generation);
    let durable = await account.read(ownerA);
    expect(durable.state.attempts).toHaveLength(1);
    expect(
      durable.meta.outbox.filter((event) => event.kind === "session"),
    ).toEqual([]);
    expect(
      durable.meta.projection.order[draft.attempts[0].attemptId],
    ).toBeDefined();
    draft = structuredClone(saved.state);
    finish(draft, session.id, Date.parse("2026-10-23T00:00:02Z"));
    await original.save("real", draft, saved.generation);
    durable = await account.read(ownerA);
    expect(
      durable.meta.outbox.filter((event) => event.kind === "session"),
    ).toHaveLength(1);
    expect(durable.state.attempts[0].answeredAt).toBe(
      "2026-10-23T00:00:01.000Z",
    );
  });
  it("retains outbox after closing and reopening the app store", async () => {
    const name = `sync-reopen-${crypto.randomUUID()}`,
      original = new OriginalRepository(name);
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    await original.close();
    const reopened = new SyncAccountStore(name);
    resources.push(reopened);
    const durable = await reopened.read(ownerA);
    expect(durable.state.data.questions).toHaveLength(1);
    expect(durable.meta.outbox).toHaveLength(1);
    expect(durable.meta.cursor).toBe(0);
  });
  it("rolls back metadata if the linked state write fails after the outbox put", async () => {
    const { original, account } = stores();
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    const before = await account.read(ownerA),
      draft = structuredClone(before.state);
    draft.marks[draft.data.questions[0].id] = true;
    const realPut = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (key === accountStateKey(ownerA))
          throw new DOMException("test quota failure", "QuotaExceededError");
        return realPut.call(this, value, key);
      });
    await expect(
      original.save("real", draft, before.generation),
    ).rejects.toThrow("quota");
    spy.mockRestore();
    expect(await account.read(ownerA)).toEqual(before);
  });
  it("rolls back the state if controller metadata write fails as the second put", async () => {
    const { original, account } = stores();
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    const before = await account.read(ownerA),
      draft = structuredClone(before);
    draft.state.marks[draft.state.data.questions[0].id] = true;
    draft.meta.cursor = 123;
    const realPut = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (key === syncMetaKey(ownerA))
          throw new DOMException("test quota failure", "QuotaExceededError");
        return realPut.call(this, value, key);
      });
    await expect(
      account.write(ownerA, draft, before.generation),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(await account.read(ownerA)).toEqual(before);
  });
  it("rejects stale generation without adding duplicate events or overwriting records", async () => {
    const { original, account } = stores();
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    const before = await account.read(ownerA),
      draft = structuredClone(before.state);
    draft.marks[draft.data.questions[0].id] = true;
    await expect(original.save("real", draft, 0)).rejects.toThrow("다른 탭");
    expect(await account.read(ownerA)).toEqual(before);
    await expect(
      account.write(ownerA, { ...before, state: draft }, 0),
    ).rejects.toThrow("다른 탭");
    expect(await account.read(ownerA)).toEqual(before);
  });
  it("protects metadata acknowledgements with their own revision without invalidating answer generation", async () => {
    const { original, account } = stores();
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    const firstReader = await account.read(ownerA),
      secondReader = structuredClone(firstReader);
    firstReader.meta.cursor = 1;
    const acknowledged = await account.write(
      ownerA,
      firstReader,
      firstReader.generation,
    );
    expect(acknowledged.generation).toBe(secondReader.generation);
    expect(acknowledged.meta.revision).toBe(
      (secondReader.meta.revision ?? 0) + 1,
    );
    secondReader.meta.cursor = 2;
    await expect(
      account.write(ownerA, secondReader, secondReader.generation),
    ).rejects.toThrow("다른 탭");
    const durable = await account.read(ownerA);
    expect(durable.meta.cursor).toBe(1);
    expect(durable.meta.outbox).toHaveLength(1);
    const answerDraft = structuredClone(secondReader.state);
    answerDraft.marks[answerDraft.data.questions[0].id] = true;
    await original.save("real", answerDraft, secondReader.generation);
    expect((await account.read(ownerA)).meta.cursor).toBe(1);
  });
  it("blocks whole-account replacement through the legacy restore command", async () => {
    const { original, account } = stores();
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    const before = await account.read(ownerA);
    const backup = await original.fullBackup("real");
    await expect(
      original.restore("real", backup, before.generation),
    ).rejects.toThrow("미리보기 후 병합");
    expect(await account.read(ownerA)).toEqual(before);
  });
});
describe("logout and account switching preserve personal unsent data", () => {
  it("keeps the remote unset when discarding one stale mark without dropping other pending work", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { original, account } = stores(),
      config = {
        url: "https://sync-test.supabase.co",
        key: "sb_publishable_test",
      };
    const transport = new SupabaseTransport(config),
      auth: AuthSession = {
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_at: Date.now() / 1000 + 3600,
        user: { id: ownerA.split("|")[1] },
      };
    vi.spyOn(transport, "verify").mockResolvedValue(auth);
    const controller = new CloudController(account, transport);
    controller.setEnabled(false);
    await controller.init({});
    await controller.verify("a@example.invalid", "123456");
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    const snapshot = await account.read(ownerA),
      id = snapshot.state.data.questions[0].id;
    snapshot.state.marks[id] = false;
    snapshot.meta.projection.markVersions[id] = 2;
    snapshot.meta.outbox.push({
      protocolVersion: 1,
      eventId: "stale-mark",
      deviceId: snapshot.meta.deviceId,
      deviceSequence: 100,
      baseCursor: 0,
      createdAt: "2026-10-23T00:00:00Z",
      kind: "mark",
      payload: { questionId: id, value: true, baseMarkVersion: 0 },
    });
    snapshot.meta.failures["stale-mark"] = "mark_version_conflict";
    await account.write(ownerA, snapshot, snapshot.generation);
    await controller.reload();
    await controller.keepRemoteMark("stale-mark");
    const result = await account.read(ownerA);
    expect(result.state.marks[id]).toBe(false);
    expect(result.meta.projection.markVersions[id]).toBe(2);
    expect(result.meta.failures["stale-mark"]).toBeUndefined();
    expect(
      result.meta.outbox.some((event) => event.eventId === "stale-mark"),
    ).toBe(false);
    expect(result.meta.outbox.some((event) => event.kind === "bank")).toBe(
      true,
    );
  });
  it("closes auth cache and private view while keeping the previous account's pending cache", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { original, account } = stores(),
      config = {
        url: "https://sync-test.supabase.co",
        key: "sb_publishable_test",
      };
    const transport = new SupabaseTransport(config);
    const authA: AuthSession = {
      access_token: "test-access-a",
      refresh_token: "test-refresh-a",
      expires_at: Date.now() / 1000 + 3600,
      user: { id: ownerA.split("|")[1], email: "a@example.invalid" },
    };
    const authB: AuthSession = {
      ...authA,
      access_token: "test-access-b",
      refresh_token: "test-refresh-b",
      user: { id: ownerB.split("|")[1], email: "b@example.invalid" },
    };
    vi.spyOn(transport, "verify")
      .mockResolvedValueOnce(authA)
      .mockResolvedValueOnce(authB);
    const controller = new CloudController(account, transport);
    controller.setEnabled(false);
    await controller.init({});
    await controller.verify("a@example.invalid", "123456");
    original.useAccount(ownerA);
    await original.save("real", bank(), 0);
    await controller.reload();
    const before = await account.read(ownerA);
    expect(controller.snapshot().pending).toBe(1);
    await controller.logout();
    expect(controller.snapshot()).toMatchObject({
      auth: null,
      ownerId: null,
      pending: 0,
      meta: null,
    });
    expect(await account.getValue(`sync:auth:${config.url}`)).toBeNull();
    expect(await account.read(ownerA)).toEqual(before);
    await controller.verify("b@example.invalid", "654321");
    expect(controller.snapshot().ownerId).toBe(ownerB);
    expect(controller.snapshot().pending).toBe(0);
    expect((await account.read(ownerB)).state.data.questions).toEqual([]);
    expect(await account.read(ownerA)).toEqual(before);
  });
});
