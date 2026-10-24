import { holdSuccessors, nextSendable } from "./queue";
import { useEffect, useSyncExternalStore } from "react";
import {
  activeSession,
  initialOriginalState,
  type OriginalState,
} from "../engine";
import { validateFullBackup, validateOriginalState } from "../storage";
import {
  applyEvents,
  applyLocalEvents,
  buildEvents,
  createResolutionEvent,
  getOrderConflictIds,
  mergeMigrationBank,
} from "./protocol";
import {
  SyncAccountStore,
  type AccountSnapshot,
  type SyncLocal,
} from "./local";
import {
  cloudConfig,
  CloudError,
  SupabaseTransport,
  type AuthSession,
  type CloudConfig,
} from "./transport";
import type { ReceivedEvent, SyncEvent } from "./types";
import { usableClock } from "./clock";
import {
  authReturnUrl,
  captureAuthRedirect,
  type AuthRedirect,
} from "./auth-link";

// Runs synchronously during module evaluation, before React and startup IO.
const incomingAuthRedirect = captureAuthRedirect();

export interface CloudView {
  ready: boolean;
  config: CloudConfig | null;
  auth: AuthSession | null;
  ownerId: string | null;
  busy: boolean;
  message: string;
  error: string;
  pending: number;
  lastSuccess: string | null;
  meta: SyncLocal | null;
  generation: number;
  conflictIds: string[];
}
const initialView: CloudView = {
  ready: false,
  config: null,
  auth: null,
  ownerId: null,
  busy: false,
  message: "설정을 확인하는 중",
  error: "",
  pending: 0,
  lastSuccess: null,
  meta: null,
  generation: 0,
  conflictIds: [],
};
export class CloudController {
  readonly store: SyncAccountStore;
  private view = initialView;
  private listeners = new Set<() => void>();
  private transport: SupabaseTransport | null = null;
  private enabled = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private initialization: Promise<void> | null = null;
  private refreshPromise: Promise<AuthSession> | null = null;
  private signingOut = false;
  constructor(
    store = new SyncAccountStore(),
    transport?: SupabaseTransport,
    private authRedirect: AuthRedirect = incomingAuthRedirect,
  ) {
    this.store = store;
    if (transport) this.transport = transport;
  }
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit(patch: Partial<CloudView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private owner(auth: AuthSession) {
    return `${this.view.config!.url}|${auth.user.id}`;
  }
  private authKey() {
    return `sync:auth:${this.view.config!.url}`;
  }
  init(env: Record<string, unknown> = {}) {
    return (this.initialization ??= this.initialize(env));
  }
  private async initialize(env: Record<string, unknown>) {
    try {
      const config =
        this.transport?.config ??
        (await this.store.getValue<CloudConfig>("sync:public-config")) ??
        cloudConfig(env);
      this.transport = config
        ? (this.transport ??
          new SupabaseTransport(
            cloudConfig({
              VITE_SUPABASE_URL: config.url,
              VITE_SUPABASE_PUBLISHABLE_KEY: config.key,
            })!,
          ))
        : null;
      this.emit({
        config,
        message: config
          ? "로그인하여 기기 간 기록을 공유하세요."
          : "동기화 설정 필요 · 이 기기의 학습은 계속 사용할 수 있습니다.",
      });
      if (config) {
        const auth = await this.store.getValue<AuthSession>(this.authKey());
        if (auth?.user?.id && auth.access_token && auth.refresh_token) {
          this.emit({ auth, ownerId: this.owner(auth) });
          await this.reload();
        }
      }
      if (this.authRedirect.kind === "error")
        throw new Error(this.authRedirect.message);
      if (this.authRedirect.kind === "session") {
        if (!this.transport)
          throw new Error(
            "동기화 서버 설정을 확인한 뒤 새 로그인 메일을 요청하세요.",
          );
        const auth = await this.transport.acceptLink(this.authRedirect.tokens);
        await this.establishSession(auth);
        this.emit({
          message:
            "이메일 링크로 로그인했습니다. 기존 PC 기록은 미리보기 후 직접 연결할 수 있습니다.",
          error: "",
        });
      }
      this.emit({ ready: true });
      this.schedule();
    } catch (e) {
      this.emit({
        ready: true,
        error: message(e),
        message: "동기화 설정을 확인하세요. 로컬 기록은 유지됩니다.",
      });
    }
  }
  async configure(url: string, key: string) {
    if (this.view.auth) throw new Error("로그아웃한 뒤 연결 설정을 바꾸세요.");
    const config = cloudConfig({
      VITE_SUPABASE_URL: url.trim(),
      VITE_SUPABASE_PUBLISHABLE_KEY: key.trim(),
    });
    if (!config) throw new Error("프로젝트 URL과 공개용 키를 입력하세요.");
    await this.store.setValue("sync:public-config", config);
    this.transport = new SupabaseTransport(config);
    this.emit({
      config,
      error: "",
      message: "연결 설정을 저장했습니다. 이메일로 로그인하세요.",
    });
  }
  async sendCode(email: string) {
    if (!this.view.auth && (await this.unlinkedOxActive()))
      throw new Error(
        "진행 중 OX 학습을 종료한 뒤 로그인하세요. 기존 답안은 이 기기에 보관됩니다.",
      );
    if (!this.transport) throw new Error("동기화 연결 설정이 필요합니다.");
    await this.transport.sendCode(
      email.trim(),
      typeof window === "undefined"
        ? undefined
        : authReturnUrl(window.location.href),
    );
    this.emit({
      error: "",
      message:
        "로그인 메일을 보냈습니다. 메일의 로그인 링크를 이 앱을 사용할 브라우저에서 여세요. 인증번호가 함께 온 경우 번호로도 로그인할 수 있습니다.",
    });
  }
  async verify(email: string, code: string) {
    if (!this.transport) throw new Error("동기화 연결 설정이 필요합니다.");
    const auth = await this.transport.verify(email.trim(), code.trim());
    await this.establishSession(auth);
  }
  private async establishSession(auth: AuthSession) {
    if (this.signingOut)
      throw new Error("로그아웃이 끝난 뒤 다시 로그인하세요.");
    if (this.running) throw new Error("동기화가 끝난 뒤 다시 로그인하세요.");
    const stored = await this.store.getValue<AuthSession>(this.authKey());
    const previous = stored?.user?.id ? stored : this.view.auth;
    if (previous && previous.user.id !== auth.user.id)
      throw new Error(
        "다른 계정이 로그인되어 있습니다. 진행 중 학습을 종료하고 로그아웃한 뒤 새 로그인 메일을 요청하세요.",
      );
    // Authentication never moves anonymous data into the account bank/outbox.
    // A link bypasses disabled controls, so enforce this on durable data.
    if (!previous && activeSession(await this.store.readUnlinked()))
      throw new Error(
        "이 기기에 진행 중인 학습이 있습니다. 먼저 학습을 종료한 뒤 새 로그인 메일을 요청하세요.",
      );
    if (!previous && (await this.unlinkedOxActive()))
      throw new Error(
        "이 기기에 진행 중인 OX 학습이 있습니다. 먼저 학습을 종료한 뒤 새 로그인 메일을 요청하세요.",
      );
    await this.store.setValue(this.authKey(), auth);
    this.emit({ auth, ownerId: this.owner(auth), error: "" });
    await this.reload();
    this.schedule();
  }
  private async unlinkedOxActive() {
    const saved = await this.store.getValue<{
      state?: { sessions?: { status: string }[] };
    }>("real");
    return (
      Array.isArray(saved?.state?.sessions) &&
      saved.state.sessions.some((s) => s.status === "active")
    );
  }
  async linkedOxStatus() {
    const owner = this.view.ownerId;
    if (!owner) return { active: false, pending: 0 };
    const [saved, meta] = await Promise.all([
      this.store.getValue<{ state?: { sessions?: { status: string }[] } }>(
        "ox:real:user:" + owner,
      ),
      this.store.getValue<{ outbox?: unknown[] }>("ox-sync:real:user:" + owner),
    ]);
    return {
      active:
        Array.isArray(saved?.state?.sessions) &&
        saved.state.sessions.some((s) => s.status === "active"),
      pending: Array.isArray(meta?.outbox) ? meta.outbox.length : 0,
    };
  }
  async logout() {
    if (this.signingOut) return;
    const auth = this.view.auth;
    if (!auth || !this.transport) return;
    if (this.running) throw new Error("동기화가 끝난 뒤 로그아웃하세요.");
    const ox = await this.linkedOxStatus();
    const original = await this.store.read(this.view.ownerId!);
    if (ox.active || activeSession(original.state))
      throw new Error(
        "진행 중인 원문·OX 학습을 종료한 뒤 로그아웃하세요. 답안은 이 기기에 보관됩니다.",
      );
    this.signingOut = true;
    try {
      // Both study modes share one refresh operation. A pending refresh may not
      // restore credentials after local signout has closed this account.
      await this.refreshPromise?.catch(() => undefined);
      try {
        if (navigator.onLine)
          await this.transport.logout(this.view.auth ?? auth);
      } catch {
        /* Local signout preserves the account's durable state and outbox. */
      }
      await this.store.setValue(this.authKey(), null);
      this.emit({
        auth: null,
        ownerId: null,
        meta: null,
        conflictIds: [],
        pending: 0,
        generation: 0,
        lastSuccess: null,
        error: "",
        message:
          "로그아웃했습니다. 원문·OX 계정의 미전송 기록은 이 기기에 보관되어 같은 계정으로 다시 로그인하면 전송됩니다.",
      });
    } finally {
      this.signingOut = false;
    }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) this.schedule();
  }
  schedule = () => {
    if (!this.enabled || this.running || !this.view.auth || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, 500);
  };
  async reload() {
    if (!this.view.ownerId) return;
    const owner = this.view.ownerId,
      next = await this.store.read(owner);
    if (this.view.ownerId !== owner) return;
    this.emit({
      meta: next.meta,
      pending: next.meta.outbox.length,
      lastSuccess: next.meta.lastSuccess,
      generation: next.generation,
      conflictIds: getOrderConflictIds(next.meta.projection),
    });
  }
  /** Shared by original and OX sync; never persist a second credential copy. */
  async getAuth(): Promise<AuthSession> {
    return this.auth();
  }
  private async auth(): Promise<AuthSession> {
    const auth = this.view.auth;
    if (this.signingOut) throw new Error("로그아웃 중입니다.");
    if (!auth || !this.transport) throw new Error("로그인이 필요합니다.");
    if (auth.expires_at > Date.now() / 1000 + 60) return auth;
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const fresh = await this.transport!.refresh(auth);
        if (
          this.signingOut ||
          this.view.auth?.user.id !== fresh.user.id ||
          this.view.auth?.refresh_token !== auth.refresh_token
        )
          throw new Error("계정이 변경되었습니다. 다시 로그인하세요.");
        await this.store.setValue(this.authKey(), fresh);
        this.emit({ auth: fresh });
        return fresh;
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }
  private async commit(
    owner: string,
    transform: (
      s: AccountSnapshot,
    ) => Promise<AccountSnapshot> | AccountSnapshot,
  ) {
    for (let i = 0; i < 3; i++) {
      if (this.view.ownerId !== owner)
        throw new Error("계정이 변경되어 동기화를 중단했습니다.");
      const current = await this.store.read(owner),
        next = await transform(structuredClone(current));
      try {
        return await this.store.write(owner, next, current.generation);
      } catch (e) {
        if (i === 2 || !/다른 탭/.test(message(e))) throw e;
      }
    }
    throw new Error("동기화 저장 충돌");
  }
  private async apply(
    owner: string,
    received: ReceivedEvent[],
    cursor?: number,
    clock?: SyncLocal["clock"],
  ) {
    await this.commit(owner, async (current) => {
      const result = applyEvents(
        current.state,
        current.meta.projection,
        received,
      );
      await validateOriginalState(result.state, "real");
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
    if (!navigator.onLine) {
      this.emit({
        message: "오프라인 · 이 기기에 저장됨. 연결 후 전송합니다.",
      });
      await this.reload();
      return;
    }
    const owner = this.view.ownerId;
    this.emit({ busy: true, error: "", message: "동기화 중" });
    this.running = (async () => {
      const auth = await this.auth(),
        transport = this.transport!;
      await this.apply(owner, []);
      const pullAll = async () => {
        for (let page = 0; page < 200; page++) {
          const snapshot = await this.store.read(owner),
            result = await transport.pull(snapshot.meta.cursor, auth);
          await this.apply(owner, result.events, result.cursor, result.clock);
          if (result.events.length < 50) return;
        }
        throw new Error(
          "자료가 많아 다음 묶음 다운로드가 필요합니다. 지금 동기화를 다시 누르세요.",
        );
      };
      await pullAll();
      for (let i = 0; i < 100; i++) {
        const snapshot = await this.store.read(owner),
          event = nextSendable(snapshot.meta);
        if (!event) break;
        try {
          const wire = await transport.upload(event, auth),
            ack = await transport.push(wire, auth);
          if (!Number.isSafeInteger(ack.seq) || ack.seq < 1)
            throw new Error("서버 수신 확인이 올바르지 않습니다.");
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
            /version_conflict|버전 충돌/i.test(message(e))
          ) {
            await this.commit(owner, (current) => {
              current.meta.failures[event.eventId] = message(e);
              holdSuccessors(
                current.meta,
                event.eventId,
                "선행 변경의 버전 충돌로 확인이 필요합니다.",
              );
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
      this.emit({
        message: this.view.pending
          ? `이 기기에 저장됨 · 전송 대기 ${this.view.pending}건`
          : this.view.meta?.projection.deferred.length
            ? `원격 자료 ${this.view.meta.projection.deferred.length}건 대기 · 학습 종료 후 반영`
            : this.view.conflictIds.length
              ? `응답 순서 확인 필요 ${this.view.conflictIds.length}문항`
              : "동기화 완료",
      });
    })()
      .catch(async (e) => {
        this.emit({
          error: message(e),
          message: "이 기기에 저장됨 · 동기화 다시 시도 필요",
        });
        await this.reload();
      })
      .finally(() => {
        this.running = null;
        this.emit({ busy: false });
      });
    return this.running;
  }
  async importPreview(value?: unknown): Promise<{
    state: OriginalState;
    source?: unknown;
    questions: number;
    sessions: number;
    attempts: number;
    conflicts: number;
  }> {
    const imported = value
      ? (await validateFullBackup(value, "real")).original
      : await this.store.readUnlinked();
    await validateOriginalState(imported, "real");
    const current = await this.store.read(this.view.ownerId!);
    const merged = {
      ...imported,
      data: mergeMigrationBank(
        current.state.data,
        imported.data,
        current.meta.projection,
      ),
      removedQuestionIds: [
        ...new Set([
          ...(current.state.removedQuestionIds ?? []),
          ...(imported.removedQuestionIds ?? []),
        ]),
      ],
    };
    const built = buildEvents(
      initialOriginalState("real"),
      merged,
      this.context(current.meta),
    );
    const preview = applyLocalEvents(
      current.state,
      current.meta.projection,
      built.events,
    );
    return {
      state: imported,
      source: value,
      questions: imported.data.questions.length,
      sessions: imported.sessions.filter((s) => s.status !== "active").length,
      attempts: imported.attempts.filter(
        (a) =>
          imported.sessions.find((s) => s.id === a.sessionId)?.status !==
          "active",
      ).length,
      conflicts:
        preview.projection.bankConflicts.length +
        preview.projection.recordConflicts.length,
    };
  }
  private context(meta: SyncLocal) {
    return {
      deviceId: meta.deviceId,
      nextSequence: meta.nextSequence,
      baseCursor: meta.cursor,
      bankVersion: meta.projection.bankVersion,
      clock: usableClock(meta.clock),
      order: meta.projection.order,
      markVersions: meta.projection.markVersions,
      pendingEvents: meta.outbox,
    };
  }
  async connectExisting(imported: OriginalState, source?: unknown) {
    const owner = this.view.ownerId;
    if (!owner) throw new Error("먼저 로그인하세요.");
    if (source)
      await this.store.setValue(`sync:migration-source:${owner}`, source);
    await this.commit(owner, async (current) => {
      if (activeSession(current.state))
        throw new Error("진행 중 학습을 종료한 뒤 기록을 연결하세요.");
      const merged = {
        ...imported,
        data: mergeMigrationBank(
          current.state.data,
          imported.data,
          current.meta.projection,
        ),
        removedQuestionIds: [
          ...new Set([
            ...(current.state.removedQuestionIds ?? []),
            ...(imported.removedQuestionIds ?? []),
          ]),
        ],
      };
      const built = buildEvents(
        initialOriginalState("real"),
        merged,
        this.context(current.meta),
      );
      const events = built.events.filter(
        (event) =>
          !current.meta.outbox.some(
            (existing) => canonicalEvent(existing) === canonicalEvent(event),
          ),
      );
      // Import is a merge of closed records, never a cloud reset or active-session transfer.
      const result = applyLocalEvents(
        current.state,
        { ...current.meta.projection, order: built.order },
        events,
      );
      current.state = await validateOriginalState(result.state, "real");
      current.meta.projection = result.projection;
      current.meta.nextSequence = built.nextSequence;
      current.meta.outbox.push(...events);
      return current;
    });
    await this.reload();
    this.schedule();
  }
  async resolve(
    questionId: string,
    gradingRevision: number,
    attemptId: string,
    candidateAttemptIds: string[],
  ) {
    const owner = this.view.ownerId;
    if (!owner) return;
    await this.commit(owner, async (current) => {
      const event = createResolutionEvent(
        this.context(current.meta),
        questionId,
        gradingRevision,
        attemptId,
        candidateAttemptIds,
      );
      const result = applyLocalEvents(current.state, current.meta.projection, [
        event,
      ]);
      current.state = await validateOriginalState(result.state, "real");
      current.meta.projection = result.projection;
      current.meta.nextSequence = event.deviceSequence + 1;
      current.meta.outbox.push(event);
      return current;
    });
    this.schedule();
    await this.reload();
  }
  async retryVersionConflict(eventId: string) {
    await this.sync();
    const owner = this.view.ownerId;
    if (!owner) return;
    await this.commit(owner, (current) => {
      const old = current.meta.outbox.find((e) => e.eventId === eventId);
      if (!old || !current.meta.failures[eventId]) return current;
      const next = structuredClone(old);
      next.eventId = crypto.randomUUID();
      next.deviceSequence = current.meta.nextSequence++;
      next.baseCursor = current.meta.cursor;
      next.createdAt = new Date().toISOString();
      if (next.kind === "bank") {
        const held = current.meta.projection.bankConflicts
          .map((c) => c.event)
          .filter(
            (e): e is Extract<SyncEvent, { kind: "bank" }> =>
              e?.kind === "bank",
          )
          .at(-1);
        const latest = held
          ? mergeMigrationBank(
              current.state.data,
              held.payload.data,
              current.meta.projection,
            )
          : current.state.data;
        next.payload.data = mergeMigrationBank(
          latest,
          next.payload.data,
          current.meta.projection,
        );
        next.payload.baseVersion = current.meta.projection.bankVersion;
      }
      if (next.kind === "mark")
        next.payload.baseMarkVersion =
          current.meta.projection.markVersions[next.payload.questionId] ?? 0;
      holdSuccessors(
        current.meta,
        eventId,
        "선행 변경을 다시 검토했으므로 이 변경도 최신 내용을 확인하세요.",
      );
      const index = current.meta.outbox.findIndex((e) => e.eventId === eventId);
      current.meta.outbox[index] = next;
      delete current.meta.failures[eventId];
      return current;
    });
    this.schedule();
    await this.reload();
  }
  async keepRemoteMark(eventId: string) {
    await this.sync();
    const owner = this.view.ownerId;
    if (!owner) return;
    await this.commit(owner, (current) => {
      const event = current.meta.outbox.find((e) => e.eventId === eventId);
      if (event?.kind !== "mark" || !current.meta.failures[eventId])
        throw new Error("확인할 표시 변경이 없습니다.");
      holdSuccessors(
        current.meta,
        eventId,
        "원격 표시를 선택했으므로 남은 표시 변경을 확인하세요.",
      );
      current.meta.outbox = current.meta.outbox.filter(
        (e) => e.eventId !== eventId,
      );
      delete current.meta.failures[eventId];
      return current;
    });
    await this.reload();
    this.schedule();
  }
}
function canonicalEvent(event: SyncEvent) {
  return JSON.stringify({ kind: event.kind, payload: event.payload });
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
let singleton: CloudController | null = null;
export function useCloudSync(namespace: string) {
  const [controller] = useStableController();
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.init(import.meta.env);
    const onLocal = () => {
      if (!controller.snapshot().busy) {
        void controller.reload();
        controller.schedule();
      }
    };
    const onFocus = () => controller.schedule();
    window.addEventListener("police-sync-local", onLocal);
    window.addEventListener("online", onFocus);
    window.addEventListener("focus", onFocus);
    const visibility = () => {
      if (!document.hidden) onFocus();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("police-sync-local", onLocal);
      window.removeEventListener("online", onFocus);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [controller]);
  useEffect(
    () => controller.setEnabled(namespace === "real"),
    [controller, namespace],
  );
  return { controller, ...view };
}
export function getSharedCloudController(): CloudController {
  if (!singleton) singleton = new CloudController();
  return singleton;
}
function useStableController() {
  return [getSharedCloudController()] as const;
}
