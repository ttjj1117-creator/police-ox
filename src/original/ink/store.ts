import {
  type InkDocument,
  type InkIdentity,
  inkIdentityKey,
  validInkDocument,
} from "./model";

export interface InkPersistence {
  read(identity: InkIdentity): Promise<InkDocument | undefined>;
  write(document: InkDocument): Promise<void>;
}
// Providers unmount while a previous stroke can still be committing. All store
// instances on this device share a queue per identity, and reads join that queue.
const pendingByFactory = new WeakMap<
  IDBFactory,
  Map<string, Map<string, Promise<void>>>
>();
const recoveryByFactory = new WeakMap<
  IDBFactory,
  Map<string, Map<string, InkDocument>>
>();
/** Not durable: lets a remounted question report/retry an earlier failed save. */
export class InkRecoveryError extends Error {
  constructor(
    readonly document: InkDocument,
    readonly originalError?: unknown,
  ) {
    super(
      "필기를 저장하지 못했습니다. 현재 앱에서만 임시 보관합니다. 닫기 전에 다시 시도하세요.",
    );
    this.name = "InkRecoveryError";
  }
}
/** Separate from all question, answer, account-sync and full-backup stores. */
export class InkStore implements InkPersistence {
  private opening?: Promise<IDBDatabase>;
  constructor(
    private readonly factory?: IDBFactory,
    private readonly name = "police-original-ink",
  ) {}
  private pending(): Map<string, Promise<void>> {
    const factory = this.factory ?? indexedDB;
    let databases = pendingByFactory.get(factory);
    if (!databases) {
      databases = new Map();
      pendingByFactory.set(factory, databases);
    }
    let identities = databases.get(this.name);
    if (!identities) {
      identities = new Map();
      databases.set(this.name, identities);
    }
    return identities;
  }
  private recoveries(): Map<string, InkDocument> {
    const factory = this.factory ?? indexedDB;
    let databases = recoveryByFactory.get(factory);
    if (!databases) {
      databases = new Map();
      recoveryByFactory.set(factory, databases);
    }
    let identities = databases.get(this.name);
    if (!identities) {
      identities = new Map();
      databases.set(this.name, identities);
    }
    return identities;
  }
  private database(): Promise<IDBDatabase> {
    if (!this.opening) {
      this.opening = new Promise((resolve, reject) => {
        const request = (this.factory ?? indexedDB).open(this.name, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("documents"))
            request.result.createObjectStore("documents");
        };
        request.onerror = () =>
          reject(request.error ?? new Error("필기 저장소를 열지 못했습니다."));
        request.onblocked = () =>
          reject(new Error("다른 창의 필기 저장소가 열려 있습니다."));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.opening = undefined;
          };
          resolve(db);
        };
      });
      this.opening.catch(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }
  async read(identity: InkIdentity): Promise<InkDocument | undefined> {
    const writes = this.pending(),
      key = inkIdentityKey(identity);
    let pending: Promise<void> | undefined;
    // A later queued stroke may appear while the first commit is in progress.
    while ((pending = writes.get(key))) {
      await pending.catch(() => undefined);
      if (writes.get(key) === pending) break;
    }
    const recovery = this.recoveries().get(key);
    if (recovery) throw new InkRecoveryError(recovery);
    const db = await this.database();
    const value: unknown = await new Promise((resolve, reject) => {
      const transaction = db.transaction("documents", "readonly");
      const request = transaction
        .objectStore("documents")
        .get(inkIdentityKey(identity));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("필기 읽기가 취소되었습니다."));
    });
    if (value === undefined) return undefined;
    if (!validInkDocument(value, identity))
      throw new Error(
        "보관된 필기 형식을 확인하지 못했습니다. 원본은 보존했습니다.",
      );
    return value;
  }
  write(document: InkDocument): Promise<void> {
    if (!validInkDocument(document, document.identity))
      return Promise.reject(new Error("필기 형식이 올바르지 않습니다."));
    let writes: Map<string, Promise<void>>;
    try {
      writes = this.pending();
    } catch (error) {
      return Promise.reject(error);
    }
    const key = inkIdentityKey(document.identity);
    const previous = writes.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => this.writeNow(document))
      .then(() => {
        this.recoveries().delete(key);
      })
      .catch((error: unknown) => {
        this.recoveries().set(key, document);
        throw new InkRecoveryError(document, error);
      });
    // Register immediately, not after a provider-local preceding promise resolves.
    writes.set(key, pending);
    const clean = () => {
      if (writes.get(key) === pending) writes.delete(key);
    };
    void pending.then(clean, clean);
    return pending;
  }
  protected async writeNow(document: InkDocument): Promise<void> {
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("documents", "readwrite");
      transaction
        .objectStore("documents")
        .put(document, inkIdentityKey(document.identity));
      // A request's success is not a durability acknowledgement. Wait for commit.
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("필기를 저장하지 못했습니다."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("필기 저장이 취소되었습니다."));
    });
  }
  async close(): Promise<void> {
    if (this.opening) (await this.opening).close();
    this.opening = undefined;
  }
}
export const inkStore = new InkStore();
