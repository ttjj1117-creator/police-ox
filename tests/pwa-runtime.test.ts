import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

async function seed(key: string, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("police-ox-storage", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("states");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("states", "readwrite");
      tx.objectStore("states").put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("safe PWA update storage gate", () => {
  it("does not create a new application database while checking an unused browser", async () => {
    const runtime = await import("../src/pwa/runtime");
    expect(await runtime.hasPersistedActiveSession()).toBe(false);
    expect(await indexedDB.databases()).toEqual([]);
  });
  it.each([
    "original:real",
    "original:demo",
    "real",
    "original:account:test-user:real",
  ])(
    "blocks an active persisted session in %s without changing data",
    async (key) => {
      const value = {
        generation: 7,
        state: {
          sessions: [{ id: "TEST_ONLY_active", status: "active" }],
          outbox: [{ eventId: "TEST_ONLY_unsent" }],
        },
      };
      await seed(key, value);
      const runtime = await import("../src/pwa/runtime");
      expect(await runtime.hasPersistedActiveSession()).toBe(true);
      const read = await new Promise((resolve) => {
        const open = indexedDB.open("police-ox-storage");
        open.onsuccess = () => {
          const db = open.result;
          const get = db
            .transaction("states", "readonly")
            .objectStore("states")
            .get(key);
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
        };
      });
      expect(read).toEqual(value);
    },
  );
  it("allows completed and ended records and ignores unrelated sync metadata", async () => {
    await seed("original:real", {
      state: { sessions: [{ status: "completed" }, { status: "ended" }] },
    });
    await seed("sync:test-user", {
      outbox: [{ eventId: "TEST_ONLY_pending" }],
      cursor: 3,
    });
    const runtime = await import("../src/pwa/runtime");
    expect(await runtime.hasPersistedActiveSession()).toBe(false);
  });
  it("declines an explicit update if another session exists and never sends activation", async () => {
    await seed("original:real", {
      state: { sessions: [{ status: "active" }] },
    });
    const postMessage = vi.fn();
    const reg = new EventTarget() as EventTarget & {
      waiting: unknown;
      active: unknown;
    };
    reg.waiting = { postMessage };
    reg.active = {};
    const serviceWorker = Object.assign(new EventTarget(), {
      register: vi.fn().mockResolvedValue(reg),
      ready: Promise.resolve(reg),
    });
    vi.stubGlobal("navigator", { onLine: true, serviceWorker });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", new EventTarget());
    vi.stubEnv("PROD", true);
    const runtime = await import("../src/pwa/runtime");
    runtime.registerPwa();
    await Promise.resolve();
    await runtime.applyPwaUpdate();
    expect(postMessage).not.toHaveBeenCalled();
    expect(runtime.getPwaSnapshot().notice).toContain("진행 중인 풀이");
    expect(runtime.getPwaSnapshot().waiting).toBe(true);
  });
});
