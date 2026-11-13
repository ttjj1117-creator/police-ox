import {
  canonicalExplanationValue,
  explanationIndex,
  mergeExplanationPackages,
  parseExplanationPackage,
  type ExplanationPackage,
} from "./contract";
import {
  mergeInstructorPackages,
  parseInstructorPackage,
  validateInstructorAssets,
  type InstructorPackage,
} from "../instructor/contract";

export interface ExplanationBundle {
  legacy: ExplanationPackage[];
  instructor: InstructorPackage[];
}
export interface ExplanationSyncMetadata {
  generation: number;
  archivedLegacy: ExplanationPackage[];
  published: string[];
  received: string[];
  localMigrated?: boolean;
}
export interface ExplanationSyncSnapshot {
  generation: number;
  bundle: ExplanationBundle;
  published: string[];
  received: string[];
}
// Only independently parsed, recursively frozen content may skip another parse
// or canonical fingerprint. Caller-owned packageVersion/SHA values are not trust.
const checkedBundles = new WeakSet<ExplanationBundle>();
const fingerprints = new WeakMap<ExplanationBundle, Promise<string>>();
function immutableBundle(bundle: ExplanationBundle): ExplanationBundle {
  // Zod's unknown metadata may retain caller-owned references. Copy the JSON
  // object tree before freezing; strings (including Base64) are immutable and
  // need no extra byte conversion. Shallow-frozen input is not a trust marker.
  const copied = new WeakMap<object, unknown>(),
    active = new WeakSet<object>();
  let json = true;
  const copy = (value: unknown): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object") {
      json = false;
      return value;
    }
    if (active.has(value)) json = false; // Cyclic/JS-only metadata is never cached.
    if (copied.has(value)) return copied.get(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      json = false;
      return value;
    }
    active.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const array: unknown[] = [];
      copied.set(value, array);
      for (const item of value) array.push(copy(item));
      result = Object.freeze(array);
    } else {
      const object: Record<string, unknown> = {};
      copied.set(value, object);
      for (const [key, child] of Object.entries(value))
        Object.defineProperty(object, key, {
          value: copy(child),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      result = Object.freeze(object);
    }
    active.delete(value);
    return result;
  };
  const result = copy(bundle) as ExplanationBundle;
  // Preserve the pre-existing behavior for in-memory non-JSON metadata, but
  // grant it neither a validated immutable brand nor a fingerprint cache.
  if (!json) return bundle;
  checkedBundles.add(result);
  return result;
}
export const explanationSyncKey = (owner: string) =>
  `explanation-sync:${owner}`;
export const explanationLibraryKey = (owner: string) =>
  JSON.stringify([owner, "real"]);
const claimKey = "explanation-sync:local-owner-claim";
const emptyMetadata = (): ExplanationSyncMetadata => ({
  generation: 0,
  archivedLegacy: [],
  published: [],
  received: [],
});
export function notifyExplanationChange(local = true) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("police-explanations-changed"));
    if (local) {
      window.dispatchEvent(new Event("police-sync-local"));
      window.dispatchEvent(new Event("police-explanations-local"));
    }
  }
}
/** Preserve historical packages without downgrading a newer package. Equal-version
 * differences remain conflicts, rather than selecting whichever device arrives last. */
export function mergeExplanationBundles(
  before: ExplanationBundle,
  incoming: ExplanationBundle,
): ExplanationBundle {
  let legacy = before.legacy,
    instructor = before.instructor;
  for (const p of incoming.legacy) {
    const old = legacy.find((x) => x.packageId === p.packageId);
    if (old && old.packageVersion > p.packageVersion) continue;
    legacy = mergeExplanationPackages(legacy, p);
  }
  for (const p of incoming.instructor) {
    const old = instructor.find((x) => x.packageId === p.packageId);
    if (old && old.packageVersion > p.packageVersion) continue;
    instructor = mergeInstructorPackages(instructor, p);
  }
  return {
    legacy: [...legacy].sort((a, b) => a.packageId.localeCompare(b.packageId)),
    instructor: [...instructor].sort((a, b) =>
      a.packageId.localeCompare(b.packageId),
    ),
  };
}
export async function parseExplanationBundle(
  value: unknown,
): Promise<ExplanationBundle> {
  const v = value as ExplanationBundle;
  if (checkedBundles.has(v)) return v;
  if (
    !v ||
    !Array.isArray(v.legacy) ||
    !Array.isArray(v.instructor) ||
    Object.keys(v).some((k) => k !== "legacy" && k !== "instructor")
  )
    throw Error("해설 동기화 자료 형식이 다릅니다.");
  const legacy = v.legacy.map(parseExplanationPackage),
    instructor = v.instructor.map(parseInstructorPackage);
  if ([...legacy, ...instructor].some((p) => p.dataKind !== "real"))
    throw Error("시연 해설은 실제 계정에 동기화하지 않습니다.");
  explanationIndex(legacy);
  for (const p of instructor) await validateInstructorAssets(p);
  // Question matching is checked again by the existing display resolvers. A bank
  // edited after import must not destroy a valid historical explanation archive.
  return immutableBundle(
    mergeExplanationBundles(
      { legacy: [], instructor: [] },
      { legacy, instructor },
    ),
  );
}
export async function explanationBundleFingerprint(
  bundle: ExplanationBundle,
): Promise<string> {
  const cached = checkedBundles.has(bundle)
    ? fingerprints.get(bundle)
    : undefined;
  if (cached) return cached;
  const pending = (async () => {
    const bytes = new TextEncoder().encode(canonicalExplanationValue(bundle));
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  })();
  if (checkedBundles.has(bundle)) {
    fingerprints.set(bundle, pending);
    void pending.catch(() => fingerprints.delete(bundle));
  }
  return pending;
}

type RawSnapshot = {
  legacy: unknown;
  instructor: unknown;
  metadata: unknown;
  claim?: unknown;
};
/** Uses the existing two stores. No database upgrade, question-state change or
 * new credentials copy is necessary. All library writes compare their snapshot. */
export class ExplanationSyncRepository {
  private opening?: Promise<IDBDatabase>;
  private checked = new Map<
    string,
    { version: string; value: Promise<ExplanationBundle> }
  >();
  private migrations = new Map<
    string,
    { source: string; destination: string }
  >();
  constructor(
    private factory?: IDBFactory,
    private name = "police-original-explanations",
    private readonly onChanged?: (owner: string) => void,
  ) {}
  private changed(owner: string): void {
    if (this.onChanged) this.onChanged(owner);
    else notifyExplanationChange(false);
  }
  private db() {
    return (this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = (this.factory ?? indexedDB).open(this.name, 2);
      r.onupgradeneeded = () => {
        for (const s of ["collections", "instructorCollections"])
          if (!r.result.objectStoreNames.contains(s))
            r.result.createObjectStore(s);
      };
      r.onerror = () => {
        this.opening = undefined;
        reject(r.error);
      };
      r.onblocked = () => {
        this.opening = undefined;
        reject(Error("다른 창의 해설 저장소를 닫고 다시 시도하세요."));
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => {
          r.result.close();
          this.opening = undefined;
        };
        resolve(r.result);
      };
    }));
  }
  private async raw(owner: string): Promise<RawSnapshot> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction(
          ["collections", "instructorCollections"],
          "readonly",
        ),
        s = t.objectStore("collections"),
        key = explanationLibraryKey(owner);
      const l = s.get(key),
        i = t.objectStore("instructorCollections").get(key),
        m = s.get(explanationSyncKey(owner)),
        c = s.get(claimKey);
      t.oncomplete = () =>
        resolve({
          legacy: l.result,
          instructor: i.result,
          metadata: m.result,
          claim: c.result,
        });
      t.onerror = t.onabort = () =>
        reject(t.error ?? Error("해설 동기화 자료 읽기 실패"));
    });
  }
  private metadata(raw: RawSnapshot): ExplanationSyncMetadata {
    if (raw.metadata === undefined) return emptyMetadata();
    const m = raw.metadata as ExplanationSyncMetadata;
    if (
      !Number.isSafeInteger(m.generation) ||
      m.generation < 0 ||
      !Array.isArray(m.archivedLegacy) ||
      !Array.isArray(m.published) ||
      !Array.isArray(m.received)
    )
      throw Error(
        "해설 동기화 보관 자료를 읽을 수 없습니다. 원본은 보존됩니다.",
      );
    // These IDB snapshots are already detached. Copy mutable metadata arrays,
    // but do not deep-copy the complete archived source on every inspection.
    return { ...m, published: [...m.published], received: [...m.received] };
  }
  private async bundle(raw: RawSnapshot): Promise<ExplanationBundle> {
    const packages = (value: unknown): unknown[] => {
      if (value === undefined) return [];
      const v = value as { generation: number; packages: unknown[] };
      if (
        !Number.isSafeInteger(v?.generation) ||
        v.generation < 0 ||
        !Array.isArray(v.packages)
      )
        throw Error("저장된 해설을 읽을 수 없습니다. 원본은 보존됩니다.");
      return v.packages;
    };
    const metadata = this.metadata(raw);
    const legacy = packages(raw.legacy).map(parseExplanationPackage);
    const archived = metadata.archivedLegacy.map(parseExplanationPackage);
    const instructor = packages(raw.instructor).map(parseInstructorPackage);
    // These packages have already passed their complete schemas above.
    // Preserve bundle-level namespace/index/asset checks without parsing and
    // merging the same 33+ MiB payload for a second time.
    const merged = mergeExplanationBundles(
      { legacy: archived, instructor: [] },
      { legacy, instructor },
    );
    if (
      [...merged.legacy, ...merged.instructor].some(
        (p) => p.dataKind !== "real",
      )
    )
      throw Error("시연 해설은 실제 계정에 동기화하지 않습니다.");
    explanationIndex(merged.legacy);
    for (const p of merged.instructor) await validateInstructorAssets(p);
    return immutableBundle(merged);
  }
  /** Existing and older writers increment these collection generations. Read
   * their actual IDB headers, never an external package's declared version/hash.
   * Raw IO still copies the collection payload; this cache removes repeated
   * schema/merge/asset/canonical work without changing the storage contract. */
  private version(raw: RawSnapshot): string {
    const generation = (value: unknown): number => {
      if (value === undefined) return -1;
      const library = value as { generation: number; packages: unknown[] };
      if (
        !Number.isSafeInteger(library?.generation) ||
        library.generation < 0 ||
        !Array.isArray(library.packages)
      )
        throw Error("저장된 해설을 읽을 수 없습니다. 원본은 보존됩니다.");
      return library.generation;
    };
    return JSON.stringify([
      generation(raw.legacy),
      generation(raw.instructor),
      this.metadata(raw).generation,
    ]);
  }
  private cachedBundle(
    owner: string,
    raw: RawSnapshot,
    force = false,
  ): Promise<ExplanationBundle> {
    const version = this.version(raw),
      cached = this.checked.get(owner);
    if (!force && cached?.version === version) return cached.value;
    const entry = { version, value: this.bundle(raw) };
    this.checked.set(owner, entry);
    void entry.value.then(
      (bundle) => {
        if (!checkedBundles.has(bundle) && this.checked.get(owner) === entry)
          this.checked.delete(owner);
      },
      () => {
        if (this.checked.get(owner) === entry) this.checked.delete(owner);
      },
    );
    return entry.value;
  }
  private async snapshot(
    owner: string,
    raw: RawSnapshot,
    force = false,
  ): Promise<ExplanationSyncSnapshot> {
    const metadata = this.metadata(raw);
    return {
      generation: metadata.generation,
      bundle: await this.cachedBundle(owner, raw, force),
      published: metadata.published,
      received: metadata.received,
    };
  }
  /** Explicit reads revalidate persisted content, including administrative or
   * integrity checks. Only the controlled synchronization path reuses a cache. */
  async read(owner: string): Promise<ExplanationSyncSnapshot> {
    return this.snapshot(owner, await this.raw(owner), true);
  }
  async readForSync(owner: string): Promise<ExplanationSyncSnapshot> {
    return this.snapshot(owner, await this.raw(owner));
  }
  async prepareSync(owner: string): Promise<ExplanationSyncSnapshot> {
    const migrated = await this.migrateLocalSnapshot(owner);
    return this.snapshot(owner, migrated.raw);
  }
  private async write(
    owner: string,
    before: RawSnapshot,
    bundle: ExplanationBundle,
    metadata: ExplanationSyncMetadata,
    claim?: string,
    source?: RawSnapshot,
  ) {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const t = db.transaction(
          ["collections", "instructorCollections"],
          "readwrite",
        ),
        s = t.objectStore("collections"),
        i = t.objectStore("instructorCollections"),
        key = explanationLibraryKey(owner);
      const l = s.get(key),
        r = i.get(key),
        m = s.get(explanationSyncKey(owner)),
        c = s.get(claimKey);
      const sourceReads = source
        ? [
            s.get(explanationLibraryKey("local")),
            i.get(explanationLibraryKey("local")),
            s.get(explanationSyncKey("local")),
          ]
        : [];
      let count = 0,
        conflict = false;
      const finish = () => {
        if (++count < 4 + sourceReads.length) return;
        if (
          canonicalExplanationValue({
            legacy: l.result,
            instructor: r.result,
            metadata: m.result,
            claim: c.result,
          }) !== canonicalExplanationValue(before) ||
          (source &&
            canonicalExplanationValue({
              legacy: sourceReads[0].result,
              instructor: sourceReads[1].result,
              metadata: sourceReads[2].result,
              claim: c.result,
            }) !== canonicalExplanationValue(source))
        ) {
          conflict = true;
          t.abort();
          return;
        }
        // An instructor import retires the former format on all devices. Keep
        // its complete original in metadata and immutable cloud manifests.
        const legacy = bundle.instructor.length ? [] : bundle.legacy;
        const putLibrary = (
          store: IDBObjectStore,
          old: unknown,
          packages: unknown[],
        ) => {
          const previous = old as
            | { generation?: number; packages?: unknown[] }
            | undefined;
          if (
            canonicalExplanationValue(previous?.packages ?? []) !==
            canonicalExplanationValue(packages)
          )
            store.put(
              { generation: (previous?.generation ?? 0) + 1, packages },
              key,
            );
        };
        putLibrary(s, l.result, legacy);
        putLibrary(i, r.result, bundle.instructor);
        metadata.archivedLegacy = bundle.instructor.length ? bundle.legacy : [];
        s.put(metadata, explanationSyncKey(owner));
        if (claim) s.put(claim, claimKey);
      };
      for (const request of [l, r, m, c, ...sourceReads])
        request.onsuccess = finish;
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () =>
        reject(
          conflict
            ? Error("다른 창에서 해설이 바뀌었습니다. 다시 동기화하세요.")
            : (t.error ??
                Error("해설 동기화 저장 실패 · 기존 자료는 보존됩니다.")),
        );
    });
  }
  async merge(owner: string, incoming: ExplanationBundle): Promise<boolean> {
    const checked = await parseExplanationBundle(incoming);
    for (let retry = 0; retry < 3; retry++) {
      const before = await this.raw(owner),
        bundle = await this.cachedBundle(owner, before),
        next = mergeExplanationBundles(bundle, checked),
        metadata = this.metadata(before);
      const changed =
        canonicalExplanationValue(next) !== canonicalExplanationValue(bundle) ||
        (next.instructor.length > 0 &&
          ((before.legacy as { packages?: unknown[] })?.packages?.length ?? 0) >
            0);
      if (!changed) return false;
      metadata.generation++;
      try {
        await this.write(owner, before, next, metadata);
        this.changed(owner);
        return true;
      } catch (e) {
        if (retry === 2 || !(e instanceof Error) || !/다른 창/.test(e.message))
          throw e;
      }
    }
    return false;
  }
  async seedShared(owner: string, incoming: ExplanationBundle, guard: () => Promise<void>) {
    const checked = await parseExplanationBundle(incoming);
    if (!checked.legacy.length && !checked.instructor.length) return;
    const fingerprint = await explanationBundleFingerprint(checked);
    for (let retry = 0; retry < 3; retry++) {
      const before = await this.raw(owner);
      const existing = await this.cachedBundle(owner, before);
      if (existing.legacy.length || existing.instructor.length) return;
      const metadata = this.metadata(before);
      metadata.generation++;
      // This release can be fetched directly on each device. Seed copies do not
      // need an additional upload into this learner's private object store.
      metadata.published.push(fingerprint);
      await guard();
      try {
        await this.write(owner, before, checked, metadata);
        this.changed(owner);
        return;
      } catch (error) {
        if (retry === 2 || !(error instanceof Error) || !/다른 창/.test(error.message))
          throw error;
      }
    }
  }
  async migrateLocal(owner: string): Promise<boolean> {
    return (await this.migrateLocalSnapshot(owner)).changed;
  }
  private async migrateLocalSnapshot(
    owner: string,
  ): Promise<{ changed: boolean; raw: RawSnapshot }> {
    if (!owner || owner === "local")
      throw Error("해설을 연결할 계정이 필요합니다.");
    for (let retry = 0; retry < 3; retry++) {
      const before = await this.raw(owner);
      if (before.claim !== undefined && before.claim !== owner)
        return { changed: false, raw: before };
      const source = await this.raw("local"),
        sourceVersion = this.version(source),
        destinationVersion =
          this.version(before) + JSON.stringify(before.claim ?? null),
        previous = this.migrations.get(owner);
      if (
        previous?.source === sourceVersion &&
        previous.destination === destinationVersion
      )
        return { changed: false, raw: before };
      const remember = () =>
        this.migrations.set(owner, {
          source: sourceVersion,
          destination: destinationVersion,
        });
      const local = await this.cachedBundle("local", source);
      if (!local.legacy.length && !local.instructor.length) {
        remember();
        return { changed: false, raw: before };
      }
      const existing = await this.cachedBundle(owner, before),
        merged = mergeExplanationBundles(existing, local),
        metadata = this.metadata(before);
      // The existing permanent claim is unchanged. Later signed-out imports
      // increment the source's real stored generation and re-enter this merge.
      const changed =
        canonicalExplanationValue(merged) !==
          canonicalExplanationValue(existing) ||
        (merged.instructor.length > 0 &&
          ((before.legacy as { packages?: unknown[] })?.packages?.length ?? 0) >
            0);
      if (!changed && before.claim === owner) {
        remember();
        return { changed: false, raw: before };
      }
      metadata.localMigrated = true;
      if (changed) metadata.generation++;
      try {
        await this.write(owner, before, merged, metadata, owner, source);
        if (changed) this.changed(owner);
        return { changed: true, raw: await this.raw(owner) };
      } catch (e) {
        if (retry === 2 || !(e instanceof Error) || !/다른 창/.test(e.message))
          throw e;
      }
    }
    throw Error("해설 연결을 저장하지 못했습니다.");
  }
  async markPublished(owner: string, fingerprint: string) {
    await this.mark(owner, "published", fingerprint);
  }
  async markReceived(owner: string, path: string) {
    await this.mark(owner, "received", path);
  }
  private async mark(
    owner: string,
    type: "published" | "received",
    value: string,
  ) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("collections", "readwrite"),
        s = t.objectStore("collections"),
        r = s.get(explanationSyncKey(owner));
      r.onsuccess = () => {
        const m =
          (r.result as ExplanationSyncMetadata | undefined) ?? emptyMetadata();
        if (!m[type].includes(value)) {
          m[type].push(value);
          s.put(m, explanationSyncKey(owner));
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () =>
        reject(t.error ?? Error("해설 전송 확인 저장 실패"));
    });
  }
  async close() {
    const opening = this.opening;
    this.opening = undefined;
    this.checked.clear();
    this.migrations.clear();
    (await opening)?.close();
  }
}
