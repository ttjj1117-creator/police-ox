import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  ExplanationSyncRepository,
  parseExplanationBundle,
  explanationBundleFingerprint,
} from "../src/original/explanations/sync";
import { ExplanationCloudTransport } from "../src/original/explanations/sync-transport";
import { syncExplanationLibraries } from "../src/original/explanations/sync-runner";
import { ExplanationRepository } from "../src/original/explanations/library";
import { InstructorRepository } from "../src/original/instructor/library";
import { validateExplanationPackage } from "../src/original/explanations/contract";
import { validateInstructorPackage } from "../src/original/instructor/contract";
import * as instructorContract from "../src/original/instructor/contract";
import { explanationSyncFixture } from "./fixtures/explanation-sync";

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const config = { url: "https://sync.test", key: "sb_publishable_TEST_ONLY" };
const owner = `${config.url}|${UID}`,
  otherOwner = `${config.url}|${OTHER}`;
const auth = (id = UID) => ({
  access_token: `access:${id}`,
  refresh_token: `refresh:${id}`,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id },
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
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (![UID, OTHER].includes(id))
      return json({ message: "unauthorized" }, 401);
    if (url.pathname === "/storage/v1/object/list/police-sync-private") {
      const p = JSON.parse(String(init.body));
      if (!p.prefix.startsWith(`${id}/real/`))
        return json({ message: "forbidden" }, 403);
      this.listOffsets.push(p.offset);
      const prefix = `${p.prefix.replace(/\/$/, "")}/`;
      return json(
        [...this.objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length))
          .filter((name) => !name.includes("/"))
          .sort()
          .slice(p.offset, p.offset + p.limit)
          .map((name) => ({ name, id: name })),
      );
    }
    const match = url.pathname.match(
      /^\/storage\/v1\/object\/(?:authenticated\/)?police-sync-private\/(.+)$/,
    );
    if (!match) return json({ message: "unknown fake endpoint" }, 404);
    const path = match[1];
    if (!path.startsWith(`${id}/real/`))
      return json({ message: "forbidden" }, 403);
    if (init.method === "POST") {
      if (++this.writes === this.failWriteAt)
        throw Error("TEST_ONLY lost connection");
      if (this.objects.has(path)) return json({ message: "duplicate" }, 409);
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      if (bytes.length > 1048576) return json({ message: "bucket limit" }, 413);
      this.objects.set(path, bytes);
      return json({ Key: path });
    }
    const bytes = this.objects.get(path);
    if (!bytes) return json({ message: "missing" }, 404);
    return new Response(
      (path === this.corruptPath
        ? new Uint8Array([1, 2, 3])
        : bytes) as BodyInit,
    );
  };
  manifests(id = UID) {
    return [...this.objects.keys()].filter((path) =>
      path.startsWith(`${id}/real/explanations/manifests/`),
    );
  }
}

let fixture: Awaited<ReturnType<typeof explanationSyncFixture>>;
beforeEach(async () => {
  fixture = await explanationSyncFixture();
});
const empty = () => ({ legacy: [], instructor: [] });

describe("private explanation synchronization", () => {
  it("uses valid neutral real-format source-linked fixtures", async () => {
    const { source, legacy, instructor } = fixture;
    await expect(
      validateExplanationPackage(
        legacy,
        "real",
        source.questions,
        source.assets,
      ),
    ).resolves.toEqual(legacy);
    await expect(
      validateInstructorPackage(
        instructor,
        "real",
        source.questions,
        source.assets,
      ),
    ).resolves.toEqual(instructor);
  });

  it("shares both libraries between independent devices without empty-device deletion", async () => {
    const a = new ExplanationSyncRepository(new IDBFactory(), "device-a");
    const b = new ExplanationSyncRepository(new IDBFactory(), "device-b");
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await a.merge(owner, {
      legacy: [fixture.legacy],
      instructor: [fixture.instructor],
    });
    const before = (await a.read(owner)).bundle;
    await syncExplanationLibraries(owner, auth(), config, {
      repository: a,
      transport,
    });
    expect(cloud.manifests()).toHaveLength(1);
    await syncExplanationLibraries(owner, auth(), config, {
      repository: b,
      transport,
    });
    expect((await b.read(owner)).bundle).toEqual(before);
    await b.merge(owner, empty());
    await syncExplanationLibraries(owner, auth(), config, {
      repository: b,
      transport,
    });
    expect((await a.read(owner)).bundle).toEqual(before);
    expect(cloud.manifests()).toHaveLength(1);
  });

  it("keeps pending data after interrupted chunk upload and resumes idempotently", async () => {
    const a = new ExplanationSyncRepository(new IDBFactory(), "device-a");
    const b = new ExplanationSyncRepository(new IDBFactory(), "device-b");
    fixture.legacy.bases[0].originalText = "중립 도형 설명 ".repeat(40000);
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await a.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    cloud.failWriteAt = 2;
    await expect(
      syncExplanationLibraries(owner, auth(), config, {
        repository: a,
        transport,
      }),
    ).rejects.toThrow();
    expect((await a.read(owner)).bundle.legacy).toHaveLength(1);
    expect(cloud.manifests()).toHaveLength(0);
    cloud.failWriteAt = Infinity;
    await syncExplanationLibraries(owner, auth(), config, {
      repository: a,
      transport,
    });
    expect(
      [...cloud.objects.values()].every((bytes) => bytes.length <= 1048576),
    ).toBe(true);
    expect(
      [...cloud.objects.keys()].filter((key) => key.includes("/chunks/"))
        .length,
    ).toBeGreaterThan(1);
    await syncExplanationLibraries(owner, auth(), config, {
      repository: b,
      transport,
    });
    expect((await b.read(owner)).bundle.legacy).toEqual([fixture.legacy]);
    const count = cloud.objects.size;
    await syncExplanationLibraries(owner, auth(), config, {
      repository: a,
      transport,
    });
    expect(cloud.objects.size).toBe(count);
  });

  it("rejects damaged remote bytes before replacing existing local data", async () => {
    const local = new ExplanationSyncRepository(new IDBFactory(), "safe-local");
    await local.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    const before = await local.read(owner);
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    const newer = structuredClone(fixture.legacy);
    newer.packageVersion = 2;
    newer.notes.push("TEST_ONLY newer version");
    await transport.upload({ legacy: [newer], instructor: [] }, auth());
    cloud.corruptPath = [...cloud.objects.keys()].find((key) =>
      key.includes("/chunks/"),
    )!;
    await expect(
      syncExplanationLibraries(owner, auth(), config, {
        repository: local,
        transport,
      }),
    ).rejects.toThrow();
    expect(await local.read(owner)).toEqual(before);
  });

  it("preserves version conflicts and ignores older immutable snapshots", async () => {
    const repo = new ExplanationSyncRepository(
      new IDBFactory(),
      "version-test",
    );
    await repo.merge(owner, {
      legacy: [fixture.legacy],
      instructor: [fixture.instructor],
    });
    const conflict = structuredClone(fixture.instructor);
    conflict.records[0].notes.push("TEST_ONLY conflicting same version");
    const before = await repo.read(owner);
    await expect(
      repo.merge(owner, { legacy: [], instructor: [conflict] }),
    ).rejects.toThrow();
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
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await repo.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    await syncExplanationLibraries(owner, auth(), config, {
      repository: repo,
      transport,
    });
    await syncExplanationLibraries(otherOwner, auth(OTHER), config, {
      repository: repo,
      transport,
    });
    expect((await repo.read(otherOwner)).bundle).toEqual(empty());
    expect(cloud.manifests(OTHER)).toHaveLength(0);
    expect(await transport.list(auth(OTHER))).toEqual([]);
    await expect(
      transport.download(cloud.manifests()[0], auth(OTHER)),
    ).rejects.toThrow();
    expect((await repo.read(owner)).bundle.legacy).toHaveLength(1);
  });

  it("rejects demo payloads and account changes before transferring data", async () => {
    const repo = new ExplanationSyncRepository(
      new IDBFactory(),
      "guarded-account",
    );
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await repo.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    const before = await repo.read(owner);
    const demo = structuredClone(fixture.instructor);
    demo.dataKind = "demo";
    await expect(
      repo.merge(owner, { legacy: [], instructor: [demo] }),
    ).rejects.toThrow();
    await expect(
      syncExplanationLibraries(otherOwner, auth(), config, {
        repository: repo,
        transport,
      }),
    ).rejects.toThrow();
    await expect(
      syncExplanationLibraries(owner, auth(), config, {
        repository: repo,
        transport,
        current: () => false,
      }),
    ).rejects.toThrow();
    expect(cloud.objects.size).toBe(0);
    expect(await repo.read(owner)).toEqual(before);
  });

  it("claims pre-login libraries for one account only and retains local originals", async () => {
    const factory = new IDBFactory(),
      name = "local-claim";
    const legacy = new ExplanationRepository(factory, name);
    await legacy.import(
      "local",
      "real",
      fixture.legacy,
      fixture.source.questions,
      fixture.source.assets,
    );
    const repo = new ExplanationSyncRepository(factory, name);
    await repo.migrateLocal(owner);
    expect((await repo.read(owner)).bundle.legacy).toEqual([fixture.legacy]);
    await repo.migrateLocal(otherOwner);
    expect((await repo.read(otherOwner)).bundle).toEqual(empty());
    expect((await legacy.read("local", "real")).packages).toEqual([
      fixture.legacy,
    ]);
  });

  it("migrates later pre-login updates again to their claimed account only", async () => {
    const factory = new IDBFactory(),
      name = "repeated-local-claim";
    const legacy = new ExplanationRepository(factory, name);
    const modern = new InstructorRepository(factory, name);
    const repo = new ExplanationSyncRepository(factory, name);
    await legacy.import(
      "local",
      "real",
      fixture.legacy,
      fixture.source.questions,
      fixture.source.assets,
    );
    await repo.migrateLocal(owner);
    const afterFirstClaim = await repo.read(owner);
    expect(await repo.migrateLocal(owner)).toBe(false);
    expect(await repo.read(owner)).toEqual(afterFirstClaim);
    const newerLegacy = structuredClone(fixture.legacy);
    newerLegacy.packageVersion++;
    newerLegacy.notes.push("TEST_ONLY imported after logging out");
    await legacy.import(
      "local",
      "real",
      newerLegacy,
      fixture.source.questions,
      fixture.source.assets,
    );
    await repo.migrateLocal(owner);
    expect((await repo.read(owner)).bundle.legacy).toEqual([newerLegacy]);
    await modern.import(
      "local",
      "real",
      fixture.instructor,
      fixture.source.questions,
      fixture.source.assets,
    );
    await repo.migrateLocal(owner);
    const newerInstructor = structuredClone(fixture.instructor);
    newerInstructor.packageVersion++;
    newerInstructor.records[0].revision++;
    newerInstructor.records[0].notes.push(
      "TEST_ONLY later local instructor revision",
    );
    await modern.import(
      "local",
      "real",
      newerInstructor,
      fixture.source.questions,
      fixture.source.assets,
    );
    await repo.migrateLocal(owner);
    expect((await repo.read(owner)).bundle).toEqual({
      legacy: [newerLegacy],
      instructor: [newerInstructor],
    });
    await repo.migrateLocal(otherOwner);
    expect((await repo.read(otherOwner)).bundle).toEqual(empty());
    expect((await modern.read("local", "real")).packages).toEqual([
      newerInstructor,
    ]);
  });

  it("keeps a cleared legacy archive from reappearing after instructor sync", async () => {
    const factory = new IDBFactory(),
      name = "replacement";
    const legacy = new ExplanationRepository(factory, name);
    const modern = new InstructorRepository(factory, name);
    await legacy.import(
      owner,
      "real",
      fixture.legacy,
      fixture.source.questions,
      fixture.source.assets,
    );
    await modern.import(
      owner,
      "real",
      fixture.instructor,
      fixture.source.questions,
      fixture.source.assets,
    );
    const repo = new ExplanationSyncRepository(factory, name);
    await repo.merge(owner, { legacy: [fixture.legacy], instructor: [] });
    expect((await legacy.read(owner, "real")).packages).toEqual([]);
    expect((await modern.read(owner, "real")).packages).toEqual([
      fixture.instructor,
    ]);
  });

  it("lists immutable manifests across every storage page", async () => {
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    for (let i = 0; i < 105; i++) {
      const name = i.toString(16).padStart(64, "0");
      cloud.objects.set(
        `${UID}/real/explanations/manifests/${name}`,
        new Uint8Array(),
      );
    }
    expect(await transport.list(auth())).toHaveLength(105);
    expect(cloud.listOffsets).toEqual([0, 100]);
  });
});

async function imageFixture() {
  const value = structuredClone(fixture.instructor);
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  value.assets.push({
    assetId: "TEST_ONLY_cache_image",
    mimeType: "image/png",
    sha256: digest,
    relativePath: "assets/TEST_ONLY.png",
    byteSize: bytes.length,
    documentId: value.documents[0].documentId,
    questionId: fixture.source.questions[0].id,
    location: value.records[0].locations[0],
    alt: "TEST_ONLY neutral bytes",
    base64: btoa(String.fromCharCode(...bytes)),
  });
  return value;
}
async function rewriteStoredInstructor(
  factory: IDBFactory,
  name: string,
  edit: (stored: any) => void,
) {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction("instructorCollections", "readwrite"),
        store = tx.objectStore("instructorCollections"),
        key = JSON.stringify([owner, "real"]),
        get = store.get(key);
      get.onsuccess = () => {
        edit(get.result);
        store.put(get.result, key);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    };
  });
}

describe("verified unchanged explanation synchronization", () => {
  afterEach(() => vi.restoreAllMocks());
  it("still lists all remote pages without re-reading libraries for every acknowledged manifest", async () => {
    const repo = new ExplanationSyncRepository(
      new IDBFactory(),
      "unchanged-cache",
    );
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await repo.merge(owner, {
      legacy: [fixture.legacy],
      instructor: [fixture.instructor],
    });
    await syncExplanationLibraries(owner, auth(), config, {
      repository: repo,
      transport,
    });
    const before = await repo.readForSync(owner);
    for (let n = 1000; n < 1105; n++) {
      const path =
        UID +
        "/real/explanations/manifests/" +
        n.toString(16).padStart(64, "0");
      cloud.objects.set(path, new Uint8Array());
      await repo.markReceived(owner, path);
    }
    const validate = vi.spyOn(instructorContract, "validateInstructorAssets"),
      raw = vi.spyOn(repo as any, "raw");
    cloud.listOffsets = [];
    await syncExplanationLibraries(owner, auth(), config, {
      repository: repo,
      transport,
    });
    expect(cloud.listOffsets).toEqual([0, 100]);
    expect(validate).not.toHaveBeenCalled();
    expect(raw.mock.calls.length).toBeLessThanOrEqual(3);
    expect((await repo.readForSync(owner)).bundle).toBe(before.bundle);
    expect(cloud.manifests()).toHaveLength(106);
  });
  it("invalidates a checked bundle when another existing repository increments its actual collection generation", async () => {
    const factory = new IDBFactory(),
      name = "old-writer-generation",
      repo = new ExplanationSyncRepository(factory, name),
      writer = new InstructorRepository(factory, name);
    await writer.import(
      owner,
      "real",
      fixture.instructor,
      fixture.source.questions,
      fixture.source.assets,
    );
    const first = await repo.prepareSync(owner);
    expect((await repo.prepareSync(owner)).bundle).toBe(first.bundle);
    const newer = structuredClone(fixture.instructor);
    newer.packageVersion++;
    newer.records[0].revision++;
    newer.records[0].notes.push("TEST_ONLY other writer");
    await writer.import(
      owner,
      "real",
      newer,
      fixture.source.questions,
      fixture.source.assets,
    );
    const second = await repo.prepareSync(owner);
    expect(second.bundle).not.toBe(first.bundle);
    expect(second.bundle.instructor).toEqual([newer]);
    expect((await repo.prepareSync(otherOwner)).bundle).toEqual(empty());
    expect((await repo.prepareSync(owner)).bundle).toBe(second.bundle);
  });
  it("rechecks bytes after an existing writer generation changes even when declared package version and SHA stay the same", async () => {
    const factory = new IDBFactory(),
      name = "changed-image-generation",
      repo = new ExplanationSyncRepository(factory, name);
    await repo.merge(owner, { legacy: [], instructor: [await imageFixture()] });
    await repo.prepareSync(owner);
    await rewriteStoredInstructor(factory, name, (stored) => {
      stored.generation++;
      stored.packages[0].assets[0].base64 = btoa(
        String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 1),
      );
    });
    await expect(repo.prepareSync(owner)).rejects.toThrow("해시");
  });
  it("explicit reads force persisted-content validation and a failure cannot leave a stale trusted cache", async () => {
    const factory = new IDBFactory(),
      name = "forced-integrity-read",
      repo = new ExplanationSyncRepository(factory, name);
    await repo.merge(owner, { legacy: [], instructor: [await imageFixture()] });
    await repo.prepareSync(owner);
    await rewriteStoredInstructor(factory, name, (stored) => {
      // Deliberate out-of-protocol tampering: unchanged generation. An explicit
      // integrity read must not treat that header as a content proof.
      stored.packages[0].assets[0].sha256 = "f".repeat(64);
    });
    await expect(repo.read(owner)).rejects.toThrow("해시");
    await expect(repo.prepareSync(owner)).rejects.toThrow("해시");
  });
  it("caches fingerprints only for recursively frozen parsed content, never caller-declared versions or hashes", async () => {
    const checked = await parseExplanationBundle({
      legacy: [],
      instructor: [await imageFixture()],
    });
    const digest = vi.spyOn(crypto.subtle, "digest");
    const first = await explanationBundleFingerprint(checked);
    expect(await explanationBundleFingerprint(checked)).toBe(first);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(checked.instructor[0].assets[0])).toBe(true);
    const external = structuredClone(checked);
    external.instructor[0].assets[0].sha256 = "f".repeat(64);
    Object.freeze(external);
    await expect(parseExplanationBundle(external)).rejects.toThrow("해시");
    const mutable = structuredClone(checked);
    const old = await explanationBundleFingerprint(mutable);
    mutable.instructor[0].records[0].notes.push(
      "TEST_ONLY changed mutable content",
    );
    expect(await explanationBundleFingerprint(mutable)).not.toBe(old);
  });
  it("does not suppress new remote manifests or later signed-out imports after its unchanged cache is warm", async () => {
    const factory = new IDBFactory(),
      name = "warm-remote-and-local",
      repo = new ExplanationSyncRepository(factory, name),
      legacy = new ExplanationRepository(factory, name);
    const cloud = new FakeStorage(),
      transport = new ExplanationCloudTransport(config, cloud.fetcher);
    await legacy.import(
      "local",
      "real",
      fixture.legacy,
      fixture.source.questions,
      fixture.source.assets,
    );
    await syncExplanationLibraries(owner, auth(), config, {
      repository: repo,
      transport,
    });
    await syncExplanationLibraries(owner, auth(), config, {
      repository: repo,
      transport,
    });
    const newer = structuredClone(fixture.legacy);
    newer.packageVersion++;
    newer.notes.push("TEST_ONLY later local source");
    await legacy.import(
      "local",
      "real",
      newer,
      fixture.source.questions,
      fixture.source.assets,
    );
    await syncExplanationLibraries(owner, auth(), config, {
      repository: repo,
      transport,
    });
    expect((await repo.read(owner)).bundle.legacy).toEqual([newer]);
    const remote = structuredClone(fixture.instructor);
    remote.packageVersion++;
    remote.records[0].revision++;
    remote.records[0].notes.push("TEST_ONLY incoming remote");
    await transport.upload({ legacy: [], instructor: [remote] }, auth());
    await syncExplanationLibraries(owner, auth(), config, {
      repository: repo,
      transport,
    });
    expect((await repo.read(owner)).bundle).toEqual({
      legacy: [newer],
      instructor: [remote],
    });
    expect((await legacy.read("local", "real")).packages).toEqual([newer]);
  });
});

describe("immutable JSON metadata cache fence", () => {
  it("detaches shallow-frozen caller metadata before granting a reusable fingerprint", async () => {
    const nested = { value: "TEST_ONLY original" };
    const instructor = structuredClone(fixture.instructor);
    instructor.compatibility = { external: Object.freeze({ nested }) };
    const checked = await parseExplanationBundle({
      legacy: [],
      instructor: [instructor],
    });
    const before = await explanationBundleFingerprint(checked);
    nested.value = "TEST_ONLY caller mutation";
    expect(
      (checked.instructor[0].compatibility.external as any).nested.value,
    ).toBe("TEST_ONLY original");
    expect(
      Object.isFrozen(
        (checked.instructor[0].compatibility.external as any).nested,
      ),
    ).toBe(true);
    expect(await explanationBundleFingerprint(checked)).toBe(before);
  });
});
