import type { Attempt, OriginalState } from "../engine";
import { activeSession, responseResult } from "../engine";
import type { OriginalData, Question } from "../model";
import { canonical } from "../../domain/schema";
import { referencedAssets } from "../validation";
import type {
  ApplyResult,
  AttemptOrder,
  BuildContext,
  BuildResult,
  EventBase,
  ReceivedEvent,
  ResolutionPayload,
  SessionPayload,
  SyncEvent,
  SyncProjection,
} from "./types";
export type * from "./types";

export function emptyProjection(): SyncProjection {
  return {
    bankVersion: 0,
    seenEvents: {},
    order: {},
    resolutions: {},
    responseConflicts: [],
    bankConflicts: [],
    recordConflicts: [],
    deferred: [],
    markVersions: {},
    questionTombstones: [],
    packageTombstones: [],
  };
}
/** Connecting an older local bank is an additive import, never a delete command.
 * Explicit server tombstones win until a separate fresh-version re-registration.
 */
export function mergeMigrationBank(
  current: OriginalData,
  incoming: OriginalData,
  projection: SyncProjection,
): OriginalData {
  const questions = new Map(
    current.questions.map((q) => [q.id, structuredClone(q)]),
  );
  const blocked = new Set(projection.questionTombstones),
    blockedPackages = new Set(projection.packageTombstones);
  const grading = (q: Question) =>
    canonical({
      body: q.body,
      choices: q.choices,
      kind: q.officialAnswer.kind,
      acceptedChoices: q.officialAnswer.acceptedChoices,
    });
  for (const q of incoming.questions) {
    if (blocked.has(q.id)) continue;
    const old = questions.get(q.id);
    if (old && old.revision > q.revision) continue;
    if (old && old.revision === q.revision && canonical(old) !== canonical(q))
      throw new Error(`기존 기록 연결: 같은 revision의 다른 문항 ${q.id}`);
    if (
      old &&
      (q.gradingRevision < old.gradingRevision ||
        (grading(q) !== grading(old) &&
          q.gradingRevision <= old.gradingRevision))
    )
      throw new Error(`기존 기록 연결: gradingRevision 충돌 ${q.id}`);
    questions.set(q.id, structuredClone(q));
  }
  const assets = new Map(
    current.assets.map((a) => [a.assetId, structuredClone(a)]),
  );
  for (const a of incoming.assets) {
    if (
      assets.has(a.assetId) &&
      canonical(assets.get(a.assetId)) !== canonical(a)
    )
      throw new Error(`기존 기록 연결: 같은 assetId의 다른 그림 ${a.assetId}`);
    assets.set(a.assetId, structuredClone(a));
  }
  const packages = new Map(
    current.packages.map((p) => [p.packageId, structuredClone(p)]),
  );
  for (const p of incoming.packages) {
    // Do not edit the original package into a different same-version payload.
    // Usable nondeleted questions remain in the bank even if its old file link
    // cannot be reattached safely; the original backup itself remains local.
    if (
      blockedPackages.has(p.packageId) ||
      p.questions.some((q) => blocked.has(q.id))
    )
      continue;
    const old = packages.get(p.packageId);
    if (old && old.packageVersion > p.packageVersion) continue;
    const contents = (value: typeof p) => {
      const { exportedAt: _at, ...rest } = value;
      return canonical(rest);
    };
    if (
      old &&
      old.packageVersion === p.packageVersion &&
      contents(old) !== contents(p)
    )
      throw new Error(
        `기존 기록 연결: 같은 packageVersion의 다른 문제 파일 ${p.packageId}`,
      );
    packages.set(p.packageId, structuredClone(p));
  }
  return {
    questions: [...questions.values()],
    assets: [...assets.values()],
    packages: [...packages.values()],
  };
}
function common(context: BuildContext, sequence: number): EventBase {
  return {
    protocolVersion: 1,
    eventId: crypto.randomUUID(),
    deviceId: context.deviceId,
    deviceSequence: sequence,
    baseCursor: context.baseCursor,
    createdAt: new Date().toISOString(),
  };
}
/** Called in the same local transaction as the state commit. Only closed sessions travel. */
export function buildEvents(
  previous: OriginalState,
  next: OriginalState,
  context: BuildContext,
): BuildResult {
  let sequence = context.nextSequence;
  const order = structuredClone(context.order ?? {}),
    events: SyncEvent[] = [];
  for (const a of next.attempts)
    if (!order[a.attemptId])
      order[a.attemptId] = {
        deviceId: context.deviceId,
        deviceSequence: sequence++,
        baseCursor: context.baseCursor,
        clock: context.clock ?? null,
      };
  const oldQuestions = new Map(previous.data.questions.map((q) => [q.id, q]));
  const freshQuestions = new Map(next.data.questions.map((q) => [q.id, q]));
  const oldPackages = new Set(previous.data.packages.map((p) => p.packageId)),
    freshPackages = new Set(next.data.packages.map((p) => p.packageId));
  const oldRemoved = new Set(previous.removedQuestionIds ?? []),
    freshRemoved = new Set(next.removedQuestionIds ?? []);
  if (
    canonical(previous.data) !== canonical(next.data) ||
    canonical([...oldRemoved].sort()) !== canonical([...freshRemoved].sort())
  ) {
    events.push({
      ...common(context, sequence++),
      kind: "bank",
      payload: {
        baseVersion:
          context.bankVersion +
          (context.pendingEvents ?? []).filter((e) => e.kind === "bank").length,
        data: structuredClone(next.data),
        removedQuestionIds: [...freshRemoved],
        questionTombstones: [
          ...new Set(
            [...oldQuestions.keys()]
              .filter((id) => !freshQuestions.has(id))
              .concat([...freshRemoved]),
          ),
        ],
        packageTombstones: [...oldPackages].filter(
          (id) => !freshPackages.has(id),
        ),
        restoredQuestionIds: [...freshQuestions.keys()].filter(
          (id) =>
            !freshRemoved.has(id) &&
            (!oldQuestions.has(id) || oldRemoved.has(id)),
        ),
        restoredPackageIds: [...freshPackages].filter(
          (id) => !oldPackages.has(id),
        ),
      },
    });
  }
  const priorSessions = new Map(previous.sessions.map((s) => [s.id, s]));
  for (const session of next.sessions) {
    if (
      session.status === "active" ||
      (priorSessions.get(session.id)?.status !== undefined &&
        priorSessions.get(session.id)!.status !== "active")
    )
      continue;
    const attempts = next.attempts.filter((a) => a.sessionId === session.id);
    const payload: SessionPayload = {
      session: structuredClone(session),
      attempts: structuredClone(attempts),
      order: Object.fromEntries(
        attempts.map((a) => [a.attemptId, structuredClone(order[a.attemptId])]),
      ),
    };
    validateBundle(payload);
    events.push({ ...common(context, sequence++), kind: "session", payload });
  }
  for (const questionId of new Set([
    ...Object.keys(previous.marks),
    ...Object.keys(next.marks),
  ])) {
    const value = !!next.marks[questionId];
    if (!!previous.marks[questionId] === value) continue;
    const pending = (context.pendingEvents ?? []).filter(
      (e) => e.kind === "mark" && e.payload.questionId === questionId,
    ).length;
    events.push({
      ...common(context, sequence++),
      kind: "mark",
      payload: {
        questionId,
        value,
        baseMarkVersion: (context.markVersions?.[questionId] ?? 0) + pending,
      },
    });
  }
  return { events, nextSequence: sequence, order };
}
export function createResolutionEvent(
  context: BuildContext,
  questionId: string,
  gradingRevision: number,
  attemptId: string,
  candidateAttemptIds: string[],
): SyncEvent {
  if (!candidateAttemptIds.includes(attemptId))
    throw new Error("대표 상태는 실제 충돌 응답 중에서 선택하세요.");
  return {
    ...common(context, context.nextSequence),
    kind: "resolution",
    payload: {
      questionId,
      gradingRevision,
      attemptId,
      candidateAttemptIds: [...new Set(candidateAttemptIds)].sort(),
    },
  };
}
function validateBundle(bundle: SessionPayload): void {
  const { session, attempts, order } = bundle;
  if (
    session.status === "active" ||
    !session.finishedAt ||
    (session.mode === "exam" && session.status !== "completed")
  )
    throw new Error("완료·종료한 풀이만 동기화할 수 있습니다.");
  const questions = new Map(session.questions.map((q) => [q.id, q])),
    assets = new Set(session.assets.map((a) => a.assetId));
  if (!questions.size || questions.size !== session.questions.length)
    throw new Error("풀이 문항 스냅샷 중복 또는 누락");
  for (const q of session.questions)
    if (referencedAssets(q).some((id) => !assets.has(id)))
      throw new Error("풀이의 필수 그림이 누락되었습니다.");
  const ids = new Set<string>(),
    questionIds = new Set<string>();
  for (const a of attempts) {
    const q = questions.get(a.questionId),
      meta = order[a.attemptId];
    if (
      !q ||
      a.sessionId !== session.id ||
      a.mode !== session.mode ||
      a.revision !== q.revision ||
      a.gradingRevision !== q.gradingRevision ||
      canonical(a.expectedChoices) !==
        canonical(q.officialAnswer.acceptedChoices)
    )
      throw new Error("풀이 응답과 문항 스냅샷 참조가 다릅니다.");
    if (ids.has(a.attemptId) || questionIds.has(a.questionId))
      throw new Error("풀이 묶음에 중복 응답이 있습니다.");
    if (
      ![null, "unknown", 1, 2, 3, 4].includes(a.response) ||
      a.result !== responseResult(a.response, a.expectedChoices) ||
      (session.responses[a.questionId] ?? null) !== a.response ||
      (session.mode !== "exam" && a.response === null)
    )
      throw new Error("확정 응답 또는 결과가 일치하지 않습니다.");
    if (
      !meta ||
      !Number.isSafeInteger(meta.deviceSequence) ||
      meta.deviceSequence < 1 ||
      !meta.deviceId ||
      !Number.isSafeInteger(meta.baseCursor) ||
      meta.baseCursor < 0
    )
      throw new Error("응답의 기기 내 순서 정보가 없습니다.");
    ids.add(a.attemptId);
    questionIds.add(a.questionId);
  }
  for (const q of session.questions) {
    const required = session.mode === "exam" || session.responses[q.id] != null;
    if (
      questionIds.has(q.id) !== required ||
      (session.status === "completed" && !required)
    )
      throw new Error("완료된 풀이에 응답 일부가 누락되었습니다.");
  }
}
class BankDependencyError extends Error {}
function ensureHistoricalQuestions(
  state: OriginalState,
  questions: Question[],
): void {
  const current = new Map(state.data.questions.map((q) => [q.id, q])),
    removed = new Set(state.removedQuestionIds ?? []);
  for (const q of questions) {
    const existing = current.get(q.id);
    if (existing && existing.revision < q.revision)
      throw new BankDependencyError(`문제 은행 새 버전 수신 대기: ${q.id}`);
    if (
      existing &&
      existing.revision === q.revision &&
      canonical(existing) !== canonical(q)
    )
      throw new Error(`동일 버전의 다른 풀이 스냅샷: ${q.id}`);
    if (!existing) {
      state.data.questions.push(structuredClone(q));
      current.set(q.id, q);
      removed.add(q.id);
    }
  }
  if (removed.size) state.removedQuestionIds = [...removed];
}
function retainSessionAssets(
  state: OriginalState,
  session: SessionPayload["session"],
): void {
  const needed = new Set(session.questions.flatMap(referencedAssets)),
    current = new Map(state.data.assets.map((a) => [a.assetId, a]));
  for (const asset of session.assets) {
    if (!needed.has(asset.assetId)) continue;
    const existing = current.get(asset.assetId);
    if (existing && canonical(existing) !== canonical(asset))
      throw new Error(
        `역사 스냅샷과 동일 assetId 그림이 다릅니다: ${asset.assetId}`,
      );
    if (!existing) {
      state.data.assets.push(structuredClone(asset));
      current.set(asset.assetId, asset);
    }
  }
}
function applyBank(
  state: OriginalState,
  projection: SyncProjection,
  received: ReceivedEvent,
): void {
  if (received.event.kind !== "bank") return;
  const p = received.event.payload;
  if (received.bankVersion <= projection.bankVersion) return;
  if (
    p.baseVersion !== projection.bankVersion ||
    received.bankVersion !== p.baseVersion + 1
  )
    throw new Error(
      "문제 은행 서버 버전이 맞지 않습니다. 최신 변경부터 다시 내려받으세요.",
    );
  const prior = new Map(state.data.questions.map((q) => [q.id, q]));
  for (const q of p.data.questions) {
    const old = prior.get(q.id);
    if (
      old &&
      (q.revision < old.revision ||
        (q.revision === old.revision && canonical(q) !== canonical(old)))
    )
      throw new Error(`문항 버전 또는 동일 revision 내용 충돌: ${q.id}`);
    const grading = (value: Question) =>
      canonical({
        body: value.body,
        choices: value.choices,
        kind: value.officialAnswer.kind,
        acceptedChoices: value.officialAnswer.acceptedChoices,
      });
    if (
      old &&
      (q.gradingRevision < old.gradingRevision ||
        (grading(q) !== grading(old) &&
          q.gradingRevision <= old.gradingRevision))
    )
      throw new Error(
        `채점 버전이 역행하거나 본문·정답 변경의 gradingRevision이 누락되었습니다: ${q.id}`,
      );
  }
  const priorAssets = new Map(state.data.assets.map((a) => [a.assetId, a]));
  for (const asset of p.data.assets)
    if (
      priorAssets.has(asset.assetId) &&
      canonical(priorAssets.get(asset.assetId)) !== canonical(asset)
    )
      throw new Error(`동일 assetId의 다른 그림입니다: ${asset.assetId}`);
  const priorPackages = new Map(
    state.data.packages.map((pkg) => [pkg.packageId, pkg]),
  );
  for (const pkg of p.data.packages) {
    const previous = priorPackages.get(pkg.packageId);
    const content = (value: typeof pkg) => {
      const { exportedAt: _at, ...rest } = value;
      return canonical(rest);
    };
    if (
      previous &&
      (pkg.packageVersion < previous.packageVersion ||
        (pkg.packageVersion === previous.packageVersion &&
          content(pkg) !== content(previous)))
    )
      throw new Error(`문제 파일 버전 충돌: ${pkg.packageId}`);
  }
  const tombstones = new Set(projection.questionTombstones),
    packageTombstones = new Set(projection.packageTombstones);
  p.questionTombstones.forEach((id) => tombstones.add(id));
  p.packageTombstones.forEach((id) => packageTombstones.add(id));
  (p.restoredQuestionIds ?? []).forEach((id) => tombstones.delete(id));
  (p.restoredPackageIds ?? []).forEach((id) => packageTombstones.delete(id));
  const incoming = structuredClone(p.data);
  incoming.packages = incoming.packages.filter(
    (pkg) => !packageTombstones.has(pkg.packageId),
  );
  state.data = incoming;
  state.removedQuestionIds = [
    ...new Set([
      ...p.removedQuestionIds,
      ...incoming.questions
        .filter((q) => tombstones.has(q.id))
        .map((q) => q.id),
    ]),
  ];
  for (const session of state.sessions) {
    ensureHistoricalQuestions(state, session.questions);
    retainSessionAssets(state, session);
  }
  projection.questionTombstones = [...tombstones];
  projection.packageTombstones = [...packageTombstones];
  projection.bankVersion = received.bankVersion;
}
function applyBundle(
  state: OriginalState,
  projection: SyncProjection,
  received: ReceivedEvent,
  acknowledged = true,
): void {
  if (received.event.kind !== "session") return;
  const payload = received.event.payload;
  validateBundle(payload);
  const existing = state.sessions.find((s) => s.id === payload.session.id);
  if (existing && canonical(existing) !== canonical(payload.session))
    throw new Error(
      "같은 sessionId의 다른 내용이 있어 두 기록을 보관했습니다.",
    );
  const attempts = new Map(state.attempts.map((a) => [a.attemptId, a]));
  for (const a of payload.attempts)
    if (
      attempts.has(a.attemptId) &&
      canonical(attempts.get(a.attemptId)) !== canonical(a)
    )
      throw new Error(
        "같은 attemptId의 다른 내용이 있어 자동 덮어쓰지 않았습니다.",
      );
  ensureHistoricalQuestions(state, payload.session.questions);
  retainSessionAssets(state, payload.session);
  if (!existing) state.sessions.push(structuredClone(payload.session));
  for (const a of payload.attempts) {
    if (!attempts.has(a.attemptId)) {
      state.attempts.push(structuredClone(a));
      attempts.set(a.attemptId, a);
    }
    const source = payload.order[a.attemptId],
      current = projection.order[a.attemptId];
    if (
      current &&
      (current.deviceId !== source.deviceId ||
        current.deviceSequence !== source.deviceSequence)
    )
      throw new Error("같은 응답의 원래 저장 순서가 다릅니다.");
    const firstReceipt = Math.min(
      ...[
        current?.serverSequence,
        source.serverSequence,
        acknowledged ? received.seq : undefined,
      ].filter((seq): seq is number => seq !== undefined && seq > 0),
    );
    projection.order[a.attemptId] = {
      ...structuredClone(source),
      ...(Number.isFinite(firstReceipt)
        ? { serverSequence: firstReceipt }
        : {}),
    };
    if (!acknowledged && current?.serverSequence === undefined)
      delete projection.order[a.attemptId].serverSequence;
  }
}
function valid(a: Attempt): boolean {
  return (
    (a.response === "unknown" && a.result === "unknown") ||
    (typeof a.response === "number" &&
      [1, 2, 3, 4].includes(a.response) &&
      (a.result === "correct" || a.result === "incorrect"))
  );
}
function interval(a: Attempt, meta: AttemptOrder): [number, number] | null {
  if (
    !meta.clock ||
    !Number.isFinite(meta.clock.offsetMs) ||
    !Number.isFinite(meta.clock.uncertaintyMs) ||
    meta.clock.uncertaintyMs < 0
  )
    return null;
  const age =
    meta.clock.sampledAt === undefined
      ? 0
      : Math.abs(Date.parse(a.answeredAt) - Date.parse(meta.clock.sampledAt));
  // A conservative product policy, not a claim about a device's clock accuracy.
  if (!Number.isFinite(age) || age > 24 * 60 * 60 * 1000) return null;
  const uncertainty = meta.clock.uncertaintyMs + age * 0.001;
  const center = Date.parse(a.answeredAt) + meta.clock.offsetMs;
  return Number.isFinite(center)
    ? [center - uncertainty, center + uncertainty]
    : null;
}
function before(
  a: Attempt,
  b: Attempt,
  order: Record<string, AttemptOrder>,
): boolean {
  const left = order[a.attemptId],
    right = order[b.attemptId];
  if (!left || !right) return false;
  if (left.deviceId === right.deviceId)
    return left.deviceSequence < right.deviceSequence;
  if (
    left.serverSequence !== undefined &&
    right.baseCursor >= left.serverSequence
  )
    return true;
  if (
    right.serverSequence !== undefined &&
    left.baseCursor >= right.serverSequence
  )
    return false;
  const l = interval(a, left),
    r = interval(b, right);
  return !!l && !!r && l[1] < r[0];
}
/** Stable chronological merge, with within-device commit order and observed
 * server events as causal edges. Unknown cross-device order is exposed as K. */
function orderAttempts(state: OriginalState, projection: SyncProjection): void {
  state.attempts.forEach((a, i) => {
    if (!projection.order[a.attemptId])
      projection.order[a.attemptId] = {
        deviceId: "local-unattributed",
        deviceSequence: i + 1,
        baseCursor: 0,
        clock: null,
      };
  });
  const rows = [...state.attempts].sort((a, b) =>
    a.attemptId.localeCompare(b.attemptId),
  );
  const byDevice = new Map<string, Attempt[]>();
  for (const a of rows) {
    const device = projection.order[a.attemptId].deviceId;
    const group = byDevice.get(device) ?? [];
    group.push(a);
    byDevice.set(device, group);
  }
  const edges = new Map(rows.map((a) => [a.attemptId, new Set<string>()])),
    degrees = new Map(rows.map((a) => [a.attemptId, 0]));
  const addEdge = (from: Attempt, to: Attempt) => {
    if (
      from.attemptId === to.attemptId ||
      edges.get(from.attemptId)!.has(to.attemptId)
    )
      return;
    edges.get(from.attemptId)!.add(to.attemptId);
    degrees.set(to.attemptId, degrees.get(to.attemptId)! + 1);
  };
  const observed = new Map<string, { seq: number; row: Attempt }[]>();
  for (const [device, group] of byDevice) {
    group.sort(
      (a, b) =>
        projection.order[a.attemptId].deviceSequence -
          projection.order[b.attemptId].deviceSequence ||
        a.attemptId.localeCompare(b.attemptId),
    );
    group.forEach((a, i) => {
      if (i) addEdge(group[i - 1], a);
    });
    const remote = group
      .filter((a) => projection.order[a.attemptId].serverSequence !== undefined)
      .sort(
        (a, b) =>
          projection.order[a.attemptId].serverSequence! -
          projection.order[b.attemptId].serverSequence!,
      );
    let last: Attempt | undefined;
    observed.set(
      device,
      remote.map((a) => {
        if (
          !last ||
          projection.order[a.attemptId].deviceSequence >
            projection.order[last.attemptId].deviceSequence
        )
          last = a;
        return {
          seq: projection.order[a.attemptId].serverSequence!,
          row: last,
        };
      }),
    );
  }
  for (const target of rows) {
    const meta = projection.order[target.attemptId];
    for (const [device, prefix] of observed) {
      if (device === meta.deviceId) continue;
      let lo = 0,
        hi = prefix.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (prefix[mid].seq <= meta.baseCursor) lo = mid + 1;
        else hi = mid;
      }
      if (lo) addEdge(prefix[lo - 1].row, target);
    }
  }
  const byId = new Map(rows.map((a) => [a.attemptId, a]));
  const rank = (a: Attempt, b: Attempt) => {
    const left = interval(a, projection.order[a.attemptId]),
      right = interval(b, projection.order[b.attemptId]);
    const time =
      (left ? (left[0] + left[1]) / 2 : Date.parse(a.answeredAt)) -
      (right ? (right[0] + right[1]) / 2 : Date.parse(b.answeredAt));
    return (
      time ||
      projection.order[a.attemptId].deviceId.localeCompare(
        projection.order[b.attemptId].deviceId,
      ) ||
      projection.order[a.attemptId].deviceSequence -
        projection.order[b.attemptId].deviceSequence ||
      a.attemptId.localeCompare(b.attemptId)
    );
  };
  // Devices are few; a sorted ready queue keeps this deterministic without an
  // all-attempt-pairs comparison. Every edge is processed once.
  const ready = rows.filter((a) => degrees.get(a.attemptId) === 0).sort(rank),
    result: Attempt[] = [];
  const insertReady = (a: Attempt) => {
    let lo = 0,
      hi = ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rank(ready[mid], a) <= 0) lo = mid + 1;
      else hi = mid;
    }
    ready.splice(lo, 0, a);
  };
  while (ready.length) {
    const a = ready.shift()!;
    result.push(a);
    for (const id of edges.get(a.attemptId)!) {
      degrees.set(id, degrees.get(id)! - 1);
      if (degrees.get(id) === 0) insertReady(byId.get(id)!);
    }
  }
  if (result.length !== rows.length)
    throw new Error(
      "응답 순서 메타데이터에 순환이 있습니다. 원본 기록을 보존하고 확인하세요.",
    );
  state.attempts = result;
  const current = new Map(state.data.questions.map((q) => [q.id, q])),
    candidates = new Map<string, Map<string, Attempt>>();
  const unfinished = new Set(
    state.sessions
      .filter((s) => s.mode === "exam" && s.status !== "completed")
      .map((s) => s.id),
  );
  for (const a of state.attempts) {
    const q = current.get(a.questionId);
    if (
      !q ||
      a.gradingRevision !== q.gradingRevision ||
      !valid(a) ||
      (a.mode === "exam" && unfinished.has(a.sessionId))
    )
      continue;
    const group = candidates.get(q.id) ?? new Map<string, Attempt>(),
      device = projection.order[a.attemptId].deviceId;
    const prior = group.get(device);
    if (
      !prior ||
      projection.order[a.attemptId].deviceSequence >
        projection.order[prior.attemptId].deviceSequence
    )
      group.set(device, a);
    candidates.set(q.id, group);
  }
  projection.responseConflicts = [];
  for (const [questionId, perDevice] of candidates) {
    const all = [...perDevice.values()],
      maximal = all.filter(
        (a) => !all.some((b) => a !== b && before(a, b, projection.order)),
      );
    const q = current.get(questionId)!,
      resolution = projection.resolutions[questionId];
    const candidateIds = maximal.map((a) => a.attemptId).sort();
    const selected =
      resolution?.gradingRevision === q.gradingRevision &&
      candidateIds.length > 1 &&
      canonical([...resolution.candidateAttemptIds].sort()) ===
        canonical(candidateIds)
        ? maximal.find((a) => a.attemptId === resolution.attemptId)
        : maximal.length === 1
          ? maximal[0]
          : undefined;
    if (!selected) {
      if (maximal.length > 1)
        projection.responseConflicts.push({
          questionId,
          gradingRevision: q.gradingRevision,
          attemptIds: candidateIds,
        });
      continue;
    }
    // The chosen actual record becomes the representative without changing its
    // identity, timestamp, response, grade, or any preserved history.
    const index = state.attempts.findIndex(
      (a) => a.attemptId === selected.attemptId,
    );
    let last = index;
    state.attempts.forEach((a, i) => {
      if (
        a.questionId === questionId &&
        a.gradingRevision === q.gradingRevision &&
        valid(a)
      )
        last = i;
    });
    if (index < last) {
      state.attempts.splice(index, 1);
      state.attempts.splice(last, 0, selected);
    }
  }
}
export function getOrderConflictIds(projection: SyncProjection): string[] {
  return projection.responseConflicts.map((c) => c.questionId);
}

/** Recompute local committed answers without pretending that the server saw them. */
export function reconcileOrder(
  original: OriginalState,
  existing: SyncProjection,
): ApplyResult {
  const state = structuredClone(original),
    projection = structuredClone(existing);
  orderAttempts(state, projection);
  return { state, projection };
}

/** Migration preview only. Local changes already live in the transactional
 * outbox; this helper must never acknowledge them or advance the server cursor.
 */
export function applyLocalEvents(
  original: OriginalState,
  existing: SyncProjection,
  events: SyncEvent[],
): ApplyResult {
  const state = structuredClone(original),
    projection = structuredClone(existing);
  for (const event of events) {
    if (
      activeSession(state) &&
      (event.kind === "bank" || event.kind === "session")
    )
      throw new Error("진행 중인 풀이를 종료한 뒤 기존 기록을 연결하세요.");
    const received: ReceivedEvent = {
      event,
      seq: 0,
      bankVersion:
        event.kind === "bank"
          ? event.payload.baseVersion + 1
          : projection.bankVersion,
    };
    if (event.kind === "bank") applyBank(state, projection, received);
    else if (event.kind === "session")
      applyBundle(state, projection, received, false);
    else if (event.kind === "mark")
      state.marks[event.payload.questionId] = event.payload.value;
    else {
      const p = event.payload,
        attempt = state.attempts.find((a) => a.attemptId === p.attemptId);
      if (
        !attempt ||
        attempt.questionId !== p.questionId ||
        attempt.gradingRevision !== p.gradingRevision ||
        !p.candidateAttemptIds.includes(p.attemptId)
      )
        throw new Error("대표 상태로 선택한 실제 응답이 없습니다.");
      projection.resolutions[p.questionId] = {
        ...structuredClone(p),
        serverSequence: 0,
        eventId: event.eventId,
      };
    }
  }
  projection.bankVersion = existing.bankVersion;
  orderAttempts(state, projection);
  return { state, projection };
}

export function applyEvents(
  original: OriginalState,
  existing: SyncProjection,
  received: ReceivedEvent[],
): ApplyResult {
  let state = structuredClone(original),
    projection = structuredClone(existing);
  const queue = [
    ...new Map(
      [...projection.deferred, ...received].map((e) => [e.event.eventId, e]),
    ).values(),
  ].sort(
    (a, b) => a.seq - b.seq || a.event.eventId.localeCompare(b.event.eventId),
  );
  projection.deferred = [];
  for (const item of queue) {
    const event = item.event;
    if (projection.seenEvents[event.eventId] !== undefined) continue;
    if (
      event.protocolVersion !== 1 ||
      !Number.isSafeInteger(item.seq) ||
      item.seq < 1
    )
      throw new Error("지원하지 않는 동기화 이벤트입니다.");
    if (
      activeSession(state) &&
      (event.kind === "bank" || event.kind === "session")
    ) {
      projection.deferred.push(item);
      continue;
    }
    const candidate = structuredClone(state),
      nextProjection = structuredClone(projection);
    try {
      if (event.kind === "bank") applyBank(candidate, nextProjection, item);
      else if (event.kind === "session")
        applyBundle(candidate, nextProjection, item);
      else if (event.kind === "mark") {
        const p = event.payload,
          version = item.markVersion ?? p.baseMarkVersion + 1;
        if (version > (nextProjection.markVersions[p.questionId] ?? 0)) {
          candidate.marks[p.questionId] = p.value;
          nextProjection.markVersions[p.questionId] = version;
        }
      } else {
        const p: ResolutionPayload = event.payload,
          a = candidate.attempts.find((a) => a.attemptId === p.attemptId);
        if (
          !a ||
          a.questionId !== p.questionId ||
          a.gradingRevision !== p.gradingRevision ||
          !p.candidateAttemptIds.includes(p.attemptId)
        )
          throw new Error("해결할 실제 응답 참조를 찾을 수 없습니다.");
        const prior = nextProjection.resolutions[p.questionId];
        if (!prior || prior.serverSequence < item.seq)
          nextProjection.resolutions[p.questionId] = {
            ...structuredClone(p),
            serverSequence: item.seq,
            eventId: event.eventId,
          };
      }
      nextProjection.seenEvents[event.eventId] = item.seq;
      state = candidate;
      projection = nextProjection;
    } catch (error) {
      if (event.kind === "session" && error instanceof BankDependencyError) {
        projection.deferred.push(item);
        continue;
      }
      const conflict = {
        eventId: event.eventId,
        kind: event.kind,
        reason: error instanceof Error ? error.message : String(error),
        event: structuredClone(event),
      };
      const list =
        event.kind === "bank"
          ? projection.bankConflicts
          : projection.recordConflicts;
      if (!list.some((c) => c.eventId === event.eventId)) list.push(conflict);
      // This is an accepted server event even when its bank body must remain
      // held locally. Keep the observed CAS version current so a later valid
      // bank or explicit conflict merge can recover instead of deadlocking.
      if (
        event.kind === "bank" &&
        item.bankVersion === event.payload.baseVersion + 1
      )
        projection.bankVersion = Math.max(
          projection.bankVersion,
          item.bankVersion,
        );
      projection.seenEvents[event.eventId] = item.seq;
    }
  }
  orderAttempts(state, projection);
  return { state, projection };
}
