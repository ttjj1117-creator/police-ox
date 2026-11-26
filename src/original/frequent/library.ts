import { useEffect, useRef, useState } from "react";
import type { Namespace } from "../model";
import { canonicalExplanationValue } from "../explanations/contract";
import { notifyExplanationChange } from "../explanations/sync";
import {
  parseFrequentIssuesPackage,
  type FrequentIssuesPackage,
} from "./contract";

export interface FrequentIssuesLibrary {
  generation: number;
  handoff: FrequentIssuesPackage | null;
  published: string[];
  received: string[];
}
interface StoredLibrary extends FrequentIssuesLibrary {
  revision: number;
}
type Guard = () => void | Promise<void>;
const checked = new WeakSet<FrequentIssuesPackage>();
const fingerprints = new WeakMap<FrequentIssuesPackage, Promise<string>>();
const empty = (): StoredLibrary => ({
  generation: 0,
  revision: 0,
  handoff: null,
  published: [],
  received: [],
});
const keyOf = (owner: string, namespace: Namespace) =>
  JSON.stringify([owner, namespace]);
const claimKey = "frequent-issues:local-owner-claim";
const same = (a: unknown, b: unknown) =>
  canonicalExplanationValue(a) === canonicalExplanationValue(b);

function immutablePackage(value: unknown): FrequentIssuesPackage {
  if (
    value &&
    typeof value === "object" &&
    checked.has(value as FrequentIssuesPackage)
  )
    return value as FrequentIssuesPackage;
  const result = structuredClone(parseFrequentIssuesPackage(value));
  const freeze = (object: unknown): void => {
    if (!object || typeof object !== "object" || Object.isFrozen(object))
      return;
    for (const child of Object.values(object)) freeze(child);
    Object.freeze(object);
  };
  freeze(result);
  checked.add(result);
  return result;
}

export function frequentIssuesFingerprint(
  value: FrequentIssuesPackage,
): Promise<string> {
  const handoff = immutablePackage(value);
  const previous = fingerprints.get(handoff);
  if (previous) return previous;
  const pending = (async () => {
    const bytes = new TextEncoder().encode(canonicalExplanationValue(handoff));
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  })();
  fingerprints.set(handoff, pending);
  void pending.catch(() => fingerprints.delete(handoff));
  return pending;
}

/** A handoff has a source-package version vector, not a last-writer timestamp.
 * Omitted/older data never deletes a connection, and ambiguous revisions fail closed. */
export function mergeFrequentIssuesPackages(
  before: FrequentIssuesPackage | null,
  incoming: FrequentIssuesPackage | null,
): FrequentIssuesPackage | null {
  if (!incoming) return before;
  if (!incoming.questionIndex.length) return before;
  if (!before || same(before, incoming)) return before ?? incoming;
  if (before.dataKind !== incoming.dataKind)
    throw Error("빈출 쟁점 자료 영역이 다릅니다. 기존 자료는 보존됩니다.");
  let lower = false,
    higher = false;
  for (const kind of ["questions", "legacy", "instructor"] as const) {
    const old = before.inputPackages[kind],
      next = incoming.inputPackages[kind];
    if (
      old.packageId !== next.packageId ||
      old.schemaVersion !== next.schemaVersion
    )
      throw Error("다른 원천의 빈출 쟁점 연결입니다. 기존 자료는 보존됩니다.");
    lower ||= next.packageVersion < old.packageVersion;
    higher ||= next.packageVersion > old.packageVersion;
  }
  if (lower && !higher) return before;
  if (higher && !lower) return incoming;
  throw Error(
    "같은 버전 또는 서로 엇갈린 버전의 빈출 쟁점 연결이 충돌합니다. 기존 자료는 보존됩니다.",
  );
}

/** Separate storage lets already-installed explanation clients keep working
 * without rewriting or erasing a field they do not understand. */
export class FrequentIssuesRepository {
  private opening?: Promise<IDBDatabase>;
  private validated = new Map<
    string,
    { generation: number; handoff: FrequentIssuesPackage | null }
  >();
  constructor(
    private readonly factory?: IDBFactory,
    private readonly name = "police-original-frequent-issues",
    private readonly onChanged: () => void = () => notifyExplanationChange(),
  ) {}
  private db(): Promise<IDBDatabase> {
    return (this.opening ??= new Promise((resolve, reject) => {
      const request = (this.factory ?? indexedDB).open(this.name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("collections");
      request.onerror = () => {
        this.opening = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        this.opening = undefined;
        reject(Error("다른 창의 빈출 쟁점 저장소를 닫고 다시 시도하세요."));
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.opening = undefined;
        };
        resolve(request.result);
      };
    }));
  }
  private async raw(
    owner: string,
    namespace: Namespace,
  ): Promise<{ value: unknown; claim: unknown }> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("collections", "readonly"),
        store = transaction.objectStore("collections");
      const value = store.get(keyOf(owner, namespace)),
        claim = store.get(claimKey);
      transaction.oncomplete = () =>
        resolve({ value: value.result, claim: claim.result });
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error ?? Error("빈출 쟁점 자료 읽기 실패"));
    });
  }
  private parse(
    owner: string,
    namespace: Namespace,
    value: unknown,
    force = false,
  ): StoredLibrary {
    if (value === undefined) return empty();
    const stored = value as StoredLibrary;
    if (
      !Number.isSafeInteger(stored?.generation) ||
      stored.generation < 0 ||
      !Number.isSafeInteger(stored.revision) ||
      stored.revision < 0 ||
      !Array.isArray(stored.published) ||
      stored.published.some((x) => typeof x !== "string") ||
      !Array.isArray(stored.received) ||
      stored.received.some((x) => typeof x !== "string") ||
      !(
        stored.handoff === null ||
        (stored.handoff && typeof stored.handoff === "object")
      )
    )
      throw Error(
        "저장된 빈출 쟁점 자료를 읽을 수 없습니다. 원본은 보존됩니다.",
      );
    const key = keyOf(owner, namespace),
      cached = this.validated.get(key);
    const handoff =
      !force && cached?.generation === stored.generation
        ? cached.handoff
        : stored.handoff === null
          ? null
          : immutablePackage(stored.handoff);
    if (handoff && handoff.dataKind !== namespace)
      throw Error("저장된 빈출 쟁점의 자료 영역이 다릅니다.");
    this.validated.set(key, { generation: stored.generation, handoff });
    return {
      ...stored,
      handoff,
      published: [...stored.published],
      received: [...stored.received],
    };
  }
  async read(
    owner: string,
    namespace: Namespace,
  ): Promise<FrequentIssuesLibrary> {
    const { value } = await this.raw(owner, namespace);
    const { revision: _revision, ...library } = this.parse(
      owner,
      namespace,
      value,
      true,
    );
    return library;
  }
  async readForSync(owner: string): Promise<FrequentIssuesLibrary> {
    const { value } = await this.raw(owner, "real");
    const { revision: _revision, ...library } = this.parse(
      owner,
      "real",
      value,
    );
    return library;
  }
  private async write(
    owner: string,
    namespace: Namespace,
    before: { value: unknown; claim: unknown },
    next: StoredLibrary,
    guard?: Guard,
    claim?: string,
    source?: { value: unknown; claim: unknown },
  ): Promise<void> {
    const db = await this.db();
    await guard?.();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("collections", "readwrite"),
        store = transaction.objectStore("collections");
      const current = store.get(keyOf(owner, namespace)),
        currentClaim = store.get(claimKey);
      const local = source ? store.get(keyOf("local", "real")) : null;
      let count = 0,
        conflict = false;
      const finish = () => {
        if (++count !== (local ? 3 : 2)) return;
        if (
          !same(current.result, before.value) ||
          !same(currentClaim.result, before.claim) ||
          (source &&
            (!same(local?.result, source.value) ||
              !same(currentClaim.result, source.claim)))
        ) {
          conflict = true;
          transaction.abort();
          return;
        }
        store.put(next, keyOf(owner, namespace));
        if (claim) store.put(claim, claimKey);
      };
      current.onsuccess = currentClaim.onsuccess = finish;
      if (local) local.onsuccess = finish;
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(
          conflict
            ? Error(
                "다른 창에서 빈출 쟁점 자료가 바뀌었습니다. 다시 시도하세요.",
              )
            : (transaction.error ??
                Error("빈출 쟁점 저장 실패 · 기존 자료는 보존됩니다.")),
        );
    });
  }
  async merge(
    owner: string,
    namespace: Namespace,
    value: unknown,
    guard?: Guard,
  ): Promise<boolean> {
    const incoming = immutablePackage(value);
    if (incoming.dataKind !== namespace)
      throw Error("빈출 쟁점 자료 영역이 다릅니다.");
    for (let retry = 0; retry < 3; retry++) {
      await guard?.();
      const before = await this.raw(owner, namespace);
      const current = this.parse(owner, namespace, before.value);
      const handoff = mergeFrequentIssuesPackages(current.handoff, incoming);
      if (handoff === current.handoff) return false;
      const next = {
        ...current,
        generation: current.generation + 1,
        revision: current.revision + 1,
        handoff,
      };
      try {
        await this.write(owner, namespace, before, next, guard);
        this.validated.set(keyOf(owner, namespace), {
          generation: next.generation,
          handoff,
        });
        this.onChanged();
        return true;
      } catch (error) {
        if (
          retry === 2 ||
          !(error instanceof Error) ||
          !error.message.includes("다른 창")
        )
          throw error;
      }
    }
    return false;
  }
  async migrateLocal(owner: string, guard?: Guard): Promise<boolean> {
    if (!owner || owner === "local")
      throw Error("빈출 쟁점 연결을 받을 계정이 필요합니다.");
    for (let retry = 0; retry < 3; retry++) {
      await guard?.();
      const before = await this.raw(owner, "real");
      if (before.claim !== undefined && before.claim !== owner) return false;
      const source = await this.raw("local", "real");
      const local = this.parse("local", "real", source.value);
      if (!local.handoff) return false;
      const current = this.parse(owner, "real", before.value);
      const handoff = mergeFrequentIssuesPackages(
        current.handoff,
        local.handoff,
      );
      const changed = handoff !== current.handoff;
      if (!changed && before.claim === owner) return false;
      const next = {
        ...current,
        handoff,
        generation: current.generation + Number(changed),
        revision: current.revision + 1,
      };
      try {
        await this.write(owner, "real", before, next, guard, owner, source);
        if (changed) {
          this.validated.set(keyOf(owner, "real"), {
            generation: next.generation,
            handoff,
          });
          this.onChanged();
        }
        return changed;
      } catch (error) {
        if (
          retry === 2 ||
          !(error instanceof Error) ||
          !error.message.includes("다른 창")
        )
          throw error;
      }
    }
    return false;
  }
  async mark(
    owner: string,
    type: "published" | "received",
    value: string,
    guard?: Guard,
  ): Promise<void> {
    for (let retry = 0; retry < 3; retry++) {
      const before = await this.raw(owner, "real");
      const current = this.parse(owner, "real", before.value);
      if (current[type].includes(value)) return;
      const next = {
        ...current,
        revision: current.revision + 1,
        [type]: [...current[type], value],
      };
      try {
        await this.write(owner, "real", before, next, guard);
        return;
      } catch (error) {
        if (
          retry === 2 ||
          !(error instanceof Error) ||
          !error.message.includes("다른 창")
        )
          throw error;
      }
    }
  }
  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    this.validated.clear();
    (await opening)?.close();
  }
}

const repository = new FrequentIssuesRepository();
export function useFrequentIssuesLibrary(
  owner: string,
  namespace: Namespace,
  ready = true,
) {
  const key = keyOf(owner, namespace),
    current = useRef<string | null>(null);
  current.current = ready ? key : null;
  const [loaded, setLoaded] = useState<{
    key: string;
    value: FrequentIssuesLibrary;
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void repository.read(owner, namespace).then(
      (value) => {
        if (live && current.current === key) {
          setLoaded({ key, value });
          setError(null);
        }
      },
      (reason: unknown) => {
        if (live && current.current === key)
          setError({
            key,
            message:
              reason instanceof Error
                ? reason.message
                : "빈출 쟁점 자료를 읽지 못했습니다.",
          });
      },
    );
    return () => {
      live = false;
    };
  }, [key, owner, namespace, ready, retry]);
  useEffect(() => {
    const changed = () => setRetry((value) => value + 1);
    window.addEventListener("police-explanations-changed", changed);
    return () =>
      window.removeEventListener("police-explanations-changed", changed);
  }, []);
  return {
    handoff: ready && loaded?.key === key ? loaded.value.handoff : null,
    generation: ready && loaded?.key === key ? loaded.value.generation : 0,
    loading: !ready || (loaded?.key !== key && error?.key !== key),
    error: ready && error?.key === key ? error.message : "",
    reload: () => setRetry((value) => value + 1),
    async import(value: unknown) {
      const captured = key;
      const guard = () => {
        if (current.current !== captured)
          throw Error("계정 또는 자료 영역이 바뀌어 가져오기를 중단했습니다.");
      };
      guard();
      await repository.merge(owner, namespace, value, guard);
      const result = await repository.read(owner, namespace);
      if (current.current === captured) {
        setLoaded({ key: captured, value: result });
        setError(null);
      }
      return result;
    },
  };
}
