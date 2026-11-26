import type { AuthSession, CloudConfig } from "../sync/transport";
import {
  syncExplanationLibrariesCore,
  type ExplanationSyncOptions,
  type ExplanationSyncCounts,
} from "./sync-runner-core";
import { runExplanationSyncWorker } from "./sync-worker-client";
import { syncFrequentIssues } from "../frequent/sync";
export { cancelExplanationSyncWorker } from "./sync-worker-client";

/** Browser production keeps private library IO/validation off the UI thread.
 * Injected repositories/transports and environments without Worker use the
 * same direct core; a running worker's errors never silently retry on main. */
export async function syncExplanationLibraries(
  owner: string,
  auth: AuthSession,
  config: CloudConfig,
  options: ExplanationSyncOptions = {},
): Promise<ExplanationSyncCounts> {
  if (
    options.repository ||
    options.transport ||
    typeof Worker === "undefined"
  ) {
    const counts = await syncExplanationLibrariesCore(
      owner,
      auth,
      config,
      options,
    );
    if (!options.repository && !options.transport)
      await syncFrequentIssues(owner, auth, config, {
        current: options.current,
        shared: options.shared,
        sharedFetch: options.sharedFetch,
      });
    return counts;
  }
  return runExplanationSyncWorker(
    owner,
    auth,
    config,
    options.current,
    options.shared,
  );
}
