import { appBasePath } from "./base";

export interface PwaSnapshot {
  offline: boolean;
  ready: boolean;
  waiting: boolean;
  busy: boolean;
  notice: string;
}
let snapshot: PwaSnapshot = {
  offline: !navigator.onLine,
  ready: false,
  waiting: false,
  busy: false,
  notice: "",
};
let registration: ServiceWorkerRegistration | undefined;
let uiSessionActive = false;
let registered = false;
const listeners = new Set<() => void>();
const update = (patch: Partial<PwaSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
};
export const subscribePwa = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getPwaSnapshot = () => snapshot;
export function setPwaSessionActive(active: boolean) {
  uiSessionActive = active;
}

// Read only: never change the app DB version or touch data/outbox during cache updates.
export async function hasPersistedActiveSession(): Promise<boolean> {
  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    if (!databases.some((db) => db.name === "police-ox-storage")) return false;
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("police-ox-storage");
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      resolve(false);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("저장소를 확인할 수 없습니다."));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("states")) {
        db.close();
        resolve(false);
        return;
      }
      const tx = db.transaction("states", "readonly");
      let active = false;
      const cursor = tx.objectStore("states").openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        const sessions: unknown = item.value?.state?.sessions;
        if (
          Array.isArray(sessions) &&
          sessions.some((session) => session?.status === "active")
        )
          active = true;
        item.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve(active);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export async function applyPwaUpdate(): Promise<void> {
  if (!registration?.waiting || snapshot.busy) return;
  update({ busy: true, notice: "" });
  try {
    if (uiSessionActive || (await hasPersistedActiveSession())) {
      update({
        busy: false,
        notice:
          "진행 중인 풀이를 완료하거나 종료한 뒤 업데이트할 수 있습니다. 답안과 타이머는 그대로 유지됩니다.",
      });
      return;
    }
    const waiting = registration.waiting;
    if (!waiting) {
      update({ busy: false, waiting: false });
      return;
    }
    // Only this explicit request may reload this tab; other tabs are never refreshed.
    let finishing = false;
    const changed = async () => {
      if (finishing) return;
      finishing = true;
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      try {
        if (uiSessionActive || (await hasPersistedActiveSession())) {
          update({
            busy: false,
            notice:
              "새 풀이가 시작되어 새로고침을 미뤘습니다. 풀이 종료 후 앱을 다시 열어 주세요.",
          });
          return;
        }
        location.reload();
      } catch {
        update({
          busy: false,
          notice:
            "저장 상태를 확인하지 못해 새로고침을 미뤘습니다. 풀이 종료 후 앱을 다시 열어 주세요.",
        });
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    waiting.postMessage({ type: "APPLY_WAITING_UPDATE" });
    // An already installed worker may not control an older scope until the next navigation.
    waiting.addEventListener("statechange", () => {
      if (waiting.state === "activated") {
        void changed();
      }
    });
  } catch {
    update({
      busy: false,
      notice:
        "저장 상태를 확인하지 못해 업데이트를 보류했습니다. 다시 시도해 주세요.",
    });
  }
}

export function registerPwa(): void {
  if (registered || !import.meta.env.PROD || !("serviceWorker" in navigator))
    return;
  registered = true;
  const online = () => update({ offline: !navigator.onLine });
  window.addEventListener("online", online);
  window.addEventListener("offline", online);
  void navigator.serviceWorker
    .register(appBasePath() + "sw.js", {
      scope: appBasePath(),
      updateViaCache: "none",
    })
    .then((reg) => {
      registration = reg;
      const detect = () =>
        update({ waiting: !!reg.waiting, ready: !!reg.active });
      detect();
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", detect);
      });
      void navigator.serviceWorker.ready.then(() => update({ ready: true }));
      const check = () => {
        if (navigator.onLine) void reg.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.addEventListener("online", check);
    })
    .catch(() =>
      update({
        notice:
          "앱 파일의 오프라인 저장을 준비하지 못했습니다. 온라인 학습은 계속할 수 있습니다.",
      }),
    );
}
