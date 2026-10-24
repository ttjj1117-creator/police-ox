import {
  canonical,
  parseDataset,
  type Attempt,
  type Basis,
  type Dataset,
  type Session,
  type State,
} from "../domain/schema";
import { backup, mergeDataset, validateBackup } from "../data/transfer";
import { initialState } from "../fixtures/data";
import type {
  ApplyResult,
  AttemptOrder,
  BuildResult,
  Context,
  EventBase,
  Projection,
  ReceivedEvent,
  SessionPayload,
  SyncEvent,
} from "./types";
export type * from "./types";
export const active = (state: State) =>
  state.sessions.some((s) => s.status === "active");
export const keyOf = (id: string, basis: Basis) => JSON.stringify([id, basis]);
export function markParts(key: string): [string, Basis] {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    throw new Error("OX 표시 키가 올바르지 않습니다.");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !value[0] ||
    !["exam", "current"].includes(value[1]) ||
    key.length > 16384
  )
    throw new Error("OX 표시 키가 올바르지 않거나 너무 깁니다.");
  return value as [string, Basis];
}
export function emptyProjection(): Projection {
  return {
    bankVersion: 0,
    seenEvents: {},
    fingerprints: {},
    order: {},
    representatives: {},
    resolutions: {},
    conflicts: [],
    responseConflicts: [],
    deferred: [],
    markVersions: {},
    itemTombstones: [],
  };
}
export function validateState(state: unknown): State {
  return validateBackup(
    { ...backup(initialState(false), "real"), state },
    "real",
  );
}
const content = (dataset: Dataset) => {
  const { exportedAt: _at, ...rest } = dataset;
  return canonical(rest);
};
export function mergeMigrationBank(
  current: Dataset,
  incoming: Dataset,
  projection: Projection,
): Dataset {
  const blocked = new Set(projection.itemTombstones),
    oldItems = new Map(current.items.map((i) => [i.id, i])),
    oldNodes = new Map(current.taxonomies.map((t) => [t.id, t]));
  return mergeDataset(current, {
    ...incoming,
    items: incoming.items.filter(
      (i) =>
        !blocked.has(i.id) &&
        (!oldItems.has(i.id) || oldItems.get(i.id)!.revision <= i.revision),
    ),
    taxonomies: incoming.taxonomies.filter(
      (t) =>
        !oldNodes.has(t.id) ||
        oldNodes.get(t.id)!.taxonomyVersion <= t.taxonomyVersion,
    ),
  }).dataset;
}
function common(context: Context, sequence: number): EventBase {
  return {
    protocolVersion: 1,
    eventId: crypto.randomUUID(),
    deviceId: context.deviceId,
    deviceSequence: sequence,
    baseCursor: context.baseCursor,
    createdAt: new Date().toISOString(),
  };
}
const wireSession = (session: Session): Session => ({
  ...structuredClone(session),
  cycleKey: null,
});
export function buildEvents(
  previous: State,
  next: State,
  context: Context,
): BuildResult {
  let sequence = context.nextSequence;
  const events: SyncEvent[] = [],
    order = structuredClone(context.order ?? {});
  if (
    (active(previous) || active(next)) &&
    content(previous.dataset) !== content(next.dataset)
  )
    throw new Error("진행 중 OX 학습을 종료한 뒤 문제은행을 변경하세요.");
  for (const session of previous.sessions.filter(
    (s) => s.status !== "active",
  )) {
    const fresh = next.sessions.find((s) => s.id === session.id);
    if (
      !fresh ||
      canonical(wireSession(session)) !== canonical(wireSession(fresh)) ||
      canonical(previous.attempts.filter((a) => a.sessionId === session.id)) !==
        canonical(next.attempts.filter((a) => a.sessionId === session.id))
    )
      throw new Error(
        "동기화한 OX 완료 기록은 변경하거나 삭제할 수 없습니다. 원본 백업을 보관하세요.",
      );
  }
  for (const a of next.attempts)
    if (!order[a.attemptId])
      order[a.attemptId] = {
        deviceId: context.deviceId,
        deviceSequence: sequence++,
        baseCursor: context.baseCursor,
        clock: context.clock ?? null,
      };
  if (content(previous.dataset) !== content(next.dataset)) {
    const oldIds = new Set(previous.dataset.items.map((i) => i.id)),
      ids = new Set(next.dataset.items.map((i) => i.id));
    events.push({
      ...common(context, sequence++),
      kind: "bank",
      payload: {
        baseVersion:
          context.bankVersion +
          (context.pendingEvents ?? []).filter((e) => e.kind === "bank").length,
        dataset: structuredClone(next.dataset),
        itemTombstones: [...oldIds].filter((id) => !ids.has(id)),
        restoredItemIds: [...ids].filter((id) => !oldIds.has(id)),
      },
    });
  }
  const sessions = new Map(previous.sessions.map((s) => [s.id, s]));
  for (const session of next.sessions) {
    if (
      session.status === "active" ||
      (sessions.has(session.id) &&
        sessions.get(session.id)!.status !== "active")
    )
      continue;
    const attempts = next.attempts.filter((a) => a.sessionId === session.id),
      payload = {
        session: wireSession(session),
        attempts: structuredClone(attempts),
        order: Object.fromEntries(
          attempts.map((a) => [a.attemptId, order[a.attemptId]]),
        ),
      };
    validateBundle(payload);
    events.push({ ...common(context, sequence++), kind: "session", payload });
  }
  for (const key of new Set([
    ...Object.keys(previous.marks),
    ...Object.keys(next.marks),
  ])) {
    if (!!previous.marks[key] === !!next.marks[key]) continue;
    markParts(key);
    // Deleting an item drops its mark with the bank rather than reviving a dangling mark.
    if (!next.dataset.items.some((i) => i.id === markParts(key)[0])) continue;
    const pending = (context.pendingEvents ?? []).filter(
      (e) => e.kind === "mark" && e.payload.questionId === key,
    ).length;
    events.push({
      ...common(context, sequence++),
      kind: "mark",
      payload: {
        questionId: key,
        value: !!next.marks[key],
        baseMarkVersion: (context.markVersions?.[key] ?? 0) + pending,
      },
    });
  }
  return { events, nextSequence: sequence, order };
}
function validateBundle(payload: SessionPayload): void {
  if (payload.session.status === "active" || payload.session.cycleKey !== null)
    throw new Error("완료·종료 세션만 OX 동기화할 수 있습니다.");
  const state = initialState(false);
  state.sessions = [payload.session];
  state.attempts = payload.attempts;
  validateState(state);
  for (const a of payload.attempts) {
    const o = payload.order[a.attemptId];
    if (
      !o ||
      !o.deviceId ||
      !Number.isSafeInteger(o.deviceSequence) ||
      o.deviceSequence < 1 ||
      !Number.isSafeInteger(o.baseCursor) ||
      o.baseCursor < 0
    )
      throw new Error("OX 응답 저장 순서가 누락되었습니다.");
  }
}
function interval(a: Attempt, o: AttemptOrder): [number, number] | null {
  const c = o.clock;
  if (
    !c ||
    !Number.isFinite(c.offsetMs) ||
    !Number.isFinite(c.uncertaintyMs) ||
    c.uncertaintyMs < 0
  )
    return null;
  const age =
    c.sampledAt === undefined
      ? 0
      : Math.abs(Date.parse(a.answeredAt) - Date.parse(c.sampledAt));
  if (!Number.isFinite(age) || age > 86400000) return null;
  const center = Date.parse(a.answeredAt) + c.offsetMs,
    u = c.uncertaintyMs + age * 0.001;
  return Number.isFinite(center) ? [center - u, center + u] : null;
}
function before(
  a: Attempt,
  b: Attempt,
  order: Record<string, AttemptOrder>,
): boolean {
  const l = order[a.attemptId],
    r = order[b.attemptId];
  if (!l || !r) return false;
  if (l.deviceId === r.deviceId) return l.deviceSequence < r.deviceSequence;
  if (l.serverSequence !== undefined && r.baseCursor >= l.serverSequence)
    return true;
  if (r.serverSequence !== undefined && l.baseCursor >= r.serverSequence)
    return false;
  const li = interval(a, l),
    ri = interval(b, r);
  return !!li && !!ri && li[1] < ri[0];
}
export function reconcileOrder(
  original: State,
  existing: Projection,
): ApplyResult {
  const state = structuredClone(original),
    projection = structuredClone(existing),
    groups = new Map<string, Map<string, Attempt>>(),
    items = new Map(state.dataset.items.map((i) => [i.id, i]));
  state.attempts.forEach((a, index) => {
    projection.order[a.attemptId] ??= {
      deviceId: "local-unattributed",
      deviceSequence: index + 1,
      baseCursor: 0,
      clock: null,
    };
    if (
      a.judgmentRevision !==
      items.get(a.itemId)?.judgments[a.basis].judgmentRevision
    )
      return;
    const key = keyOf(a.itemId, a.basis),
      perDevice = groups.get(key) ?? new Map<string, Attempt>(),
      o = projection.order[a.attemptId],
      old = perDevice.get(o.deviceId);
    if (
      !old ||
      projection.order[old.attemptId].deviceSequence < o.deviceSequence
    )
      perDevice.set(o.deviceId, a);
    groups.set(key, perDevice);
  });
  projection.representatives = {};
  projection.responseConflicts = [];
  for (const [key, devices] of groups) {
    const all = [...devices.values()],
      maximal = all.filter(
        (a) => !all.some((b) => a !== b && before(a, b, projection.order)),
      ),
      ids = maximal.map((a) => a.attemptId).sort(),
      [itemId, basis] = markParts(key),
      revision = items.get(itemId)!.judgments[basis].judgmentRevision,
      resolution = projection.resolutions[key];
    const chosen =
      maximal.length === 1
        ? maximal[0]
        : resolution?.gradingRevision === revision &&
            canonical([...resolution.candidateAttemptIds].sort()) ===
              canonical(ids)
          ? maximal.find((a) => a.attemptId === resolution.attemptId)
          : undefined;
    if (chosen) projection.representatives[key] = chosen.attemptId;
    else if (ids.length > 1)
      projection.responseConflicts.push({
        kind: "order",
        id: key,
        itemId,
        basis,
        attemptIds: ids,
        reason:
          "응답의 선후 관계를 확인할 수 없습니다. 대표 상태로 사용할 실제 기록을 선택하세요.",
      });
  }
  return { state, projection };
}
function applyOne(
  state: State,
  p: Projection,
  received: ReceivedEvent,
  local = false,
): void {
  const event = received.event;
  if (event.kind === "bank") {
    const payload = event.payload,
      incoming = parseDataset(payload.dataset);
    if (
      !Array.isArray(payload.itemTombstones) ||
      !Array.isArray(payload.restoredItemIds)
    )
      throw new Error("OX 삭제 정보가 누락되었습니다.");
    if (!local && received.bankVersion !== payload.baseVersion + 1)
      throw new Error("OX 문제은행 버전이 다릅니다.");
    if (!local && received.bankVersion <= p.bankVersion) return;
    const tombstones = new Set(p.itemTombstones);
    payload.itemTombstones.forEach((id) => tombstones.add(id));
    payload.restoredItemIds.forEach((id) => tombstones.delete(id));
    const dataset = {
      ...incoming,
      items: incoming.items.filter((i) => !tombstones.has(i.id)),
    };
    // Revision guards preserve changed same-ID bodies as a conflict, never overwrite.
    mergeDataset(state.dataset, dataset);
    state.dataset = dataset;
    for (const key of Object.keys(state.marks))
      if (!dataset.items.some((i) => i.id === markParts(key)[0]))
        delete state.marks[key];
    p.itemTombstones = [...tombstones];
    if (!local) p.bankVersion = received.bankVersion;
  } else if (event.kind === "session") {
    const payload = event.payload;
    validateBundle(payload);
    const old = state.sessions.find((s) => s.id === payload.session.id);
    if (old && canonical(wireSession(old)) !== canonical(payload.session))
      throw new Error("같은 OX sessionId의 내용이 달라 원본을 보관했습니다.");
    const attempts = new Map(state.attempts.map((a) => [a.attemptId, a]));
    for (const a of payload.attempts)
      if (
        attempts.has(a.attemptId) &&
        canonical(attempts.get(a.attemptId)) !== canonical(a)
      )
        throw new Error("같은 OX attemptId의 내용이 달라 원본을 보관했습니다.");
    if (!old) state.sessions.push(structuredClone(payload.session));
    for (const a of payload.attempts) {
      if (!attempts.has(a.attemptId)) state.attempts.push(structuredClone(a));
      const source = payload.order[a.attemptId],
        prior = p.order[a.attemptId];
      if (
        prior &&
        (prior.deviceId !== source.deviceId ||
          prior.deviceSequence !== source.deviceSequence)
      )
        throw new Error("같은 OX 응답의 원래 저장 순서가 다릅니다.");
      const seq = Math.min(
        ...[prior?.serverSequence, !local ? received.seq : undefined].filter(
          (n): n is number => n !== undefined && n > 0,
        ),
      );
      p.order[a.attemptId] = {
        ...structuredClone(source),
        ...(Number.isFinite(seq) ? { serverSequence: seq } : {}),
      };
    }
  } else if (event.kind === "mark") {
    const payload = event.payload,
      [id] = markParts(payload.questionId),
      version = received.markVersion ?? payload.baseMarkVersion + 1;
    if (
      typeof payload.value !== "boolean" ||
      !Number.isSafeInteger(payload.baseMarkVersion) ||
      payload.baseMarkVersion < 0
    )
      throw new Error("OX 표시 변경 정보가 올바르지 않습니다.");
    if (version > (p.markVersions[payload.questionId] ?? 0) || local) {
      if (state.dataset.items.some((i) => i.id === id))
        state.marks[payload.questionId] = payload.value;
      if (!local) p.markVersions[payload.questionId] = version;
    }
  } else {
    const payload = event.payload,
      [id, basis] = markParts(payload.questionId),
      a = state.attempts.find((a) => a.attemptId === payload.attemptId);
    if (
      !a ||
      a.itemId !== id ||
      a.basis !== basis ||
      a.judgmentRevision !== payload.gradingRevision ||
      !payload.candidateAttemptIds.includes(a.attemptId)
    )
      throw new Error("선택한 OX 실제 응답이 없습니다.");
    const previous = p.resolutions[payload.questionId];
    if (local || !previous || previous.serverSequence < received.seq)
      p.resolutions[payload.questionId] = {
        ...structuredClone(payload),
        serverSequence: received.seq,
      };
  }
  validateState(state);
}
export function applyEvents(
  original: State,
  existing: Projection,
  events: ReceivedEvent[],
): ApplyResult {
  let state = structuredClone(original),
    projection = structuredClone(existing);
  const queue = [
    ...new Map(
      [...projection.deferred, ...events].map((e) => [e.event.eventId, e]),
    ).values(),
  ].sort(
    (a, b) => a.seq - b.seq || a.event.eventId.localeCompare(b.event.eventId),
  );
  projection.deferred = [];
  for (const received of queue) {
    const event = received.event,
      fingerprint = canonical(event);
    if (projection.seenEvents[event.eventId] !== undefined) {
      if (
        projection.fingerprints[event.eventId] !== fingerprint &&
        !projection.conflicts.some((c) => c.id === event.eventId + ":changed")
      )
        projection.conflicts.push({
          kind: "record",
          id: event.eventId + ":changed",
          reason: "같은 이벤트 ID의 다른 원본을 보관했습니다.",
          event: structuredClone(event),
        });
      continue;
    }
    if (
      event.protocolVersion !== 1 ||
      !event.eventId ||
      !["bank", "session", "mark", "resolution"].includes(event.kind) ||
      !Number.isSafeInteger(received.seq) ||
      received.seq < 1
    )
      throw new Error("지원하지 않는 OX 동기화 이벤트입니다.");
    if (active(state) && (event.kind === "bank" || event.kind === "session")) {
      projection.deferred.push(received);
      continue;
    }
    const candidate = structuredClone(state),
      next = structuredClone(projection);
    try {
      applyOne(candidate, next, received);
      state = candidate;
      projection = next;
    } catch (e) {
      projection.conflicts.push({
        kind: event.kind === "bank" ? "bank" : "record",
        id: event.eventId,
        reason: e instanceof Error ? e.message : String(e),
        event: structuredClone(event),
      });
      if (
        event.kind === "bank" &&
        received.bankVersion === event.payload.baseVersion + 1
      )
        projection.bankVersion = Math.max(
          projection.bankVersion,
          received.bankVersion,
        );
    }
    projection.seenEvents[event.eventId] = received.seq;
    projection.fingerprints[event.eventId] = fingerprint;
  }
  return reconcileOrder(state, projection);
}
export function applyLocalEvents(
  original: State,
  existing: Projection,
  events: SyncEvent[],
): ApplyResult {
  const state = structuredClone(original),
    projection = structuredClone(existing);
  if (
    active(state) &&
    events.some((e) => e.kind === "bank" || e.kind === "session")
  )
    throw new Error("진행 중 OX 학습을 먼저 종료하세요.");
  for (const event of events)
    applyOne(
      state,
      projection,
      { event, seq: 0, bankVersion: projection.bankVersion },
      true,
    );
  return reconcileOrder(state, projection);
}
