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
  return mergeExplanationBundles(
    { legacy: [], instructor: [] },
    { legacy, instructor },
  );
}
export async function explanationBundleFingerprint(
  bundle: ExplanationBundle,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalExplanationValue(bundle));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
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
  constructor(
    private factory?: IDBFactory,
    private name = "police-original-explanations",
  ) {}
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
    return structuredClone(m);
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
    return parseExplanationBundle(
      mergeExplanationBundles(
        { legacy: archived, instructor: [] },
        { legacy, instructor },
      ),
    );
  }
  async read(owner: string): Promise<ExplanationSyncSnapshot> {
    const raw = await this.raw(owner),
      metadata = this.metadata(raw);
    return {
      generation: metadata.generation,
      bundle: await this.bundle(raw),
      published: metadata.published,
      received: metadata.received,
    };
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
        bundle = await this.bundle(before),
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
        notifyExplanationChange(false);
        return true;
      } catch (e) {
        if (retry === 2 || !(e instanceof Error) || !/다른 창/.test(e.message))
          throw e;
      }
    }
    return false;
  }
  async migrateLocal(owner: string): Promise<boolean> {
    if (!owner || owner === "local")
      throw Error("해설을 연결할 계정이 필요합니다.");
    for (let retry = 0; retry < 3; retry++) {
      const before = await this.raw(owner),
        metadata = this.metadata(before);
      if (before.claim !== undefined && before.claim !== owner) return false;
      const source = await this.raw("local"),
        local = await this.bundle(source);
      if (!local.legacy.length && !local.instructor.length) return false;
      const existing = await this.bundle(before),
        merged = mergeExplanationBundles(existing, local);
      // The claim is permanent, but the same account can reconnect material
      // imported while signed out later. Unchanged copies never schedule work.
      const changed =
        canonicalExplanationValue(merged) !==
          canonicalExplanationValue(existing) ||
        (merged.instructor.length > 0 &&
          ((before.legacy as { packages?: unknown[] })?.packages?.length ?? 0) >
            0);
      if (!changed && before.claim === owner) return false;
      metadata.localMigrated = true;
      if (changed) metadata.generation++;
      try {
        await this.write(owner, before, merged, metadata, owner, source);
        notifyExplanationChange(false);
        return true;
      } catch (e) {
        if (retry === 2 || !(e instanceof Error) || !/다른 창/.test(e.message))
          throw e;
      }
    }
    return false;
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
    (await opening)?.close();
  }
}
