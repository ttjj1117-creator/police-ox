import type { AuthSession, CloudConfig } from "../sync/transport";
import { SharedLibrary } from "../sync/shared-library";
import { ExplanationCloudTransport } from "../explanations/sync-transport";
import { parseFrequentIssuesPackage } from "./contract";
import { FrequentIssuesRepository, frequentIssuesFingerprint } from "./library";

export interface FrequentIssuesSyncOptions {
  repository?: FrequentIssuesRepository;
  transport?: ExplanationCloudTransport;
  current?: () => boolean | Promise<boolean>;
  shared?: boolean;
  sharedFetch?: typeof fetch;
}
const repository = new FrequentIssuesRepository();

/** Connection manifests use their own resource path. Existing strict clients
 * continue reading the original explanation bundle unchanged. */
export async function syncFrequentIssues(
  owner: string,
  auth: AuthSession,
  config: CloudConfig,
  options: FrequentIssuesSyncOptions = {},
): Promise<{ connections: number }> {
  if (owner !== `${config.url}|${auth.user.id}`)
    throw Error("빈출 쟁점 동기화 계정이 다릅니다.");
  const local = options.repository ?? repository;
  const transport =
    options.transport ??
    new ExplanationCloudTransport(config, undefined, "frequent-issues");
  const guard = async () => {
    if (options.current && !(await options.current()))
      throw Error(
        "계정 또는 자료 영역이 바뀌어 빈출 쟁점 동기화를 중단했습니다.",
      );
  };
  await guard();
  await local.migrateLocal(owner, guard);
  await guard();
  let snapshot = await local.readForSync(owner);
  await guard();
  const received = new Set(snapshot.received);
  const paths = await transport.list(auth);
  await guard();
  for (const path of paths) {
    if (received.has(path)) continue;
    await guard();
    const incoming = parseFrequentIssuesPackage(
      await transport.downloadValue(path, auth),
    );
    await guard();
    if (incoming.dataKind !== "real")
      throw Error("시연 연결은 실제 계정에 동기화하지 않습니다.");
    await local.merge(owner, "real", incoming, guard);
    await guard();
    await local.mark(owner, "received", path, guard);
    await guard();
    const fingerprint = await frequentIssuesFingerprint(incoming);
    await guard();
    await local.mark(owner, "published", fingerprint, guard);
    await guard();
  }
  snapshot = await local.readForSync(owner);
  await guard();
  if (options.shared && !snapshot.handoff) {
    const source = new SharedLibrary(config, auth, options.sharedFetch);
    const raw = await source.getFrequentIssues();
    await guard();
    if (raw !== null) {
      const incoming = parseFrequentIssuesPackage(raw);
      if (incoming.dataKind !== "real")
        throw Error("시연 연결은 실제 계정에 동기화하지 않습니다.");
      await local.merge(owner, "real", incoming, guard);
      await guard();
      const fingerprint = await frequentIssuesFingerprint(incoming);
      await guard();
      await local.mark(owner, "published", fingerprint, guard);
      await guard();
      snapshot = await local.readForSync(owner);
      await guard();
    }
  }
  if (!snapshot.handoff) return { connections: 0 };
  const fingerprint = await frequentIssuesFingerprint(snapshot.handoff);
  await guard();
  if (!snapshot.published.includes(fingerprint)) {
    const path = await transport.uploadValue(snapshot.handoff, auth);
    await guard();
    await local.mark(owner, "published", fingerprint, guard);
    await guard();
    await local.mark(owner, "received", path, guard);
    await guard();
  }
  return { connections: snapshot.handoff.questionIndex.length };
}
