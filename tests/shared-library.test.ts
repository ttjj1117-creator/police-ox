import "fake-indexeddb/auto";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CloudController } from "../src/original/sync/controller";
import { SyncAccountStore, accountStateKey } from "../src/original/sync/local";
import { SharedLibrary } from "../src/original/sync/shared-library";
import { SupabaseTransport } from "../src/original/sync/transport";
import { initialOriginalState } from "../src/original/engine";
import { explanationSyncFixture } from "./fixtures/explanation-sync";

vi.mock("../src/original/explanations/sync-runner", () => ({
  cancelExplanationSyncWorker: vi.fn(),
  syncExplanationLibraries: vi.fn().mockResolvedValue({ legacy: 0, instructor: 0 }),
}));

const config = { url: "https://shared.example.invalid", key: "sb_publishable_TEST" };
const uid = "11111111-1111-4111-8111-111111111111";
const auth = {
  access_token: "test-auth",
  refresh_token: "test-refresh",
  expires_at: Math.floor(Date.now() / 1000) + 7200,
  user: { id: uid },
};
const owner = `${config.url}|${uid}`;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stores: SyncAccountStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) await store.close();
});

async function setup(existing = false) {
  const { source } = await explanationSyncFixture();
  const questions = gzipSync(JSON.stringify({ packages: [source] }));
  const explanations = gzipSync(JSON.stringify({ legacy: [], instructor: [] }));
  const descriptor = (data: Uint8Array) => ({ bytes: data.length, sha256: hash(data) });
  const manifest = {
    version: 1,
    releaseId: hash(`${hash(questions)}:${hash(explanations)}`),
    questions: descriptor(questions),
    explanations: descriptor(explanations),
  };
  const store = new SyncAccountStore("shared-" + crypto.randomUUID());
  stores.push(store);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/police-ox-shared/")) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth");
      expect(url.searchParams.has("v")).toBe(true);
      if (url.pathname.endsWith("/current.json")) return Response.json(manifest);
      if (url.pathname.endsWith("/questions.json.gz"))
        return new Response(new Uint8Array(questions));
    }
    if (url.pathname.endsWith("/police_sync_pull"))
      return Response.json({ events: [], cursor: 0, bankVersion: 0, serverTime: new Date().toISOString() });
    throw Error("Unexpected route: " + url.pathname);
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", fetcher);
  await store.setValue("sync:auth:" + config.url, auth);
  if (existing) {
    const state = initialOriginalState("real");
    state.data = { questions: source.questions, assets: source.assets, packages: [source] };
    state.marks[source.questions[0].id] = true;
    await store.setValue(accountStateKey(owner), { generation: 1, state });
  }
  const controller = new CloudController(store, new SupabaseTransport(config, fetcher), { kind: "none" });
  controller.setEnabled(false);
  await controller.init({ VITE_SHARED_LIBRARY_ENABLED: "true" });
  controller.setEnabled(true);
  await controller.sync();
  controller.setEnabled(false);
  return { store, fetcher, manifest, source };
}

it("fills an empty authenticated bank without inheriting or uploading private records", async () => {
  const { store, source, manifest, fetcher } = await setup();
  const snapshot = await store.read(owner);
  expect(snapshot.state.data.questions).toEqual(source.questions);
  expect(snapshot.state.attempts).toEqual([]);
  expect(snapshot.state.sessions).toEqual([]);
  expect(snapshot.state.marks).toEqual({});
  expect(snapshot.meta.outbox).toEqual([]);
  expect(snapshot.meta.sharedLibraryRelease).toBe(manifest.releaseId);
  expect((await store.read(config.url + "|another")).state.data.questions).toEqual([]);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("police_sync_push"))).toBe(false);
});

it("keeps an existing private bank and its marks", async () => {
  const { store, source, fetcher } = await setup(true);
  const snapshot = await store.read(owner);
  expect(snapshot.state.marks[source.questions[0].id]).toBe(true);
  expect(snapshot.meta.sharedLibraryRelease).toBeUndefined();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/police-ox-shared/"))).toBe(false);
});

it("ignores an unavailable manifest and rejects a corrupted release object", async () => {
  const unavailable = new SharedLibrary(config, auth, async () => new Response(null, { status: 404 }));
  await expect(unavailable.getManifest()).resolves.toBeNull();
  const { manifest } = await setup();
  const corrupted = new SharedLibrary(config, auth, async () =>
    new Response(new Uint8Array(manifest.questions.bytes)),
  );
  await expect(corrupted.getPart(manifest, "questions")).rejects.toThrow("손상");
});
