import {
  emptyInkHistory,
  inkIdentityKey,
  type InkHistory,
  type InkIdentity,
} from "./model";

interface InkEntry {
  identity: InkIdentity;
  history: InkHistory;
}
export interface InkMemoryHandle {
  readonly history: InkHistory;
  update(transform: (history: InkHistory) => InkHistory): InkHistory;
}
/** One page execution owns this memory. Nothing reads or writes browser storage. */
export class InkSessionMemory {
  private readonly entries = new Map<string, InkEntry>();

  capture(identity: InkIdentity): InkMemoryHandle {
    const key = inkIdentityKey(identity);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { identity: { ...identity }, history: emptyInkHistory() };
      this.entries.set(key, entry);
    }
    const captured = entry;
    const retired = emptyInkHistory();
    const thisMemory = this;
    return {
      get history() {
        return thisMemory.entries.get(key) === captured
          ? captured.history
          : retired;
      },
      update: (transform) => {
        // A late pointer/unmount callback cannot resurrect a finished session
        // or an owner that was cleared. Only this live entry may be changed.
        if (this.entries.get(key) !== captured) return retired;
        captured.history = transform(captured.history);
        return captured.history;
      },
    };
  }
  read(identity: InkIdentity): InkHistory {
    return this.capture(identity).history;
  }
  update(
    identity: InkIdentity,
    transform: (history: InkHistory) => InkHistory,
  ): InkHistory {
    return this.capture(identity).update(transform);
  }
  clear(): void {
    this.entries.clear();
  }
  discardSession(
    ownerKey: string,
    namespace: InkIdentity["namespace"],
    sessionId: string,
  ): void {
    for (const [key, entry] of this.entries) {
      const identity = entry.identity;
      if (
        identity.ownerKey === ownerKey &&
        identity.namespace === namespace &&
        identity.sessionId === sessionId
      )
        this.entries.delete(key);
    }
  }
}
