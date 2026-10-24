import { useEffect, useSyncExternalStore } from "react";
import type { Basis, Namespace, State } from "../domain/schema";
import { canonical } from "../domain/schema";
import { Repository, type Envelope } from "../data/repository";
import { backup, validateBackup } from "../data/transfer";
import { initialState } from "../fixtures/data";
import { getSharedCloudController } from "../original/sync/controller";
import type { AuthSession, CloudConfig } from "../original/sync/transport";
import { CloudError } from "../original/sync/transport";
import {
  active,
  applyEvents,
  applyLocalEvents,
  buildEvents,
  keyOf,
  mergeMigrationBank,
  validateState,
} from "./protocol";
import { OxSyncStore, contextOf } from "./store";
import { OxTransport } from "./transport";
import type {
  Conflict,
  MigrationPreview,
  ReceivedEvent,
  Snapshot,
  SyncEvent,
} from "./types";

export interface SharedAuth {
  init(env?: Record<string, unknown>): Promise<void>;
  snapshot(): {
    ready: boolean;
    ownerId: string | null;
    auth: AuthSession | null;
    config: CloudConfig | null;
  };
  subscribe(listener: () => void): () => void;
  getAuth(): Promise<AuthSession>;
}
export interface OxView {
  ready: boolean;
  ownerId: string | null;
  auth: AuthSession | null;
  config: CloudConfig | null;
  busy: boolean;
  pending: number;
  lastSuccess: string | null;
  generation: number;
  conflicts: Conflict[];
  message: string;
  error: string;
  legacyMode: boolean;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A rejected CAS predecessor cannot be skipped by its guessed-version successor. */
function nextSendable(events: SyncEvent[], failures: Record<string, string>) {
  let bankBlocked = false;
  const marksBlocked = new Set<string>();
  for (const event of events) {
    if (failures[event.eventId]) {
      if (event.kind === "bank") bankBlocked = true;
      if (event.kind === "mark") marksBlocked.add(event.payload.questionId);
      continue;
    }
    if (
      (bankBlocked && event.kind !== "session") ||
      (event.kind === "mark" && marksBlocked.has(event.payload.questionId))
    )
      continue;
    return event;
  }
}
const emptyView: OxView = {
  ready: false,
  ownerId: null,
  auth: null,
  config: null,
  busy: false,
  pending: 0,
  lastSuccess: null,
  generation: 0,
  conflicts: [],
  message: "OX 계정 정보를 확인하는 중",
  error: "",
  legacyMode: false,
};

/** Shares credentials with original study; OX data, cursors and events remain separate. */
export class OxController {
  private view: OxView = { ...emptyView };
  private listeners = new Set<() => void>();
  private enabled = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private initialization: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private authFollowing: Promise<void> = Promise.resolve();
  private transport: OxTransport | null;
  private injectedTransport: boolean;
  constructor(
    readonly store = new OxSyncStore(),
    readonly shared: SharedAuth = getSharedCloudController(),
    private legacy = new Repository(),
    transport?: OxTransport,
  ) {
    this.transport = transport ?? null;
    this.injectedTransport = !!transport;
  }
  snapshot = () => this.view;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(patch: Partial<OxView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  init(env: Record<string, unknown> = {}) {
    return (this.initialization ??= this.initialize(env));
  }
  private async initialize(env: Record<string, unknown>) {
    try {
      await this.shared.init(env);
      this.unsubscribe = this.shared.subscribe(() => {
        this.authFollowing = this.authFollowing
          .then(() => this.followAuth())
          .catch((e) =>
            this.emit({
              ready: true,
              error: errorText(e),
              message:
                "OX 기록은 보존되어 있습니다. 복구 백업과 계정 연결 상태를 확인하세요.",
            }),
          );
      });
      await (this.authFollowing = this.authFollowing.then(() =>
        this.followAuth(),
      ));
    } catch (e) {
      this.authFollowing = Promise.resolve();
      this.emit({
        ready: true,
        error: errorText(e),
        message:
          "OX 기록을 자동으로 변경하지 않았습니다. 백업과 계정 연결 상태를 확인하세요.",
      });
    }
  }
  private async followAuth() {
    const shared = this.shared.snapshot(),
      changed = shared.ownerId !== this.view.ownerId;
    let legacyMode = this.view.legacyMode;
    if (changed) {
      legacyMode = false;
      if (shared.ownerId) {
        const lease = await this.store.getValue<boolean>(
          `ox-sync:legacy-lease:${shared.ownerId}`,
        );
        legacyMode = !!lease || active(await this.store.readLegacy());
        if (legacyMode)
          await this.store.setValue(
            `ox-sync:legacy-lease:${shared.ownerId}`,
            true,
          );
      }
    }
    if (
      !this.injectedTransport &&
      shared.config &&
      (!this.transport ||
        this.transport.config.url !== shared.config.url ||
        this.transport.config.key !== shared.config.key)
    )
      this.transport = new OxTransport(shared.config);
    if (!shared.config && !this.injectedTransport) this.transport = null;
    if (this.shared.snapshot().ownerId !== shared.ownerId) return;
    this.emit({
      ready: shared.ready,
      ownerId: shared.ownerId,
      auth: shared.auth,
      config: shared.config,
      legacyMode,
      ...(changed || (!this.view.ready && shared.ready)
        ? {
            generation: 0,
            pending: 0,
            lastSuccess: null,
            conflicts: [],
            error: "",
            message: shared.ownerId
              ? "OX 계정 기록을 불러오는 중"
              : "OX 기록은 이 기기에 보관됩니다. 원문 학습과 같은 계정으로 로그인하세요.",
          }
        : {}),
    });
    if (shared.ownerId) {
      await this.reload();
      if (changed) this.schedule();
    }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) this.schedule();
  }
  schedule = () => {
    if (!this.enabled || this.running || this.timer || !this.view.ownerId)
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, 500);
  };
  async reload() {
    const owner = this.view.ownerId;
    if (!owner) return;
    const snapshot = await this.store.read(owner);
    if (this.view.ownerId !== owner) return;
    const failures = snapshot.meta.outbox
      .filter((e) => snapshot.meta.failures[e.eventId])
      .map((e) => ({
        id: e.eventId,
        kind: e.kind === "mark" ? ("mark" as const) : ("bank" as const),
        reason: snapshot.meta.failures[e.eventId],
        event: e,
      }));
    const generation = this.view.legacyMode
      ? (await this.legacy.load("real")).generation
      : snapshot.generation;
    if (this.view.ownerId !== owner) return;
    this.emit({
      generation,
      pending: snapshot.meta.outbox.length,
      lastSuccess: snapshot.meta.lastSuccess,
      conflicts: [
        ...snapshot.meta.projection.conflicts,
        ...snapshot.meta.projection.responseConflicts,
        ...failures,
      ],
    });
  }
  async load(namespace: Namespace): Promise<Envelope> {
    if (namespace !== "real" || !this.view.ownerId || this.view.legacyMode)
      return this.legacy.load(namespace);
    const s = await this.store.read(this.view.ownerId);
    return { generation: s.generation, state: s.state };
  }
  async save(
    namespace: Namespace,
    state: State,
    generation: number,
  ): Promise<Envelope> {
    if (namespace !== "real" || !this.view.ownerId || this.view.legacyMode) {
      const saved = await this.legacy.save(namespace, state, generation);
      if (namespace === "real") await this.reload();
      return saved;
    }
    const owner = this.view.ownerId,
      s = await this.store.save(owner, state, generation);
    if (this.view.ownerId !== owner)
      throw new Error(
        "계정이 변경되었습니다. 저장한 원래 계정의 기록은 보관되어 있습니다.",
      );
    await this.reload();
    this.schedule();
    return { generation: s.generation, state: s.state };
  }
  private assertOwner(owner: string) {
    if (this.view.ownerId !== owner || this.shared.snapshot().ownerId !== owner)
      throw new Error("계정이 변경되어 OX 동기화를 중단했습니다.");
  }
  private async commit(
    owner: string,
    transform: (snapshot: Snapshot) => Snapshot | Promise<Snapshot>,
  ) {
    for (let i = 0; i < 3; i++) {
      this.assertOwner(owner);
      const current = await this.store.read(owner),
        next = await transform(structuredClone(current));
      this.assertOwner(owner);
      try {
        return await this.store.write(owner, next, current.generation);
      } catch (e) {
        if (i === 2 || !/다른 탭/.test(errorText(e))) throw e;
      }
    }
    throw new Error("OX 동기화 저장 충돌");
  }
  private async apply(
    owner: string,
    events: ReceivedEvent[],
    cursor?: number,
    clock?: Snapshot["meta"]["clock"],
  ) {
    await this.commit(owner, (current) => {
      const result = applyEvents(
        current.state,
        current.meta.projection,
        events,
      );
      current.state = result.state;
      current.meta.projection = result.projection;
      if (cursor !== undefined)
        current.meta.cursor = Math.max(current.meta.cursor, cursor);
      if (clock) current.meta.clock = clock;
      return current;
    });
  }
  async sync(): Promise<void> {
    if (this.running) return this.running;
    if (!this.enabled || !this.transport || !this.view.ownerId) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.emit({
        message: "오프라인 · OX 기록은 이 기기에 저장됨. 연결 후 전송합니다.",
        error: "",
      });
      await this.reload();
      return;
    }
    const owner = this.view.ownerId;
    let continueBatch = false;
    this.emit({ busy: true, error: "", message: "OX 동기화 중" });
    this.running = (async () => {
      const auth = await this.shared.getAuth(),
        transport = this.transport!;
      this.assertOwner(owner);
      await this.apply(owner, []);
      const pullAll = async () => {
        for (let page = 0; page < 200; page++) {
          this.assertOwner(owner);
          const snapshot = await this.store.read(owner),
            result = await transport.pull(snapshot.meta.cursor, auth);
          await this.apply(owner, result.events, result.cursor, result.clock);
          if (result.events.length < 50) return;
        }
        throw new Error(
          "OX 자료가 많아 다음 묶음이 남았습니다. 지금 동기화를 다시 누르세요.",
        );
      };
      await pullAll();
      for (let i = 0; i < 100; i++) {
        this.assertOwner(owner);
        const snapshot = await this.store.read(owner),
          event = nextSendable(snapshot.meta.outbox, snapshot.meta.failures);
        if (!event) break;
        try {
          const wire = await transport.upload(event, auth),
            ack = await transport.push(wire, auth);
          if (!Number.isSafeInteger(ack.seq) || ack.seq < 1)
            throw new Error("OX 서버 수신 확인이 올바르지 않습니다.");
          await this.commit(owner, (current) => {
            current.meta.outbox = current.meta.outbox.filter(
              (e) => e.eventId !== event.eventId,
            );
            delete current.meta.failures[event.eventId];
            return current;
          });
        } catch (e) {
          if (
            (e instanceof CloudError && /version_conflict/.test(e.code)) ||
            /version_conflict|버전 충돌/i.test(errorText(e))
          ) {
            await this.commit(owner, (current) => {
              current.meta.failures[event.eventId] = errorText(e);
              return current;
            });
            continue;
          }
          throw e;
        }
      }
      await pullAll();
      await this.commit(owner, (current) => {
        if (
          !current.meta.outbox.length &&
          !current.meta.projection.deferred.length
        )
          current.meta.lastSuccess = new Date().toISOString();
        return current;
      });
      await this.reload();
      const deferred = (await this.store.read(owner)).meta.projection.deferred
        .length;
      this.assertOwner(owner);
      const remaining = await this.store.read(owner);
      continueBatch = !!nextSendable(
        remaining.meta.outbox,
        remaining.meta.failures,
      );
      this.emit({
        message: this.view.pending
          ? `이 기기에 저장됨 · OX 전송 대기 ${this.view.pending}건`
          : deferred
            ? `OX 원격 자료 ${deferred}건 대기 · 학습 종료 후 반영`
            : this.view.conflicts.length
              ? `OX 확인 필요 ${this.view.conflicts.length}건`
              : "OX 동기화 완료",
      });
    })()
      .catch(async (e) => {
        if (this.view.ownerId === owner) {
          this.emit({
            error: errorText(e),
            message: "OX 기록은 이 기기에 저장됨 · 동기화 다시 시도 필요",
          });
          await this.reload();
        }
      })
      .finally(() => {
        this.running = null;
        if (this.view.ownerId === owner) this.emit({ busy: false });
        if (continueBatch) this.schedule();
      });
    return this.running;
  }
  private async migration(current: Snapshot, imported: State) {
    if (active(imported) || active(current.state))
      throw new Error(
        "진행 중 OX 학습을 먼저 종료한 뒤 기존 자료를 연결하세요. 답안은 이 기기에 보관됩니다.",
      );
    const state = validateState(imported),
      context = contextOf(current.meta),
      projection = structuredClone(current.meta.projection);
    // Old imports never gain a newer device sequence than a live response merely
    // because they were imported later. Their original source order is separate.
    const ids = canonical(state.attempts.map((a) => a.attemptId)),
      digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(ids),
      ),
      deviceId =
        "migration:" +
        [...new Uint8Array(digest)]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
    context.order = { ...context.order };
    state.attempts.forEach((a, i) => {
      context.order![a.attemptId] ??= {
        deviceId,
        deviceSequence: i + 1,
        baseCursor: 0,
        clock: null,
      };
    });
    let merged: State;
    try {
      merged = {
        ...state,
        dataset: mergeMigrationBank(
          current.state.dataset,
          state.dataset,
          projection,
        ),
      };
    } catch (e) {
      const built = buildEvents(initialState(false), state, context),
        bank = built.events.find((e) => e.kind === "bank");
      if (
        bank &&
        !projection.conflicts.some(
          (c) =>
            c.kind === "bank" &&
            canonical(c.event?.payload) === canonical(bank.payload),
        )
      )
        projection.conflicts.push({
          kind: "bank",
          id: bank.eventId,
          reason: errorText(e),
          event: bank,
        });
      // Other closed records may still be preserved when a bank revision differs.
      merged = { ...state, dataset: current.state.dataset };
    }
    const built = buildEvents(initialState(false), merged, context),
      events: SyncEvent[] = [];
    let result = { state: current.state, projection };
    for (const event of built.events) {
      if (
        event.kind === "bank" &&
        canonical({ ...event.payload.dataset, exportedAt: "" }) ===
          canonical({ ...current.state.dataset, exportedAt: "" })
      )
        continue;
      if (event.kind === "session") {
        const old = current.state.sessions.find(
          (s) => s.id === event.payload.session.id,
        );
        if (
          old &&
          canonical({ ...old, cycleKey: null }) ===
            canonical(event.payload.session) &&
          canonical(
            current.state.attempts.filter((a) => a.sessionId === old.id),
          ) === canonical(event.payload.attempts)
        )
          continue;
      }
      if (
        event.kind === "mark" &&
        !!current.state.marks[event.payload.questionId] === event.payload.value
      )
        continue;
      if (
        current.meta.outbox.some(
          (e) =>
            canonical({ kind: e.kind, payload: e.payload }) ===
            canonical({ kind: event.kind, payload: event.payload }),
        )
      )
        continue;
      try {
        result = applyLocalEvents(result.state, result.projection, [event]);
        events.push(event);
      } catch (e) {
        if (
          !result.projection.conflicts.some(
            (c) => canonical(c.event?.payload) === canonical(event.payload),
          )
        )
          result.projection.conflicts.push({
            kind: event.kind === "bank" ? "bank" : "record",
            id: event.eventId,
            reason: errorText(e),
            event,
          });
      }
    }
    // These progress/display preferences are local. Preserve the migration source
    // on an empty account without transferring another device's live session.
    if (!current.state.dataset.items.length && !current.state.sessions.length) {
      result.state.settings = structuredClone(state.settings);
      result.state.cycles = structuredClone(state.cycles);
      result.state.allocations = structuredClone(state.allocations);
    }
    return { result, events, nextSequence: built.nextSequence };
  }
  async importPreview(value: unknown): Promise<MigrationPreview> {
    let imported: State;
    if (value && typeof value === "object" && "backupSchemaVersion" in value)
      imported = validateBackup(value, "real");
    else if (
      value &&
      typeof value === "object" &&
      "format" in value &&
      (value as { format: unknown }).format === "police-learning-backup"
    ) {
      const v = value as { namespace?: unknown; ox?: unknown };
      if (v.namespace !== "real")
        throw new Error("실제/시연 백업 영역이 다릅니다.");
      imported = validateBackup(v.ox, "real");
    } else throw new Error("기존 OX 전체 백업 JSON을 선택하세요.");
    return this.preview(imported, value);
  }
  async previewLegacy() {
    const state = await this.store.readLegacy();
    return this.preview(state, backup(state, "real"));
  }
  private async preview(
    imported: State,
    source?: unknown,
  ): Promise<MigrationPreview> {
    const owner = this.view.ownerId;
    if (!owner) throw new Error("먼저 원문 학습과 같은 계정으로 로그인하세요.");
    const current = await this.store.read(owner),
      migration = await this.migration(current, imported);
    return {
      state: imported,
      source,
      items: imported.dataset.items.length,
      sessions: imported.sessions.length,
      attempts: imported.attempts.length,
      conflicts:
        migration.result.projection.conflicts.length -
        current.meta.projection.conflicts.length,
    };
  }
  async connectExisting(imported: State, source?: unknown) {
    const owner = this.view.ownerId;
    if (!owner) throw new Error("먼저 로그인하세요.");
    const valid = validateState(imported);
    // Keep the exact import independently of the visible projection/outbox.
    const retained = source ?? backup(valid, "real"),
      key = `ox-sync:migration-source:${owner}`,
      prior = (await this.store.getValue<unknown[]>(key)) ?? [];
    if (!prior.some((v) => canonical(v) === canonical(retained)))
      await this.store.setValue(key, [...prior, retained]);
    await this.commit(owner, async (current) => {
      const m = await this.migration(current, valid);
      current.state = m.result.state;
      current.meta.projection = m.result.projection;
      current.meta.nextSequence = m.nextSequence;
      current.meta.outbox.push(...m.events);
      return current;
    });
    await this.store.setValue(`ox-sync:legacy-lease:${owner}`, false);
    this.assertOwner(owner);
    this.emit({ legacyMode: false });
    await this.reload();
    this.schedule();
  }
  async exportRecovery() {
    const owner = this.view.ownerId;
    if (!owner) throw new Error("로그인이 필요합니다.");
    return this.store.recovery(owner);
  }
  async resolveOrder(
    itemId: string,
    basis: Basis,
    attemptId: string,
    candidateAttemptIds: string[],
  ) {
    const owner = this.view.ownerId;
    if (!owner) return;
    await this.commit(owner, (current) => {
      const key = keyOf(itemId, basis),
        conflict = current.meta.projection.responseConflicts.find(
          (c) => c.id === key,
        );
      if (
        !conflict ||
        canonical([...conflict.attemptIds!].sort()) !==
          canonical([...candidateAttemptIds].sort()) ||
        !candidateAttemptIds.includes(attemptId)
      )
        throw new Error(
          "OX 응답 목록이 변경되었습니다. 최신 확인 목록을 선택하세요.",
        );
      const item = current.state.dataset.items.find((i) => i.id === itemId);
      if (!item) throw new Error("OX 문항이 없습니다.");
      const event: SyncEvent = {
        protocolVersion: 1,
        eventId: crypto.randomUUID(),
        deviceId: current.meta.deviceId,
        deviceSequence: current.meta.nextSequence++,
        baseCursor: current.meta.cursor,
        createdAt: new Date().toISOString(),
        kind: "resolution",
        payload: {
          questionId: key,
          gradingRevision: item.judgments[basis].judgmentRevision,
          attemptId,
          candidateAttemptIds: [...candidateAttemptIds],
        },
      };
      const result = applyLocalEvents(current.state, current.meta.projection, [
        event,
      ]);
      current.state = result.state;
      current.meta.projection = result.projection;
      current.meta.outbox.push(event);
      return current;
    });
    await this.reload();
    this.schedule();
  }
  async retryVersionConflict(eventId: string) {
    await this.sync();
    const owner = this.view.ownerId;
    if (!owner) return;
    await this.commit(owner, (current) => {
      if (active(current.state))
        throw new Error("진행 중 OX 학습을 먼저 종료하세요.");
      const old = current.meta.outbox.find((e) => e.eventId === eventId);
      if (!old || !current.meta.failures[eventId])
        throw new Error("재시도할 OX 버전 충돌이 없습니다.");
      const event = structuredClone(old);
      event.eventId = crypto.randomUUID();
      event.deviceSequence = current.meta.nextSequence++;
      event.baseCursor = current.meta.cursor;
      event.createdAt = new Date().toISOString();
      if (event.kind === "bank") {
        const held = current.meta.projection.conflicts
          .filter((c) => c.kind === "bank")
          .map((c) => c.event)
          .filter(
            (e): e is Extract<SyncEvent, { kind: "bank" }> =>
              e?.kind === "bank",
          )
          .at(-1);
        const latest = held
          ? mergeMigrationBank(
              current.state.dataset,
              held.payload.dataset,
              current.meta.projection,
            )
          : current.state.dataset;
        event.payload.dataset = mergeMigrationBank(
          latest,
          event.payload.dataset,
          current.meta.projection,
        );
        const removed = new Set(event.payload.itemTombstones);
        event.payload.dataset.items = event.payload.dataset.items.filter(
          (i) => !removed.has(i.id),
        );
        event.payload.baseVersion = current.meta.projection.bankVersion;
      }
      if (event.kind === "mark")
        event.payload.baseMarkVersion =
          current.meta.projection.markVersions[event.payload.questionId] ?? 0;
      const index = current.meta.outbox.findIndex((e) => e.eventId === eventId);
      for (const successor of current.meta.outbox.slice(index + 1))
        if (
          (event.kind === "bank" && successor.kind === "bank") ||
          (event.kind === "mark" &&
            successor.kind === "mark" &&
            successor.payload.questionId === event.payload.questionId)
        )
          current.meta.failures[successor.eventId] ??=
            "앞선 OX 변경을 최신 서버 값에 맞췄습니다. 이어진 변경도 원본을 확인한 뒤 직접 재시도하세요.";
      const applied = applyLocalEvents(current.state, current.meta.projection, [
        event,
      ]);
      current.state = applied.state;
      current.meta.projection = applied.projection;
      current.meta.outbox = current.meta.outbox.map((e) =>
        e.eventId === eventId ? event : e,
      );
      delete current.meta.failures[eventId];
      return current;
    });
    await this.reload();
    this.schedule();
  }
  async keepRemoteMark(eventId: string) {
    await this.sync();
    const owner = this.view.ownerId;
    if (!owner) return;
    await this.commit(owner, (current) => {
      const index = current.meta.outbox.findIndex((e) => e.eventId === eventId),
        event = current.meta.outbox[index];
      if (event?.kind !== "mark" || !current.meta.failures[eventId])
        throw new Error("확인할 OX 표시 변경이 없습니다.");
      for (const successor of current.meta.outbox.slice(index + 1))
        if (
          successor.kind === "mark" &&
          successor.payload.questionId === event.payload.questionId
        )
          current.meta.failures[successor.eventId] ??=
            "앞선 OX 표시 변경의 충돌을 확인했습니다. 이어진 변경도 최신 서버 값과 비교해 선택하세요.";
      current.meta.outbox = current.meta.outbox.filter(
        (e) => e.eventId !== eventId,
      );
      delete current.meta.failures[eventId];
      return current;
    });
    await this.reload();
    this.schedule();
  }
  async close() {
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    await this.store.close();
    await this.legacy.close();
  }
}
let singleton: OxController | null = null;
export function useOxSync(namespace: Namespace) {
  const controller = (singleton ??= new OxController());
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.init(import.meta.env);
    const local = () => {
        if (!controller.snapshot().busy) {
          void controller.reload();
          controller.schedule();
        }
      },
      focus = () => controller.schedule(),
      visibility = () => {
        if (!document.hidden) focus();
      };
    window.addEventListener("police-ox-sync-local", local);
    window.addEventListener("online", focus);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("police-ox-sync-local", local);
      window.removeEventListener("online", focus);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [controller]);
  useEffect(
    () => controller.setEnabled(namespace === "real"),
    [controller, namespace],
  );
  return { controller, ...view };
}
