import type { State } from "../domain/schema";
import { ConflictError } from "../data/repository";
import { canonical } from "../domain/schema";
import { initialState } from "../fixtures/data";
import {
  applyLocalEvents,
  buildEvents,
  emptyProjection,
  reconcileOrder,
  validateState,
} from "./protocol";
import { usableClock } from "../original/sync/clock";
import { attachHints } from "./view";
import type { Context, Metadata, Snapshot } from "./types";
export const oxStateKey = (owner: string) => `ox:real:user:${owner}`;
export const oxMetaKey = (owner: string) => `ox-sync:real:user:${owner}`;
export const emptyMetadata = (): Metadata => ({
  revision: 0,
  deviceId: crypto.randomUUID(),
  nextSequence: 1,
  cursor: 0,
  projection: emptyProjection(),
  outbox: [],
  failures: {},
  lastSuccess: null,
  clock: null,
});
export const contextOf = (meta: Metadata): Context => ({
  deviceId: meta.deviceId,
  nextSequence: meta.nextSequence,
  baseCursor: meta.cursor,
  bankVersion: meta.projection.bankVersion,
  clock: usableClock(meta.clock),
  order: meta.projection.order,
  markVersions: meta.projection.markVersions,
  pendingEvents: meta.outbox,
});
export function notifyOx() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("police-ox-sync-local"));
}
export class OxSyncStore {
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
  async read(owner: string): Promise<Snapshot> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly"),
        s = tx.objectStore("states"),
        a = s.get(oxStateKey(owner)),
        m = s.get(oxMetaKey(owner));
      tx.oncomplete = () => {
        try {
          const state = validateState(a.result?.state ?? initialState(false)),
            meta: Metadata = m.result ?? emptyMetadata(),
            r = reconcileOrder(state, meta.projection);
          meta.projection = r.projection;
          resolve({
            generation: a.result?.generation ?? 0,
            state: attachHints(r.state, meta.projection),
            meta,
          });
        } catch (e) {
          reject(e);
        }
      };
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? new Error("OX 계정 기록 읽기 실패"));
    });
  }
  async readLegacy(): Promise<State> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly"),
        r = tx.objectStore("states").get("real");
      tx.oncomplete = () => {
        try {
          resolve(validateState(r.result?.state ?? initialState(false)));
        } catch (e) {
          reject(e);
        }
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async save(
    owner: string,
    state: State,
    expectedGeneration: number,
  ): Promise<Snapshot> {
    const valid = validateState(state),
      db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readwrite"),
        s = tx.objectStore("states"),
        a = s.get(oxStateKey(owner)),
        m = s.get(oxMetaKey(owner));
      let failure: unknown, result: Snapshot;
      m.onsuccess = () => {
        try {
          if ((a.result?.generation ?? 0) !== expectedGeneration)
            throw new ConflictError();
          const previous: State = a.result?.state ?? initialState(false),
            meta: Metadata = m.result ?? emptyMetadata(),
            built = buildEvents(previous, valid, contextOf(meta)),
            r = applyLocalEvents(
              valid,
              { ...meta.projection, order: built.order },
              built.events,
            );
          result = {
            generation: expectedGeneration + 1,
            state: r.state,
            meta: {
              ...meta,
              revision: meta.revision + 1,
              nextSequence: built.nextSequence,
              projection: r.projection,
              outbox: [...meta.outbox, ...built.events],
            },
          };
          s.put(
            { generation: result.generation, state: result.state },
            oxStateKey(owner),
          );
          s.put(result.meta, oxMetaKey(owner));
        } catch (e) {
          failure = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        notifyOx();
        resolve({
          ...result,
          state: attachHints(result.state, result.meta.projection),
        });
      };
      tx.onerror = tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error("OX 저장 실패"));
    });
  }
  async write(
    owner: string,
    snapshot: Snapshot,
    expectedGeneration: number,
  ): Promise<Snapshot> {
    const valid = validateState(snapshot.state),
      db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readwrite"),
        s = tx.objectStore("states"),
        a = s.get(oxStateKey(owner)),
        m = s.get(oxMetaKey(owner));
      let failure: unknown, result: Snapshot;
      m.onsuccess = () => {
        try {
          if (
            (a.result?.generation ?? 0) !== expectedGeneration ||
            (m.result?.revision ?? 0) !== snapshot.meta.revision
          )
            throw new Error("다른 탭에서 OX 계정 기록이 변경되었습니다.");
          const changed =
            canonical(a.result?.state ?? null) !== canonical(valid);
          result = {
            generation: expectedGeneration + (changed ? 1 : 0),
            state: valid,
            meta: { ...snapshot.meta, revision: snapshot.meta.revision + 1 },
          };
          s.put(
            { generation: result.generation, state: valid },
            oxStateKey(owner),
          );
          s.put(result.meta, oxMetaKey(owner));
        } catch (e) {
          failure = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        notifyOx();
        resolve({
          ...result,
          state: attachHints(result.state, result.meta.projection),
        });
      };
      tx.onerror = tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error("OX 동기화 저장 실패"));
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
      const tx = db.transaction("states", "readwrite");
      tx.objectStore("states").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async recovery(owner: string) {
    const db = await this.db;
    return new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("states", "readonly"),
        s = tx.objectStore("states"),
        a = s.get(oxStateKey(owner)),
        m = s.get(oxMetaKey(owner)),
        source = s.get(`ox-sync:migration-source:${owner}`);
      tx.oncomplete = () =>
        resolve({
          format: "police-ox-sync-recovery",
          version: 1,
          ownerId: owner,
          record: a.result ?? null,
          meta: m.result ?? null,
          source: source.result ?? null,
        });
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async close() {
    (await this.db).close();
  }
}
