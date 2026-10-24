import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudController } from "../src/original/sync/controller";
import { SyncAccountStore } from "../src/original/sync/local";
import {
  SupabaseTransport,
  type AuthSession,
} from "../src/original/sync/transport";
import { initialState } from "../src/fixtures/data";
import { defaultSelection } from "../src/domain/schema";
import { startSession } from "../src/domain/engine";

const project = "https://shared-auth-test.supabase.co";
const uid = "11111111-1111-4111-8111-111111111111";
const owner = project + "|" + uid;
const authKey = "sync:auth:" + project;
const stores: SyncAccountStore[] = [];
const session = (expired = false): AuthSession => ({
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_at: Math.floor(Date.now() / 1000) + (expired ? -10 : 3600),
  user: { id: uid, email: "fixture@example.com" },
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
async function setup(auth: AuthSession | null = session()) {
  const store = new SyncAccountStore("shared-auth-" + crypto.randomUUID());
  stores.push(store);
  if (auth) await store.setValue(authKey, auth);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const transport = new SupabaseTransport(
    { url: project, key: "sb_publishable_fixture" },
    fetcher,
  );
  const controller = new CloudController(store, transport, { kind: "none" });
  controller.setEnabled(false);
  await controller.init();
  return { store, transport, controller, fetcher };
}
function activeOx() {
  const state = initialState(true);
  startSession(state, { ...defaultSelection, limit: 10 });
  return state;
}

describe("shared original/OX authentication", () => {
  it("refreshes concurrent original and OX requests once and persists the same session", async () => {
    const { store, transport, controller } = await setup(session(true));
    const fresh = {
      ...session(),
      access_token: "fresh-synthetic",
      refresh_token: "fresh-refresh",
    };
    const refresh = vi.spyOn(transport, "refresh").mockResolvedValue(fresh);
    const [original, ox] = await Promise.all([
      controller.getAuth(),
      controller.getAuth(),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(original).toEqual(fresh);
    expect(ox).toEqual(fresh);
    expect(await store.getValue(authKey)).toEqual(fresh);
  });
  it("does not send a login email while unlinked OX answers are active", async () => {
    const { store, controller, fetcher } = await setup(null);
    await store.setValue("real", { generation: 2, state: activeOx() });
    await expect(controller.sendCode("fixture@example.com")).rejects.toThrow(
      "진행 중 OX",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect((await store.getValue<any>("real")).state.sessions[0].status).toBe(
      "active",
    );
  });
  it("blocks signout while this account has active OX answers and retains credentials", async () => {
    const { store, controller } = await setup();
    await store.setValue("ox:real:user:" + owner, {
      generation: 7,
      state: activeOx(),
    });
    await expect(controller.logout()).rejects.toThrow("학습을 종료");
    expect(await store.getValue(authKey)).toEqual(session());
    expect(controller.snapshot().ownerId).toBe(owner);
  });
  it("retains an offline OX outbox and state when the shared account signs out", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { store, controller } = await setup();
    const state = initialState(false);
    const pending = { outbox: [{ eventId: "pending-fixture" }] };
    await store.setValue("ox:real:user:" + owner, { generation: 4, state });
    await store.setValue("ox-sync:real:user:" + owner, pending);
    expect(await controller.linkedOxStatus()).toEqual({
      active: false,
      pending: 1,
    });
    await controller.logout();
    expect(controller.snapshot().ownerId).toBeNull();
    expect(await store.getValue(authKey)).toBeNull();
    expect(await store.getValue("ox:real:user:" + owner)).toEqual({
      generation: 4,
      state,
    });
    expect(await store.getValue("ox-sync:real:user:" + owner)).toEqual(pending);
  });
});
