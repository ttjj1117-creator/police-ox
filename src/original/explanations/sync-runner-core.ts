import type { AuthSession, CloudConfig } from "../sync/transport";
import {
  ExplanationSyncRepository,
  explanationBundleFingerprint,
} from "./sync";
import { ExplanationCloudTransport } from "./sync-transport";

export interface ExplanationSyncCounts {
  legacy: number;
  instructor: number;
}
export interface ExplanationSyncOptions {
  repository?: ExplanationSyncRepository;
  transport?: ExplanationCloudTransport;
  current?: () => boolean | Promise<boolean>;
}
const repository = new ExplanationSyncRepository();
/** Direct implementation shared by injected tests, unsupported browsers and the
 * dedicated worker. No main-thread client or worker imports belong here. */
export async function syncExplanationLibrariesCore(
  owner: string,
  auth: AuthSession,
  config: CloudConfig,
  options: ExplanationSyncOptions = {},
): Promise<ExplanationSyncCounts> {
  if (owner !== `${config.url}|${auth.user.id}`)
    throw Error("해설 동기화 계정이 다릅니다.");
  const local = options.repository ?? repository;
  const transport = options.transport ?? new ExplanationCloudTransport(config);
  const guard = async () => {
    if (options.current && !(await options.current()))
      throw Error("계정이 바뀌어 해설 동기화를 중단했습니다.");
  };
  await guard();
  let snapshot = await local.prepareSync(owner);
  await guard();
  const received = new Set(snapshot.received);
  const paths = await transport.list(auth);
  await guard();
  for (const path of paths) {
    await guard();
    if (received.has(path)) continue;
    const bundle = await transport.download(path, auth);
    await guard();
    await local.merge(owner, bundle);
    await guard();
    await local.markReceived(owner, path);
    await guard();
    const fingerprint = await explanationBundleFingerprint(bundle);
    await guard();
    await local.markPublished(owner, fingerprint);
    await guard();
    received.add(path);
  }
  await guard();
  // A concurrent import during listing/download remains visible to this job.
  snapshot = await local.readForSync(owner);
  await guard();
  const fingerprint = await explanationBundleFingerprint(snapshot.bundle);
  // Fingerprinting may await crypto or a worker checkpoint. Recheck before any
  // upload, including when the remote list was empty.
  await guard();
  if (
    (snapshot.bundle.legacy.length || snapshot.bundle.instructor.length) &&
    !snapshot.published.includes(fingerprint)
  ) {
    const path = await transport.upload(snapshot.bundle, auth);
    await guard();
    await local.markPublished(owner, fingerprint);
    await guard();
    await local.markReceived(owner, path);
    await guard();
  }
  await guard();
  return {
    legacy: snapshot.bundle.legacy.length,
    instructor: snapshot.bundle.instructor.length,
  };
}
