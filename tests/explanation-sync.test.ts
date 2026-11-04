import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  ExplanationSyncRepository,
} from "../src/original/explanations/sync";
import { ExplanationCloudTransport } from "../src/original/explanations/sync-transport";
import { syncExplanationLibraries } from "../src/original/explanations/sync-runner";
import { ExplanationRepository } from "../src/original/explanations/library";
import { InstructorRepository } from "../src/original/instructor/library";
import { validateExplanationPackage } from "../src/original/explanations/contract";
import { validateInstructorPackage } from "../src/original/instructor/contract";
import { explanationSyncFixture } from "./fixtures/explanation-sync";

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const config = { url: "https://sync.test", key: "sb_publishable_TEST_ONLY" };
const owner = `${config.url}|${UID}`, otherOwner = `${config.url}|${OTHER}`;
const auth = (id = UID) => ({
  access_token: `access:${id}`, refresh_token: `refresh:${id}`,
  expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id },
});

/** Fake immutable private Storage only; it is not a Supabase RLS assertion. */
class FakeStorage {
  objects = new Map<string, Uint8Array>();
  offline = false;
  corruptPath = "";
  listOffsets: number[] = [];
  writes = 0;
  failWriteAt = Infinity;
  fetcher: typeof fetch = async (input, init = {}) => {
    if (this.offline) throw Error("TEST_ONLY offline");
    const url = new URL(String(input));
    const token = new Headers(init.headers).get("Authorization") ?? "";
    const id = token.replace("Bearer access:", "");
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (![UID, OTHER].includes(id)) return json({ message: "unauthorized" }, 401);
    if (url.pathname === "/storage/v1/object/list/police-sync-private") {
      const p = JSON.parse(String(init.body));
      if (!p.prefix.startsWith(`${id}/real/`)) return json({ message: "forbidden" }, 403);
      this.listOffsets.push(p.offset);
      const prefix = `${p.prefix.replace(/\/$/, "")}/`;
      return json([...this.objects.keys()].filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)).filter((name) => !name.includes("/"))
        .sort().slice(p.offset, p.offset + p.limit).map((name) => ({ name, id: name })));
    }
    const match = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?police-sync-private\/(.+)$/);
    if (!match) return json({ message: "unknown fake endpoint" }, 404);
    const path = match[1];
    if (!path.startsWith(`${id}/real/`)) return json({ message: "forbidden" }, 403);
    if (init.method === "POST") {
      if (++this.writes === this.failWriteAt) throw Error("TEST_ONLY lost connection");
      if (this.objects.has(path)) return json({ message: "duplicate" }, 409);
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      if (bytes.length > 1048576) return json({ message: "bucket limit" }, 413);
      this.objects.set(path, bytes);
      return json({ Key: path });
    }
    const bytes = this.objects.get(path);
    if (!bytes) return json({ message: "missing" }, 404);
    return new Response((path === this.corruptPath ? new Uint8Array([1, 2, 3]) : bytes) as BodyInit);
  };
  manifests(id = UID) {
    return [...this.objects.keys()].filter((path) => path.startsWith(`${id}/real/explanations/manifests/`));
  }
}

let fixture: Awaited<ReturnType<typeof explanationSyncFixture>>;
beforeEach(async () => { fixture = await explanationSyncFixture(); });
const empty = () => ({ legacy: [], instructor: [] });

describe("private explanation synchronization", () => {
  it("uses valid neutral real-format source-linked fixtures", async () => {
    const { source, legacy, instructor } = fixture;
    await expect(validateExplanationPackage(legacy, "real", source.questions, source.assets)).resolves.toEqual(legacy);
    await expect(validateInstructorPackage(instructor, "real", source.questions, source.assets)).resolves.toEqual(instructor);
  });

  it("shares both libraries between independent devices without empty-device deletion", async () => {
    const a = new ExplanationSyncRepository(new IDBFactory(), "device-a");
    const b = new ExplanationSyncRepository(new IDBFactory(), "device-b");
    const cloud = new FakeStorage(), transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await a.merge(owner, { legacy: [fixture.legacy], instructor: [fixture.instructor] });
    const before = (await a.read(owner)).bundle;
    await syncExplanationLibraries(owner, auth(), config, { repository: a, transport });
    expect(cloud.manifests()).toHaveLength(1);
    await syncExplanationLibraries(owner, auth(), config, { repository: b, transport });
    expect((await b.read(owner)).bundle).toEqual(before);
    await b.merge(owner, empty());
    await syncExplanationLibraries(owner, auth(), config, { repository: b, transport });
    expect((await a.read(owner)).bundle).toEqual(before);
    expect(cloud.manifests()).toHaveLength(1);
  });

  it("keeps pending data after interrupted chunk upload and resumes idempotently", async () => {
    const a = new ExplanationSyncRepository(new IDBFactory(), "device-a");
    const b = new ExplanationSyncRepository(new IDBFactory(), "device-b");
    fixture.legacy.bases[0].originalText = "중립 도형 설명 ".repeat(40000);
    const cloud = new FakeStorage(), transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await a.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    cloud.failWriteAt = 2;
    await expect(syncExplanationLibraries(owner, auth(), config, { repository: a, transport })).rejects.toThrow();
    expect((await a.read(owner)).bundle.legacy).toHaveLength(1);
    expect(cloud.manifests()).toHaveLength(0);
    cloud.failWriteAt = Infinity;
    await syncExplanationLibraries(owner, auth(), config, { repository: a, transport });
    expect([...cloud.objects.values()].every((bytes) => bytes.length <= 1048576)).toBe(true);
    expect([...cloud.objects.keys()].filter((key) => key.includes("/chunks/")).length).toBeGreaterThan(1);
    await syncExplanationLibraries(owner, auth(), config, { repository: b, transport });
    expect((await b.read(owner)).bundle.legacy).toEqual([fixture.legacy]);
    const count = cloud.objects.size;
    await syncExplanationLibraries(owner, auth(), config, { repository: a, transport });
    expect(cloud.objects.size).toBe(count);
  });

  it("rejects damaged remote bytes before replacing existing local data", async () => {
    const local = new ExplanationSyncRepository(new IDBFactory(), "safe-local");
    await local.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    const before = await local.read(owner);
    const cloud = new FakeStorage(), transport = new ExplanationCloudTransport(config, cloud.fetcher);
    const newer = structuredClone(fixture.legacy);
    newer.packageVersion = 2;
    newer.notes.push("TEST_ONLY newer version");
    await transport.upload({ legacy: [newer], instructor: [] }, auth());
    cloud.corruptPath = [...cloud.objects.keys()].find((key) => key.includes("/chunks/"))!;
    await expect(syncExplanationLibraries(owner, auth(), config, { repository: local, transport })).rejects.toThrow();
    expect(await local.read(owner)).toEqual(before);
  });

  it("preserves version conflicts and ignores older immutable snapshots", async () => {
    const repo = new ExplanationSyncRepository(new IDBFactory(), "version-test");
    await repo.merge(owner, { legacy: [fixture.legacy], instructor: [fixture.instructor] });
    const conflict = structuredClone(fixture.instructor);
    conflict.records[0].notes.push("TEST_ONLY conflicting same version");
    const before = await repo.read(owner);
    await expect(repo.merge(owner, { legacy: [], instructor: [conflict] })).rejects.toThrow();
    expect(await repo.read(owner)).toEqual(before);
    const newer = structuredClone(fixture.instructor);
    newer.packageVersion++;
    newer.records[0].revision++;
    newer.records[0].notes.push("TEST_ONLY revision two");
    await repo.merge(owner, { legacy: [], instructor: [newer] });
    await repo.merge(owner, { legacy: [], instructor: [fixture.instructor] });
    expect((await repo.read(owner)).bundle.instructor).toEqual([newer]);
  });

  it("isolates account data and denies cross-account object downloads", async () => {
    const repo = new ExplanationSyncRepository(new IDBFactory(), "accounts");
    const cloud = new FakeStorage(), transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await repo.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    await syncExplanationLibraries(owner, auth(), config, { repository: repo, transport });
    await syncExplanationLibraries(otherOwner, auth(OTHER), config, { repository: repo, transport });
    expect((await repo.read(otherOwner)).bundle).toEqual(empty());
    expect(cloud.manifests(OTHER)).toHaveLength(0);
    expect(await transport.list(auth(OTHER))).toEqual([]);
    await expect(transport.download(cloud.manifests()[0], auth(OTHER))).rejects.toThrow();
    expect((await repo.read(owner)).bundle.legacy).toHaveLength(1);
  });

  it("rejects demo payloads and account changes before transferring data", async () => {
    const repo = new ExplanationSyncRepository(new IDBFactory(), "guarded-account");
    const cloud = new FakeStorage(), transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await repo.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    const before = await repo.read(owner);
    const demo = structuredClone(fixture.instructor);
    demo.dataKind = "demo";
    await expect(repo.merge(owner, { legacy: [], instructor: [demo] })).rejects.toThrow();
    await expect(syncExplanationLibraries(otherOwner, auth(), config, { repository: repo, transport })).rejects.toThrow();
    await expect(syncExplanationLibraries(owner, auth(), config, {
      repository: repo, transport, current: () => false,
    })).rejects.toThrow();
    expect(cloud.objects.size).toBe(0);
    expect(await repo.read(owner)).toEqual(before);
  });

  it("claims pre-login libraries for one account only and retains local originals", async () => {
    const factory = new IDBFactory(), name = "local-claim";
    const legacy = new ExplanationRepository(factory, name);
    await legacy.import("local", "real", fixture.legacy, fixture.source.questions, fixture.source.assets);
    const repo = new ExplanationSyncRepository(factory, name);
    await repo.migrateLocal(owner);
    expect((await repo.read(owner)).bundle.legacy).toEqual([fixture.legacy]);
    await repo.migrateLocal(otherOwner);
    expect((await repo.read(otherOwner)).bundle).toEqual(empty());
    expect((await legacy.read("local", "real")).packages).toEqual([fixture.legacy]);
  });

  it("migrates later pre-login updates again to their claimed account only", async () => {
    const factory = new IDBFactory(), name = "repeated-local-claim";
    const legacy = new ExplanationRepository(factory, name);
    const modern = new InstructorRepository(factory, name);
    const repo = new ExplanationSyncRepository(factory, name);
    await legacy.import("local", "real", fixture.legacy, fixture.source.questions, fixture.source.assets);
    await repo.migrateLocal(owner);
    const afterFirstClaim = await repo.read(owner);
    expect(await repo.migrateLocal(owner)).toBe(false);
    expect(await repo.read(owner)).toEqual(afterFirstClaim);
    const newerLegacy = structuredClone(fixture.legacy);
    newerLegacy.packageVersion++;
    newerLegacy.notes.push("TEST_ONLY imported after logging out");
    await legacy.import("local", "real", newerLegacy, fixture.source.questions, fixture.source.assets);
    await repo.migrateLocal(owner);
    expect((await repo.read(owner)).bundle.legacy).toEqual([newerLegacy]);
    await modern.import("local", "real", fixture.instructor, fixture.source.questions, fixture.source.assets);
    await repo.migrateLocal(owner);
    const newerInstructor = structuredClone(fixture.instructor);
    newerInstructor.packageVersion++;
    newerInstructor.records[0].revision++;
    newerInstructor.records[0].notes.push("TEST_ONLY later local instructor revision");
    await modern.import("local", "real", newerInstructor, fixture.source.questions, fixture.source.assets);
    await repo.migrateLocal(owner);
    expect((await repo.read(owner)).bundle).toEqual({ legacy: [newerLegacy], instructor: [newerInstructor] });
    await repo.migrateLocal(otherOwner);
    expect((await repo.read(otherOwner)).bundle).toEqual(empty());
    expect((await modern.read("local", "real")).packages).toEqual([newerInstructor]);
  });

  it("keeps a cleared legacy archive from reappearing after instructor sync", async () => {
    const factory = new IDBFactory(), name = "replacement";
    const legacy = new ExplanationRepository(factory, name);
    const modern = new InstructorRepository(factory, name);
    await legacy.import(owner, "real", fixture.legacy, fixture.source.questions, fixture.source.assets);
    await modern.import(owner, "real", fixture.instructor, fixture.source.questions, fixture.source.assets);
    const repo = new ExplanationSyncRepository(factory, name);
    await repo.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    expect((await legacy.read(owner, "real")).packages).toEqual([]);
    expect((await modern.read(owner, "real")).packages).toEqual([fixture.instructor]);
  });

  it("lists immutable manifests across every storage page", async () => {
    const cloud = new FakeStorage(), transport = new ExplanationCloudTransport(config, cloud.fetcher);
    for (let i = 0; i < 105; i++) {
      const name = i.toString(16).padStart(64, "0");
      cloud.objects.set(`${UID}/real/explanations/manifests/${name}`, new Uint8Array());
    }
    expect(await transport.list(auth())).toHaveLength(105);
    expect(cloud.listOffsets).toEqual([0, 100]);
  });
});
