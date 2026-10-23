import { initialOriginalState, type OriginalState } from "../engine";
import { buildEvents, emptyProjection, reconcileOrder } from "./protocol";
import type { ClockSample, SyncEvent, SyncProjection } from "./types";
import { canonical } from "../../domain/schema";
import { usableClock } from "./clock";

export interface SyncLocal {
  revision?: number;
  deviceId: string;
  nextSequence: number;
  cursor: number;
  projection: SyncProjection;
  outbox: SyncEvent[];
  clock: ClockSample | null;
  lastSuccess: string | null;
  failures: Record<string, string>;
}
export const accountStateKey = (id: string) => `original:real:user:${id}`;
export const syncMetaKey = (id: string) => `sync:real:user:${id}`;
export const emptySyncLocal = (): SyncLocal => ({
  revision: 0,
  deviceId: crypto.randomUUID(),
  nextSequence: 1,
  cursor: 0,
  projection: emptyProjection(),
  outbox: [],
  clock: null,
  lastSuccess: null,
  failures: {},
});
export function queueChanges(
  previous: OriginalState | undefined,
  next: OriginalState,
  meta: SyncLocal,
): SyncLocal {
  const built = buildEvents(previous ?? initialOriginalState("real"), next, {
    deviceId: meta.deviceId,
    nextSequence: meta.nextSequence,
    baseCursor: meta.cursor,
    bankVersion: meta.projection.bankVersion,
    clock: usableClock(meta.clock),
    order: meta.projection.order,
    markVersions: meta.projection.markVersions,
    pendingEvents: meta.outbox.filter((event) => !meta.failures[event.eventId]),
  });
  return {
    ...meta,
    revision: (meta.revision ?? 0) + 1,
    nextSequence: built.nextSequence,
    projection: reconcileOrder(next, { ...meta.projection, order: built.order })
      .projection,
    outbox: [...meta.outbox, ...built.events],
  };
}
export function notifySyncLocal() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("police-sync-local"));
}
export interface AccountSnapshot {
  generation: number;
  state: OriginalState;
  meta: SyncLocal;
}
/** Same DB version/store as both legacy repositories. Metadata and state commit together. */
export class SyncAccountStore {
  private db: Promise<IDBDatabase>;
  constructor(name = "police-ox-storage") {
    this.db = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains("states"))
          r.result.createObjectStore("states");
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("다른 탭을 닫고 다시 시도하세요."));
    });
  }
  async read(id: string): Promise<AccountSnapshot> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly"),
        s = tx.objectStore("states"),
        a = s.get(accountStateKey(id)),
        m = s.get(syncMetaKey(id));
      tx.oncomplete = () =>
        resolve({
          generation: a.result?.generation ?? 0,
          state: a.result?.state ?? initialOriginalState("real"),
          meta: m.result ?? emptySyncLocal(),
        });
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("계정 기록 불러오기 실패"));
    });
  }
  async readUnlinked(): Promise<OriginalState> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly"),
        r = tx.objectStore("states").get("original:real");
      tx.oncomplete = () =>
        resolve(r.result?.state ?? initialOriginalState("real"));
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async write(
    id: string,
    snapshot: AccountSnapshot,
    expectedGeneration: number,
  ) {
    const db = await this.db;
    return new Promise<AccountSnapshot>((resolve, reject) => {
      const tx = db.transaction("states", "readwrite"),
        s = tx.objectStore("states"),
        m = s.get(syncMetaKey(id)),
        r = s.get(accountStateKey(id));
      let failure: Error | null = null;
      let result: AccountSnapshot;
      r.onsuccess = () => {
        if (
          (r.result?.generation ?? 0) !== expectedGeneration ||
          (m.result?.revision ?? 0) !== (snapshot.meta.revision ?? 0)
        ) {
          failure = new Error(
            "다른 탭에서 계정 기록이 변경되었습니다. 다시 동기화하세요.",
          );
          tx.abort();
          return;
        }
        try {
          const changed =
            canonical(r.result?.state ?? initialOriginalState("real")) !==
            canonical(snapshot.state);
          result = {
            ...snapshot,
            generation: expectedGeneration + (changed ? 1 : 0),
            meta: {
              ...snapshot.meta,
              revision: (snapshot.meta.revision ?? 0) + 1,
            },
          };
          if (changed)
            s.put(
              { generation: result.generation, state: result.state },
              accountStateKey(id),
            );
          s.put(result.meta, syncMetaKey(id));
        } catch (e) {
          failure = e instanceof Error ? e : new Error(String(e));
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        notifySyncLocal();
        resolve(result);
      };
      tx.onerror = tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error("계정 기록 저장 실패"));
    });
  }
  async getValue<T>(key: string): Promise<T | null> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly"),
        r = tx.objectStore("states").get(key);
      tx.oncomplete = () => resolve(r.result ?? null);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async setValue(key: string, value: unknown) {
    const db = await this.db;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("states", "readwrite"),
        s = tx.objectStore("states");
      if (value === null) s.delete(key);
      else s.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async close() {
    (await this.db).close();
  }
}
