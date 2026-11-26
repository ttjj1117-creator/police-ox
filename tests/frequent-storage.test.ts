import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import {
  FrequentIssuesRepository,
  mergeFrequentIssuesPackages,
  frequentIssuesFingerprint,
} from "../src/original/frequent/library";
import { syncFrequentIssues } from "../src/original/frequent/sync";
import {
  parseFrequentIssuesPackage,
  type FrequentIssuesPackage,
} from "../src/original/frequent/contract";
import { SharedLibrary } from "../src/original/sync/shared-library";
import type { ExplanationCloudTransport } from "../src/original/explanations/sync-transport";

const config = {
  url: "https://frequent.example.invalid",
  key: "sb_publishable_TEST",
};
const auth = {
  access_token: "TEST_ONLY_token",
  refresh_token: "TEST_ONLY_refresh",
  expires_at: 2_000_000_000,
  user: { id: "11111111-1111-4111-8111-111111111111" },
};
const owner = `${config.url}|${auth.user.id}`,
  other = `${config.url}|22222222-2222-4222-8222-222222222222`;
const repositories: FrequentIssuesRepository[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    repositories.splice(0).map((repository) => repository.close()),
  );
});
function repository(factory = new IDBFactory(), name = "frequent-test") {
  const result = new FrequentIssuesRepository(factory, name, vi.fn());
  repositories.push(result);
  return result;
}
function fixture(
  version = 1,
  dataKind: "real" | "demo" = "real",
): FrequentIssuesPackage {
  return parseFrequentIssuesPackage({
    format: "police-frequent-issues-handoff",
    schemaVersion: "1.0.0",
    dataKind,
    inputPackages: Object.fromEntries(
      ["questions", "legacy", "instructor"].map((kind) => [
        kind,
        {
          packageId: `TEST_ONLY_${kind}`,
          packageVersion: version,
          schemaVersion: "1.0.0",
        },
      ]),
    ),
    questionIndex: [
      {
        questionId: "TEST_ONLY_question",
        sourceKey: [
          dataKind === "demo" ? "demo" : "po",
          "police",
          2026,
          "1",
          1,
        ],
        subjectId: "police",
        questionRevision: 1,
        gradingRevision: 1,
        questionFingerprint: "a".repeat(64),
        eligible: true,
        classification: null,
      },
    ],
    legacyVerifiedLinks: [],
    authorityCatalog: [],
    legacyCatalog: { bases: [], issues: [] },
    sourceCitationOccurrences: [],
    reviewedLearningTopics: [],
  });
}
function transport(values: unknown[] = []) {
  const paths = values.map(
    (_, index) =>
      `${auth.user.id}/real/frequent-issues/manifests/${String(index).repeat(64)}`,
  );
  const list = vi.fn().mockResolvedValue(paths);
  const downloadValue = vi.fn(
    async (path: string) => values[paths.indexOf(path)],
  );
  const uploadValue = vi
    .fn()
    .mockResolvedValue(
      `${auth.user.id}/real/frequent-issues/manifests/${"b".repeat(64)}`,
    );
  return {
    value: {
      list,
      downloadValue,
      uploadValue,
    } as unknown as ExplanationCloudTransport,
    list,
    downloadValue,
    uploadValue,
  };
}

it("keeps absent, empty and lower-version snapshots from replacing existing connections", async () => {
  const repo = repository(),
    current = fixture(3),
    blank = fixture(4);
  blank.questionIndex = [];
  await repo.merge(owner, "real", current);
  const before = await repo.read(owner, "real");
  expect(mergeFrequentIssuesPackages(before.handoff, null)).toBe(
    before.handoff,
  );
  expect(await repo.merge(owner, "real", blank)).toBe(false);
  expect(await repo.merge(owner, "real", fixture(1))).toBe(false);
  expect(await repo.read(owner, "real")).toEqual(before);
  const emptyDevice = repository();
  expect(await emptyDevice.merge(owner, "real", blank)).toBe(false);
  expect((await emptyDevice.read(owner, "real")).handoff).toBeNull();
});

it("rejects equal, mixed or unrelated source revisions while preserving stored data", async () => {
  const repo = repository();
  await repo.merge(owner, "real", fixture(2));
  const before = await repo.read(owner, "real"),
    equal = fixture(2);
  equal.questionIndex[0].eligible = false;
  await expect(repo.merge(owner, "real", equal)).rejects.toThrow("충돌");
  const mixed = fixture(2);
  mixed.inputPackages.legacy.packageVersion = 3;
  mixed.inputPackages.instructor.packageVersion = 1;
  await expect(repo.merge(owner, "real", mixed)).rejects.toThrow("충돌");
  const unrelated = fixture(3);
  unrelated.inputPackages.questions.packageId = "TEST_ONLY_other_bank";
  await expect(repo.merge(owner, "real", unrelated)).rejects.toThrow(
    "다른 원천",
  );
  expect(await repo.read(owner, "real")).toEqual(before);
});

it("uses compare-and-swap across concurrent imports and leaves the newest complete source vector", async () => {
  const factory = new IDBFactory(),
    left = repository(factory),
    right = repository(factory);
  await left.merge(owner, "real", fixture(1));
  await Promise.all([
    left.merge(owner, "real", fixture(2)),
    right.merge(owner, "real", fixture(3)),
  ]);
  expect(
    (await left.read(owner, "real")).handoff?.inputPackages.legacy
      .packageVersion,
  ).toBe(3);
});

it("isolates accounts and demo data and permanently claims local real imports for one account", async () => {
  const repo = repository();
  await repo.merge("local", "real", fixture(1));
  await repo.merge("local", "demo", fixture(1, "demo"));
  expect(await repo.migrateLocal(owner)).toBe(true);
  expect(await repo.migrateLocal(other)).toBe(false);
  expect((await repo.read(other, "real")).handoff).toBeNull();
  expect((await repo.read(owner, "demo")).handoff).toBeNull();
  await expect(repo.merge(owner, "real", fixture(1, "demo"))).rejects.toThrow(
    "자료 영역",
  );
  await repo.merge("local", "real", fixture(2));
  expect(await repo.migrateLocal(owner)).toBe(true);
  expect(
    (await repo.read(owner, "real")).handoff?.inputPackages.legacy
      .packageVersion,
  ).toBe(2);
});

it("reopens offline data without depending on the original import object", async () => {
  const factory = new IDBFactory(),
    first = repository(factory),
    input = fixture();
  await first.merge(owner, "real", input);
  input.questionIndex[0].eligible = false;
  await first.close();
  const next = repository(factory);
  expect(
    (await next.read(owner, "real")).handoff?.questionIndex[0].eligible,
  ).toBe(true);
});

it("revalidates explicit persisted reads even if out-of-protocol tampering retained the generation", async () => {
  const factory = new IDBFactory(),
    repo = repository(factory);
  await repo.merge(owner, "real", fixture());
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("frequent-test", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("collections", "readwrite"),
      store = transaction.objectStore("collections"),
      key = JSON.stringify([owner, "real"]);
    const request = store.get(key);
    request.onsuccess = () => {
      const value = request.result;
      value.handoff.format = "TEST_ONLY_corrupt";
      store.put(value, key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
  await expect(repo.read(owner, "real")).rejects.toThrow();
});

it("does not publish an empty device or change existing data on failed or cancelled downloads", async () => {
  const repo = repository(),
    blank = transport();
  await expect(
    syncFrequentIssues(owner, auth, config, {
      repository: repo,
      transport: blank.value,
    }),
  ).resolves.toEqual({ connections: 0 });
  expect(blank.uploadValue).not.toHaveBeenCalled();
  await repo.merge(owner, "real", fixture());
  const before = await repo.read(owner, "real"),
    remote = transport([fixture(2)]);
  remote.downloadValue.mockRejectedValueOnce(Error("TEST_ONLY_offline"));
  await expect(
    syncFrequentIssues(owner, auth, config, {
      repository: repo,
      transport: remote.value,
    }),
  ).rejects.toThrow("offline");
  expect(await repo.read(owner, "real")).toEqual(before);
  let current = true;
  remote.downloadValue.mockImplementationOnce(async () => {
    current = false;
    return fixture(2);
  });
  await expect(
    syncFrequentIssues(owner, auth, config, {
      repository: repo,
      transport: remote.value,
      current: () => current,
    }),
  ).rejects.toThrow("계정");
  expect(await repo.read(owner, "real")).toEqual(before);
  expect(remote.uploadValue).not.toHaveBeenCalled();
});

it("syncs independent immutable connection manifests without republishing received or shared content", async () => {
  const repo = repository(),
    remote = transport([fixture(1), fixture(2)]);
  await expect(
    syncFrequentIssues(owner, auth, config, {
      repository: repo,
      transport: remote.value,
    }),
  ).resolves.toEqual({ connections: 1 });
  const saved = await repo.read(owner, "real");
  expect(saved.received).toHaveLength(2);
  expect(saved.handoff?.inputPackages.legacy.packageVersion).toBe(2);
  expect(remote.uploadValue).not.toHaveBeenCalled();
  await syncFrequentIssues(owner, auth, config, {
    repository: repo,
    transport: remote.value,
  });
  expect(remote.downloadValue).toHaveBeenCalledTimes(2);
  const second = repository(),
    emptyRemote = transport();
  const shared = vi
    .spyOn(SharedLibrary.prototype, "getFrequentIssues")
    .mockResolvedValue(fixture(2));
  await syncFrequentIssues(owner, auth, config, {
    repository: second,
    transport: emptyRemote.value,
    shared: true,
  });
  expect(shared).toHaveBeenCalledOnce();
  expect((await second.read(owner, "real")).handoff).toEqual(fixture(2));
  expect(emptyRemote.uploadValue).not.toHaveBeenCalled();
});

it("publishes a local import once and rejects a mismatched account before any transfer", async () => {
  const repo = repository(),
    remote = transport();
  await repo.merge(owner, "real", fixture());
  await syncFrequentIssues(owner, auth, config, {
    repository: repo,
    transport: remote.value,
  });
  expect(remote.uploadValue).toHaveBeenCalledOnce();
  expect((await repo.read(owner, "real")).published).toContain(
    await frequentIssuesFingerprint(fixture()),
  );
  await syncFrequentIssues(owner, auth, config, {
    repository: repo,
    transport: remote.value,
  });
  expect(remote.uploadValue).toHaveBeenCalledOnce();
  await expect(
    syncFrequentIssues(other, auth, config, {
      repository: repo,
      transport: remote.value,
    }),
  ).rejects.toThrow("계정");
  expect((await repo.read(other, "real")).handoff).toBeNull();
});

it("checks the scope after shared delivery and immediately before committing a local merge", async () => {
  const repo = repository(),
    remote = transport();
  let current = true;
  vi.spyOn(SharedLibrary.prototype, "getFrequentIssues").mockImplementation(
    async () => {
      current = false;
      return fixture();
    },
  );
  await expect(
    syncFrequentIssues(owner, auth, config, {
      repository: repo,
      transport: remote.value,
      shared: true,
      current: () => current,
    }),
  ).rejects.toThrow("계정");
  expect((await repo.read(owner, "real")).handoff).toBeNull();
  expect(remote.uploadValue).not.toHaveBeenCalled();
  let checkpoints = 0;
  await expect(
    repo.merge(owner, "real", fixture(), async () => {
      if (++checkpoints >= 2)
        throw Error("TEST_ONLY_scope_changed_before_commit");
    }),
  ).rejects.toThrow("scope_changed");
  expect((await repo.read(owner, "real")).handoff).toBeNull();
});

it("checks the scope after awaited fingerprint hashing before uploading a local handoff", async () => {
  const repo = repository(),
    remote = transport();
  await repo.merge(owner, "real", fixture());
  let current = true;
  const original = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (algorithm, data) => {
      const result = await original(algorithm, data);
      current = false;
      return result;
    },
  );
  await expect(
    syncFrequentIssues(owner, auth, config, {
      repository: repo,
      transport: remote.value,
      current: () => current,
    }),
  ).rejects.toThrow("계정");
  expect(remote.uploadValue).not.toHaveBeenCalled();
  const saved = await repo.read(owner, "real");
  expect(saved.published).toEqual([]);
  expect(saved.received).toEqual([]);
});
