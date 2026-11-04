import type { AuthSession, CloudConfig } from "../sync/transport";
import {
  ExplanationSyncRepository,
  explanationBundleFingerprint,
} from "./sync";
import { ExplanationCloudTransport } from "./sync-transport";

const repository = new ExplanationSyncRepository();
export async function syncExplanationLibraries(
  owner: string,
  auth: AuthSession,
  config: CloudConfig,
  options: {
    repository?: ExplanationSyncRepository;
    transport?: ExplanationCloudTransport;
    current?: () => boolean;
  } = {},
): Promise<{ legacy: number; instructor: number }> {
  if (owner !== `${config.url}|${auth.user.id}`)
    throw Error("해설 동기화 계정이 다릅니다.");
  const local = options.repository ?? repository,
    transport = options.transport ?? new ExplanationCloudTransport(config);
  const guard = () => {
    if (options.current && !options.current())
      throw Error("계정이 바뀌어 해설 동기화를 중단했습니다.");
  };
  guard();
  await local.migrateLocal(owner);
  guard();
  const paths = await transport.list(auth);
  for (const path of paths) {
    guard();
    const before = await local.read(owner);
    if (before.received.includes(path)) continue;
    const bundle = await transport.download(path, auth);
    guard();
    await local.merge(owner, bundle);
    await local.markReceived(owner, path);
    await local.markPublished(
      owner,
      await explanationBundleFingerprint(bundle),
    );
  }
  guard();
  const snapshot = await local.read(owner),
    fingerprint = await explanationBundleFingerprint(snapshot.bundle);
  if (
    (snapshot.bundle.legacy.length || snapshot.bundle.instructor.length) &&
    !snapshot.published.includes(fingerprint)
  ) {
    const path = await transport.upload(snapshot.bundle, auth);
    guard();
    await local.markPublished(owner, fingerprint);
    await local.markReceived(owner, path);
  }
  return {
    legacy: snapshot.bundle.legacy.length,
    instructor: snapshot.bundle.instructor.length,
  };
}
