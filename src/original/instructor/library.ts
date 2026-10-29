import { useEffect, useRef, useState } from "react";
import type { Asset, Namespace, Question } from "../model";
import { canonicalExplanationValue } from "../explanations/contract";
import {
  mergeInstructorPackages,
  parseInstructorPackage,
  sameInstructorContent,
  validateInstructorAssets,
  validateInstructorPackage,
  type InstructorPackage,
} from "./contract";

export interface InstructorLibrary {
  generation: number;
  packages: InstructorPackage[];
}
const keyOf = (owner: string, namespace: Namespace) =>
  JSON.stringify([owner, namespace]);
export class InstructorRepository {
  private opening?: Promise<IDBDatabase>;
  constructor(
    private factory?: IDBFactory,
    private name = "police-original-explanations",
  ) {}
  private db() {
    return (this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = (this.factory ?? indexedDB).open(this.name, 2);
      r.onupgradeneeded = () => {
        for (const name of ["collections", "instructorCollections"])
          if (!r.result.objectStoreNames.contains(name))
            r.result.createObjectStore(name);
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
  private async snapshot(
    owner: string,
    namespace: Namespace,
  ): Promise<{ instructor: unknown; legacy: unknown }> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction(
        ["collections", "instructorCollections"],
        "readonly",
      );
      const a = t
        .objectStore("instructorCollections")
        .get(keyOf(owner, namespace));
      const b = t.objectStore("collections").get(keyOf(owner, namespace));
      t.oncomplete = () => resolve({ instructor: a.result, legacy: b.result });
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? Error("해설 읽기가 취소되었습니다."));
    });
  }
  private parseStored(value: unknown, namespace: Namespace): InstructorLibrary {
    if (value === undefined) return { generation: 0, packages: [] };
    const stored = value as InstructorLibrary;
    if (
      !Number.isSafeInteger(stored?.generation) ||
      stored.generation < 0 ||
      !Array.isArray(stored?.packages)
    )
      throw Error("강사 해설 저장 자료를 읽을 수 없습니다. 원본은 보존됩니다.");
    const packages = stored.packages.map(parseInstructorPackage);
    if (packages.some((p) => p.dataKind !== namespace))
      throw Error("저장된 강사 해설의 자료 영역이 다릅니다.");
    let checked: InstructorPackage[] = [];
    for (const p of packages) checked = mergeInstructorPackages(checked, p);
    return { generation: stored.generation, packages };
  }
  async read(owner: string, namespace: Namespace): Promise<InstructorLibrary> {
    const snapshot = await this.snapshot(owner, namespace);
    const result = this.parseStored(snapshot.instructor, namespace);
    for (const p of result.packages) await validateInstructorAssets(p);
    return result;
  }
  async import(
    owner: string,
    namespace: Namespace,
    value: unknown,
    questions: Question[],
    questionAssets: Asset[] = [],
  ): Promise<InstructorLibrary> {
    // No transaction is opened until all source, hash and version checks have succeeded.
    const incoming = await validateInstructorPackage(
      value,
      namespace,
      questions,
      questionAssets,
    );
    const snapshot = await this.snapshot(owner, namespace);
    const before = this.parseStored(snapshot.instructor, namespace);
    const packages = mergeInstructorPackages(before.packages, incoming);
    const unchanged = sameInstructorContent(packages, before.packages);
    const next = {
      generation: before.generation + (unchanged ? 0 : 1),
      packages,
    };
    const legacy = snapshot.legacy as
      | { generation?: number; packages?: unknown[] }
      | undefined;
    const needsClear =
      !!legacy &&
      (!Array.isArray(legacy.packages) || legacy.packages.length > 0);
    if (unchanged && !needsClear) return before;
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(
        ["collections", "instructorCollections"],
        "readwrite",
      );
      const a = t.objectStore("instructorCollections"),
        b = t.objectStore("collections"),
        key = keyOf(owner, namespace);
      const getA = a.get(key),
        getB = b.get(key);
      let ready = 0,
        conflict = false;
      const write = () => {
        if (++ready < 2) return;
        if (
          canonicalExplanationValue(getA.result) !==
            canonicalExplanationValue(snapshot.instructor) ||
          canonicalExplanationValue(getB.result) !==
            canonicalExplanationValue(snapshot.legacy)
        ) {
          conflict = true;
          t.abort();
          return;
        }
        if (!unchanged) a.put(next, key);
        if (needsClear)
          b.put(
            {
              generation:
                Number.isSafeInteger(legacy?.generation) &&
                (legacy?.generation ?? -1) >= 0
                  ? legacy!.generation! + 1
                  : 1,
              packages: [],
            },
            key,
          );
      };
      getA.onsuccess = write;
      getB.onsuccess = write;
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () =>
        reject(
          conflict
            ? Error(
                "다른 창에서 해설이 바뀌었습니다. 미리보기부터 다시 진행하세요.",
              )
            : (t.error ??
                Error(
                  "강사 해설 저장이 취소되었습니다. 이전 해설은 보존됩니다.",
                )),
        );
    });
    return next;
  }
  async clearLegacy(owner: string, namespace: Namespace): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction("collections", "readwrite"),
        store = t.objectStore("collections"),
        key = keyOf(owner, namespace);
      const r = store.get(key);
      r.onsuccess = () => {
        const old = r.result;
        if (old)
          store.put(
            {
              generation:
                Number.isSafeInteger(old.generation) && old.generation >= 0
                  ? old.generation + 1
                  : 1,
              packages: [],
            },
            key,
          );
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () =>
        reject(t.error ?? Error("이전 해설 삭제가 취소되었습니다."));
    });
  }
  async close() {
    const opening = this.opening;
    this.opening = undefined;
    (await opening)?.close();
  }
}

const repository = new InstructorRepository();
export function useInstructorLibrary(owner: string, namespace: Namespace) {
  const key = keyOf(owner, namespace),
    current = useRef(key);
  current.current = key;
  const [loaded, setLoaded] = useState<{
    key: string;
    value: InstructorLibrary;
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    void repository
      .read(owner, namespace)
      .then((value) => {
        if (live) {
          setLoaded({ key, value });
          setError(null);
        }
      })
      .catch((e) => {
        if (live)
          setError({
            key,
            message:
              e instanceof Error ? e.message : "강사 해설을 읽지 못했습니다.",
          });
      });
    return () => {
      live = false;
    };
  }, [owner, namespace, key, retry]);
  return {
    packages: loaded?.key === key ? loaded.value.packages : [],
    loading: loaded?.key !== key && error?.key !== key,
    error: error?.key === key ? error.message : "",
    reload: () => setRetry((v) => v + 1),
    async import(value: unknown, questions: Question[], assets: Asset[] = []) {
      const captured = key,
        result = await repository.import(
          owner,
          namespace,
          value,
          questions,
          assets,
        );
      if (current.current === captured) {
        setLoaded({ key: captured, value: result });
        setError(null);
      }
      return result;
    },
    async clearLegacy() {
      await repository.clearLegacy(owner, namespace);
    },
  };
}
