import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { OriginalRepository } from "../src/original/storage";
import { SyncAccountStore } from "../src/original/sync/local";
import { initialState } from "../src/fixtures/data";
const resources: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((r) => r.close()));
});
describe("combined backup account ownership", () => {
  it("backs up the linked OX account without borrowing unlinked or other-account data", async () => {
    const name = "combined-owner-" + crypto.randomUUID(),
      repo = new OriginalRepository(name),
      store = new SyncAccountStore(name);
    resources.push(repo, store);
    const legacy = initialState(true),
      own = initialState(false),
      other = initialState(false);
    own.settings.fontScale = 1.5;
    other.settings.fontScale = 2;
    await store.setValue("real", { generation: 1, state: legacy });
    await store.setValue("ox:real:user:owner-a", { generation: 4, state: own });
    await store.setValue("ox:real:user:owner-b", {
      generation: 8,
      state: other,
    });
    repo.useAccount("owner-a");
    const linked = await repo.fullBackup("real");
    expect(linked.ox.state).toEqual(own);
    expect(linked.generations.ox).toBe(4);
    repo.useAccount(null);
    expect((await repo.fullBackup("real")).ox.state).toEqual(legacy);
  });
  it("keeps a new account's OX backup empty even if this browser has legacy OX data", async () => {
    const name = "combined-new-" + crypto.randomUUID(),
      repo = new OriginalRepository(name),
      store = new SyncAccountStore(name);
    resources.push(repo, store);
    await store.setValue("real", { generation: 3, state: initialState(true) });
    repo.useAccount("new-owner");
    const saved = await repo.fullBackup("real");
    expect(saved.ox.state.dataset.items).toHaveLength(0);
    expect(saved.generations.ox).toBe(0);
  });
});
