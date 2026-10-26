import { useEffect, useRef, useState } from "react";
import type { Asset, Namespace, Question } from "../model";
import {
  explanationIndex,
  mergeExplanationPackages,
  parseExplanationPackage,
  validateExplanationPackage,
  type ExplanationPackage,
} from "./contract";

export interface Library {
  generation: number;
  packages: ExplanationPackage[];
}
export class ExplanationRepository {
  private opening?: Promise<IDBDatabase>;
  constructor(
    private factory?: IDBFactory,
    private name = "police-original-explanations",
  ) {}
  private db() {
    return (this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = (this.factory ?? indexedDB).open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("collections");
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
  async read(owner: string, namespace: Namespace): Promise<Library> {
    const db = await this.db();
    const value = await new Promise<Library | undefined>((resolve, reject) => {
      const t = db.transaction("collections", "readonly"),
        r = t
          .objectStore("collections")
          .get(JSON.stringify([owner, namespace]));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      t.onabort = () => reject(t.error);
    });
    if (!value) return { generation: 0, packages: [] };
    if (
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      !Array.isArray(value.packages)
    )
      throw Error("해설 저장 자료를 읽을 수 없습니다. 원본은 보존됩니다.");
    const packages = value.packages.map(parseExplanationPackage);
    if (packages.some((p) => p.dataKind !== namespace))
      throw Error("저장된 해설의 자료 영역이 다릅니다.");
    explanationIndex(packages);
    return { generation: value.generation, packages };
  }
  async import(
    owner: string,
    namespace: Namespace,
    value: unknown,
    questions: Question[],
    assets: Asset[],
  ): Promise<Library> {
    const incoming = await validateExplanationPackage(
        value,
        namespace,
        questions,
        assets,
      ),
      before = await this.read(owner, namespace);
    const next = {
      generation: before.generation + 1,
      packages: mergeExplanationPackages(before.packages, incoming),
    };
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("collections", "readwrite"),
        store = t.objectStore("collections"),
        key = JSON.stringify([owner, namespace]),
        r = store.get(key);
      let conflict = false;
      r.onsuccess = () => {
        if ((r.result?.generation ?? 0) !== before.generation) {
          conflict = true;
          t.abort();
          return;
        }
        store.put(next, key);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () =>
        reject(
          conflict
            ? Error(
                "다른 창에서 해설이 바뀌었습니다. 미리보기부터 다시 진행하세요.",
              )
            : (t.error ?? Error("해설 저장이 취소되었습니다.")),
        );
    });
    return next;
  }
}
const repository = new ExplanationRepository();
export function useExplanationLibrary(owner: string, namespace: Namespace) {
  const key = JSON.stringify([owner, namespace]),
    current = useRef(key);
  current.current = key;
  const [loaded, setLoaded] = useState<{ key: string; value: Library } | null>(
      null,
    ),
    [error, setError] = useState<{ key: string; message: string } | null>(null),
    [retry, setRetry] = useState(0);
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
            message: e instanceof Error ? e.message : "해설을 읽지 못했습니다.",
          });
      });
    return () => {
      live = false;
    };
  }, [key, retry]);
  return {
    packages: loaded?.key === key ? loaded.value.packages : [],
    loading: loaded?.key !== key && error?.key !== key,
    error: error?.key === key ? error.message : "",
    reload: () => setRetry((x) => x + 1),
    async import(value: unknown, questions: Question[], assets: Asset[]) {
      const captured = key;
      const result = await repository.import(
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
  };
}
