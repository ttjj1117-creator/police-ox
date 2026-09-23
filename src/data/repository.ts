import { Namespace, State } from "../domain/schema";
import { initialState } from "../fixtures/data";

// Storage schema 1: one atomic aggregate per isolated namespace.
export interface Envelope {
  generation: number;
  state: State;
}
export class ConflictError extends Error {
  constructor() {
    super(
      "다른 탭에서 데이터가 변경되었습니다. 최신 상태를 불러왔습니다. 다시 시도하세요.",
    );
  }
}
export class Repository {
  private db: Promise<IDBDatabase>;
  constructor(name = "police-ox-storage") {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("states");
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("다른 탭을 닫고 다시 시도하세요."));
    });
  }
  async load(namespace: Namespace): Promise<Envelope> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly");
      const req = tx.objectStore("states").get(namespace);
      req.onsuccess = () =>
        resolve(
          req.result ?? {
            generation: 0,
            state: initialState(namespace === "demo"),
          },
        );
      req.onerror = () => reject(req.error);
    });
  }
  async save(
    namespace: Namespace,
    state: State,
    expectedGeneration: number,
  ): Promise<Envelope> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readwrite"),
        store = tx.objectStore("states");
      let error: Error | null = null;
      const get = store.get(namespace);
      let next: Envelope;
      get.onsuccess = () => {
        if ((get.result?.generation ?? 0) !== expectedGeneration) {
          error = new ConflictError();
          tx.abort();
          return;
        }
        next = { generation: expectedGeneration + 1, state };
        try {
          store.put(next, namespace);
        } catch (e) {
          error = e instanceof Error ? e : new Error(String(e));
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(error ?? tx.error ?? new Error("저장 실패"));
      tx.onabort = () => reject(error ?? tx.error ?? new Error("저장 실패"));
    });
  }
  async close() {
    (await this.db).close();
  }
}
