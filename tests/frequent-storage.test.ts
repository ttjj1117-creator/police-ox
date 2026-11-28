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
import { canonicalExplanationValue } from "../src/original/explanations/contract";
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
function reviewedFixture(
  handoffRevision = 1,
  sourceVersion = 1,
  dataKind: "real" | "demo" = "real",
): FrequentIssuesPackage {
  return parseFrequentIssuesPackage({
    ...fixture(sourceVersion, dataKind),
    schemaVersion: "1.1.0",
    handoffRevision,
    canonicalLearningTopics: [],
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

it("updates reviewed semantics on an unchanged source vector and rejects late review revisions", async () => {
  const repo = repository();
  await repo.merge(owner, "real", fixture(1));
  expect(await repo.merge(owner, "real", reviewedFixture(1))).toBe(true);
  expect(await repo.merge(owner, "real", reviewedFixture(2))).toBe(true);
  const before = await repo.read(owner, "real");
  expect(before.handoff).toMatchObject({
    schemaVersion: "1.1.0",
    handoffRevision: 2,
  });
  expect(await repo.merge(owner, "real", reviewedFixture(1))).toBe(false);
  expect(await repo.merge(owner, "real", fixture(1))).toBe(false);
  const equalReview = reviewedFixture(2);
  equalReview.questionIndex[0].eligible = false;
  await expect(repo.merge(owner, "real", equalReview)).rejects.toThrow("충돌");
  await expect(
    repo.merge(owner, "real", reviewedFixture(1, 2)),
  ).rejects.toThrow("충돌");
  await expect(repo.merge(owner, "real", fixture(2))).rejects.toThrow("충돌");
  expect(await repo.read(owner, "real")).toEqual(before);
  expect(await repo.merge(owner, "real", reviewedFixture(3, 2))).toBe(true);
  const blank = reviewedFixture(4, 3);
  blank.questionIndex = [];
  expect(await repo.merge(owner, "real", blank)).toBe(false);
  expect((await repo.read(owner, "real")).handoff).toMatchObject({
    handoffRevision: 3,
  });
});

it("persists v1.1 locally with account claims and namespace isolation", async () => {
  const factory = new IDBFactory(),
    first = repository(factory);
  await first.merge("local", "real", reviewedFixture(2));
  await first.merge("local", "demo", reviewedFixture(3, 1, "demo"));
  expect(await first.migrateLocal(owner)).toBe(true);
  expect(await first.migrateLocal(other)).toBe(false);
  await first.close();
  const reopened = repository(factory);
  expect((await reopened.read(owner, "real")).handoff).toMatchObject({
    schemaVersion: "1.1.0",
    handoffRevision: 2,
  });
  expect((await reopened.read(other, "real")).handoff).toBeNull();
  expect((await reopened.read(owner, "demo")).handoff).toBeNull();
  expect((await reopened.read("local", "demo")).handoff).toMatchObject({
    handoffRevision: 3,
  });
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

function sharedRefreshFixtures() {
  const previous = fixture(),
    refreshed = fixture(),
    reviewed = reviewedFixture(6);
  refreshed.questionIndex[0].eligible = false;
  const previousFingerprint =
      "2b098752b4a7a20ad86c42c3b39a96453d74a32e6b65a81f112ffc8c6c42547e",
    refreshedFingerprint =
      "c7ab680df0bc76e8d466c277f9768979bafc5ec5dd22b9d286552edd944b2242",
    reviewedFingerprint =
      "0999364087a0b7f8d6d295b5063311277ed3bb5914681f65fff00defceaf1a78";
  const fingerprints = new Map([
    [canonicalExplanationValue(previous), previousFingerprint],
    [canonicalExplanationValue(refreshed), refreshedFingerprint],
    [canonicalExplanationValue(reviewed), reviewedFingerprint],
  ]);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
    const fingerprint = fingerprints.get(new TextDecoder().decode(data));
    return fingerprint
      ? Promise.resolve(
          Uint8Array.from(fingerprint.match(/../g)!, (hex) =>
            Number.parseInt(hex, 16),
          ).buffer,
        )
      : digest(algorithm, data);
  });
  return {
    previous,
    refreshed,
    reviewed,
    previousFingerprint,
    refreshedFingerprint,
    reviewedFingerprint,
  };
}

it("refreshes exactly the superseded shared handoff and never uploads the replacement to personal Storage", async () => {
  const repo = repository(),
    remote = transport(),
    { previous, refreshed, previousFingerprint, refreshedFingerprint } =
      sharedRefreshFixtures();
  await repo.merge(owner, "real", previous);
  await repo.mark(owner, "published", previousFingerprint);
  await expect(repo.merge(owner, "real", refreshed)).rejects.toThrow("충돌");
  const before = await repo.read(owner, "real");
  const shared = vi
    .spyOn(SharedLibrary.prototype, "getFrequentIssues")
    .mockResolvedValue(refreshed);
  const options = { repository: repo, transport: remote.value, shared: true };
  await expect(
    syncFrequentIssues(owner, auth, config, options),
  ).resolves.toEqual({ connections: 1 });
  expect(await repo.read(owner, "real")).toEqual({
    ...before,
    generation: before.generation + 1,
    handoff: refreshed,
    published: [previousFingerprint, refreshedFingerprint],
  });
  await syncFrequentIssues(owner, auth, config, options);
  expect(shared).toHaveBeenCalledTimes(2);
  expect(remote.uploadValue).not.toHaveBeenCalled();
});

it.each(["previous", "refreshed"] as const)(
  "upgrades the %s approved shared handoff to the exact reviewed release without personal publication",
  async (release) => {
    const repo = repository(),
      remote = transport(),
      releases = sharedRefreshFixtures(),
      installed = releases[release],
      installedFingerprint =
        release === "previous"
          ? releases.previousFingerprint
          : releases.refreshedFingerprint;
    await repo.merge(owner, "real", installed);
    await repo.mark(owner, "published", installedFingerprint);
    const before = await repo.read(owner, "real");
    const shared = vi
      .spyOn(SharedLibrary.prototype, "getFrequentIssues")
      .mockResolvedValue(releases.reviewed);
    const options = { repository: repo, transport: remote.value, shared: true };
    await expect(
      syncFrequentIssues(owner, auth, config, options),
    ).resolves.toEqual({ connections: 1 });
    expect(await repo.read(owner, "real")).toEqual({
      ...before,
      generation: before.generation + 1,
      handoff: releases.reviewed,
      published: [installedFingerprint, releases.reviewedFingerprint],
    });
    await syncFrequentIssues(owner, auth, config, options);
    expect(shared).toHaveBeenCalledOnce();
    expect(remote.uploadValue).not.toHaveBeenCalled();
  },
);

it("retries a reviewed shared release after failed, missing, stale, empty or unapproved responses", async () => {
  const repo = repository(),
    remote = transport(),
    { previous, refreshed, reviewed, refreshedFingerprint } =
      sharedRefreshFixtures();
  await repo.merge(owner, "real", refreshed);
  await repo.mark(owner, "published", refreshedFingerprint);
  const before = await repo.read(owner, "real"),
    blank = reviewedFixture(7);
  blank.questionIndex = [];
  const shared = vi
    .spyOn(SharedLibrary.prototype, "getFrequentIssues")
    .mockRejectedValueOnce(Error("TEST_ONLY_offline"))
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(previous)
    .mockResolvedValueOnce(refreshed)
    .mockResolvedValueOnce(blank)
    .mockResolvedValueOnce(reviewedFixture(7))
    .mockResolvedValueOnce(reviewed);
  const options = { repository: repo, transport: remote.value, shared: true };
  await expect(
    syncFrequentIssues(owner, auth, config, options),
  ).rejects.toThrow("offline");
  expect(await repo.read(owner, "real")).toEqual(before);
  for (let attempt = 0; attempt < 5; attempt++) {
    await syncFrequentIssues(owner, auth, config, options);
    expect(await repo.read(owner, "real")).toEqual(before);
  }
  await syncFrequentIssues(owner, auth, config, options);
  expect((await repo.read(owner, "real")).handoff).toEqual(reviewed);
  await syncFrequentIssues(owner, auth, config, options);
  expect(shared).toHaveBeenCalledTimes(7);
  expect(remote.uploadValue).not.toHaveBeenCalled();
});

it.each(["missing", "stale", "newer"] as const)(
  "requires the installed shared handoff to match its markers when a marker is %s",
  async (marker) => {
    const repo = repository(),
      {
        refreshed,
        reviewed,
        previousFingerprint,
        refreshedFingerprint,
        reviewedFingerprint,
      } = sharedRefreshFixtures();
    await repo.merge(owner, "real", refreshed);
    if (marker !== "missing")
      await repo.mark(
        owner,
        "published",
        marker === "stale" ? previousFingerprint : refreshedFingerprint,
      );
    if (marker === "newer")
      await repo.mark(owner, "published", reviewedFingerprint);
    const before = await repo.read(owner, "real");
    expect(await repo.shouldReceiveShared(owner, before)).toBe(false);
    expect(await repo.receiveShared(owner, reviewed, () => {})).toBe(false);
    expect(await repo.read(owner, "real")).toEqual(before);
  },
);

it("keeps the installed shared handoff if the pointer is missing, unchanged or unrecognized", async () => {
  const repo = repository(),
    remote = transport(),
    { previous, previousFingerprint } = sharedRefreshFixtures();
  await repo.merge(owner, "real", previous);
  await repo.mark(owner, "published", previousFingerprint);
  const before = await repo.read(owner, "real");
  const unrecognized = fixture();
  unrecognized.questionIndex[0].questionRevision = 2;
  const shared = vi
    .spyOn(SharedLibrary.prototype, "getFrequentIssues")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(previous)
    .mockResolvedValueOnce(unrecognized);
  const options = { repository: repo, transport: remote.value, shared: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    await syncFrequentIssues(owner, auth, config, options);
    expect(await repo.read(owner, "real")).toEqual(before);
  }
  expect(shared).toHaveBeenCalledTimes(3);
  expect(remote.uploadValue).not.toHaveBeenCalled();
});

it.each(["refreshed", "reviewed"] as const)(
  "protects personally imported content and its account-private receipts from the %s shared release",
  async (release) => {
    const releases = sharedRefreshFixtures(),
      { previous, previousFingerprint } = releases;
    const shared = vi
      .spyOn(SharedLibrary.prototype, "getFrequentIssues")
      .mockResolvedValue(releases[release]);
    const personal = fixture();
    personal.questionIndex[0].questionRevision = 2;
    const hadSharedThenImported = repository(),
      priorPrivateImport = repository(),
      claimedLocalImport = repository();
    await hadSharedThenImported.merge(owner, "real", personal);
    await hadSharedThenImported.mark(owner, "published", previousFingerprint);
    await hadSharedThenImported.mark(
      owner,
      "published",
      await frequentIssuesFingerprint(personal),
    );
    for (const repo of [priorPrivateImport, claimedLocalImport]) {
      await repo.merge(owner, "real", previous);
      await repo.mark(owner, "published", previousFingerprint);
    }
    await priorPrivateImport.mark(
      owner,
      "received",
      "TEST_ONLY_private_manifest",
    );
    await claimedLocalImport.merge("local", "real", previous);
    await claimedLocalImport.migrateLocal(owner);
    for (const repo of [
      hadSharedThenImported,
      priorPrivateImport,
      claimedLocalImport,
    ]) {
      const before = await repo.read(owner, "real"),
        remote = transport();
      await syncFrequentIssues(owner, auth, config, {
        repository: repo,
        transport: remote.value,
        shared: true,
      });
      expect(await repo.read(owner, "real")).toEqual(before);
      expect(remote.uploadValue).not.toHaveBeenCalled();
    }
    expect(shared).not.toHaveBeenCalled();
  },
);

it.each(["refreshed", "reviewed"] as const)(
  "checks ownership before saving the %s refresh and lets a concurrent personal import win",
  async (release) => {
    const factory = new IDBFactory(),
      repo = repository(factory),
      otherWindow = repository(factory),
      releases = sharedRefreshFixtures(),
      { previous, previousFingerprint } = releases,
      incoming = releases[release],
      fingerprint =
        release === "refreshed"
          ? releases.refreshedFingerprint
          : releases.reviewedFingerprint;
    await repo.merge(owner, "real", previous);
    await repo.mark(owner, "published", previousFingerprint);
    const before = await repo.read(owner, "real");
    let guardCalls = 0;
    await expect(
      repo.receiveShared(owner, incoming, () => {
        if (++guardCalls === 2) throw Error("TEST_ONLY_account_changed");
      }),
    ).rejects.toThrow("account_changed");
    expect(await repo.read(owner, "real")).toEqual(before);

    guardCalls = 0;
    const personal = fixture(2);
    await expect(
      repo.receiveShared(owner, incoming, async () => {
        if (++guardCalls === 2)
          await otherWindow.merge(owner, "real", personal);
      }),
    ).resolves.toBe(false);
    const result = await repo.read(owner, "real");
    expect(result.handoff).toEqual(personal);
    expect(result.published).not.toContain(fingerprint);
    expect((await repo.read(other, "real")).handoff).toBeNull();
    expect((await repo.read(owner, "demo")).handoff).toBeNull();
  },
);

it.each(["claim", "receipt"] as const)(
  "preserves a concurrent personal %s while a reviewed shared release is committing",
  async (change) => {
    const factory = new IDBFactory(),
      repo = repository(factory),
      otherWindow = repository(factory),
      { refreshed, reviewed, refreshedFingerprint, reviewedFingerprint } =
        sharedRefreshFixtures();
    await repo.merge(owner, "real", refreshed);
    await repo.mark(owner, "published", refreshedFingerprint);
    let guardCalls = 0;
    expect(
      await repo.receiveShared(owner, reviewed, async () => {
        if (++guardCalls !== 2) return;
        if (change === "claim") {
          await otherWindow.merge("local", "real", refreshed);
          await otherWindow.migrateLocal(owner);
        } else {
          await otherWindow.mark(
            owner,
            "received",
            "TEST_ONLY_private_manifest",
          );
        }
      }),
    ).toBe(false);
    const saved = await repo.read(owner, "real");
    expect(saved.handoff).toEqual(refreshed);
    expect(saved.published).not.toContain(reviewedFingerprint);
    expect(await repo.shouldReceiveShared(owner, saved)).toBe(false);
  },
);

it("ignores a late stale shared download after another window installs the reviewed release", async () => {
  const factory = new IDBFactory(),
    repo = repository(factory),
    otherWindow = repository(factory),
    remote = transport(),
    { previous, refreshed, reviewed, previousFingerprint } =
      sharedRefreshFixtures();
  await repo.merge(owner, "real", previous);
  await repo.mark(owner, "published", previousFingerprint);
  let deliver!: (value: FrequentIssuesPackage) => void, started!: () => void;
  const response = new Promise<FrequentIssuesPackage>((resolve) => {
      deliver = resolve;
    }),
    requested = new Promise<void>((resolve) => {
      started = resolve;
    });
  vi.spyOn(SharedLibrary.prototype, "getFrequentIssues").mockImplementation(
    () => {
      started();
      return response;
    },
  );
  const pending = syncFrequentIssues(owner, auth, config, {
    repository: repo,
    transport: remote.value,
    shared: true,
  });
  await requested;
  expect(await otherWindow.receiveShared(owner, reviewed, () => {})).toBe(true);
  const before = await otherWindow.read(owner, "real");
  deliver(refreshed);
  await pending;
  expect(await repo.read(owner, "real")).toEqual(before);
  expect(remote.uploadValue).not.toHaveBeenCalled();
});

it("receives a new reviewed personal revision and preserves it against late older snapshots", async () => {
  const repo = repository(),
    { refreshed, reviewed, refreshedFingerprint, reviewedFingerprint } =
      sharedRefreshFixtures(),
    remote = transport([reviewed, refreshed, reviewedFixture(5)]);
  await repo.merge(owner, "real", refreshed);
  await repo.mark(owner, "published", refreshedFingerprint);
  await syncFrequentIssues(owner, auth, config, {
    repository: repo,
    transport: remote.value,
    shared: true,
  });
  const saved = await repo.read(owner, "real");
  expect(saved.handoff).toEqual(reviewed);
  expect(saved.published).toContain(reviewedFingerprint);
  expect(saved.received).toHaveLength(3);
  expect(await repo.shouldReceiveShared(owner, saved)).toBe(false);
  expect(remote.uploadValue).not.toHaveBeenCalled();
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
