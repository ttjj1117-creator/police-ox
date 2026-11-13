import type { AuthSession, CloudConfig } from "../sync/transport";
import {
  syncExplanationLibrariesCore,
  type ExplanationSyncOptions,
  type ExplanationSyncCounts,
} from "./sync-runner-core";
import { runExplanationSyncWorker } from "./sync-worker-client";
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
  if (options.repository || options.transport || typeof Worker === "undefined")
    return syncExplanationLibrariesCore(owner, auth, config, options);
  return runExplanationSyncWorker(owner, auth, config, options.current, options.shared);
}
