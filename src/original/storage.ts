import { z } from "zod";
import type { Namespace, OriginalPackage, Question } from "./model";
import {
  activeSession,
  initialOriginalState,
  responseResult,
  type OriginalState,
} from "./engine";
import { isEligible, areas, validatePackage } from "./validation";
import {
  backup as oxBackup,
  validateBackup as validateOxBackup,
} from "../data/transfer";
import { initialState as initialOxState } from "../fixtures/data";
import { canonical, type State as OxState } from "../domain/schema";
import { ConflictError } from "../data/repository";
import {
  accountStateKey,
  syncMetaKey,
  emptySyncLocal,
  queueChanges,
  notifySyncLocal,
} from "./sync/local";

const timestamp = z.string().datetime();
const response = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal("unknown"),
  z.null(),
]);
const selection = z
  .object({
    subjectId: z.string(),
    unitCodes: z.array(z.string()),
    bookUnitIds: z.array(z.string()),
    year: z.string(),
    round: z.string(),
    examCode: z.string(),
    filter: z.enum([
      "all",
      "unanswered",
      "incorrect",
      "unknown",
      "marked",
      "weak",
    ]),
    order: z.enum(["ordered", "random"]),
    limit: z.number().int().nonnegative(),
  })
  .strict();
const mode = z.enum(["study", "round", "exam"]);
const attempt = z
  .object({
    attemptId: z.string().min(1),
    sessionId: z.string().min(1),
    questionId: z.string().min(1),
    revision: z.number().int().positive(),
    gradingRevision: z.number().int().positive(),
    mode,
    response,
    expectedChoices: z.array(z.number().int().min(1).max(4)),
    result: z.enum(["correct", "incorrect", "unknown", "unanswered"]),
    answeredAt: timestamp,
  })
  .strict();
const session = z
  .object({
    id: z.string().min(1),
    mode,
    selection,
    questions: z.array(z.unknown()).min(1),
    assets: z.array(z.unknown()),
    responses: z.record(response),
    review: z.record(z.boolean()),
    index: z.number().int().nonnegative(),
    status: z.enum(["active", "completed", "ended"]),
    startedAt: timestamp,
    deadlineAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
  })
  .strict();
const stateShape = z
  .object({
    data: z
      .object({
        questions: z.array(z.unknown()),
        assets: z.array(z.unknown()),
        packages: z.array(z.unknown()),
      })
      .strict(),
    attempts: z.array(attempt),
    marks: z.record(z.boolean()),
    sessions: z.array(session),
    settings: z.object({ fontScale: z.number().min(1).max(2) }).strict(),
    removedQuestionIds: z.array(z.string().min(1)).optional(),
  })
  .strict();
export interface OriginalEnvelope {
  generation: number;
  state: OriginalState;
}
export interface FullBackup {
  format: "police-learning-backup";
  backupVersion: 2;
  namespace: Namespace;
  exportedAt: string;
  original: OriginalState;
  ox: ReturnType<typeof oxBackup>;
  generations: { original: number; ox: number };
}
function collectionPackage(
  questions: Question[],
  assets: OriginalState["data"]["assets"],
  namespace: Namespace,
): OriginalPackage {
  return {
    format: "police-original-questions",
    schemaVersion: "1.0.0",
    packageId: "backup-collection-validation",
    packageVersion: 1,
    exportedAt: "2026-10-21T00:00:00.000Z",
    dataKind: namespace,
    stage: "classified",
    unitRegistryVersion: "1.0.0",
    questions,
    assets,
  };
}
export async function validateOriginalState(
  value: unknown,
  namespace: Namespace,
): Promise<OriginalState> {
  const parsed = stateShape.parse(value);
  const state = parsed as unknown as OriginalState;
  const fail = (message: string): never => {
    throw new Error(`원문 백업: ${message}`);
  };
  await validatePackage(
    collectionPackage(state.data.questions, state.data.assets, namespace),
    namespace,
    { allowLargeCollection: true },
  );
  const currentQuestions = new Map(state.data.questions.map((q) => [q.id, q]));
  const currentAssets = new Map(state.data.assets.map((a) => [a.assetId, a]));
  const packageIds = new Set<string>();
  for (const source of state.data.packages) {
    await validatePackage(source, namespace);
    if (packageIds.has(source.packageId)) fail("중복 패키지 식별자");
    packageIds.add(source.packageId);
    for (const q of source.questions) {
      const current = currentQuestions.get(q.id);
      if (
        !current ||
        current.revision < q.revision ||
        (current.revision === q.revision && canonical(current) !== canonical(q))
      )
        fail("패키지와 현재 문항의 버전·내용 불일치");
    }
    for (const asset of source.assets)
      if (canonical(currentAssets.get(asset.assetId)) !== canonical(asset))
        fail("패키지 그림과 현재 그림 불일치");
  }
  const removed = new Set(state.removedQuestionIds ?? []);
  const retainedPackageQuestionIds = new Set(
    state.data.packages.flatMap((source) => source.questions.map((q) => q.id)),
  );
  if (
    removed.size !== (state.removedQuestionIds?.length ?? 0) ||
    [...removed].some(
      (id) => !currentQuestions.has(id) || retainedPackageQuestionIds.has(id),
    )
  )
    fail("삭제한 문제의 보관 표시·파일 연결 오류");
  if (state.sessions.filter((s) => s.status === "active").length > 1)
    fail("진행 중 풀이가 두 개 이상입니다.");
  const sessionIds = new Set<string>();
  for (const s of state.sessions) {
    if (sessionIds.has(s.id)) fail("중복 풀이 식별자");
    sessionIds.add(s.id);
    await validatePackage(
      collectionPackage(s.questions, s.assets, namespace),
      namespace,
      { allowLargeCollection: true },
    );
    if (!s.questions.every((q) => isEligible(q, namespace)))
      fail("출제 불가 문항 스냅샷");
    if (s.status === "active" && s.questions.some((q) => removed.has(q.id)))
      fail("진행 중인 풀이에 삭제한 문제가 있습니다.");
    for (const snapshot of s.questions) {
      const current = currentQuestions.get(snapshot.id);
      if (
        !current ||
        current.revision < snapshot.revision ||
        (current.revision === snapshot.revision &&
          canonical(current) !== canonical(snapshot))
      )
        fail("풀이 스냅샷과 현재 문제 은행의 참조·버전 불일치");
    }
    for (const asset of s.assets)
      if (canonical(currentAssets.get(asset.assetId)) !== canonical(asset))
        fail("풀이 그림과 현재 그림의 참조·내용 불일치");
    if (s.index >= s.questions.length) fail("현재 문항 위치 오류");
    const ids = new Set(s.questions.map((q) => q.id));
    if (
      Object.keys(s.responses).some((id) => !ids.has(id)) ||
      Object.keys(s.review).some((id) => !ids.has(id))
    )
      fail("답안·검토 표시 참조 오류");
    if ((s.status === "active") !== (s.finishedAt === null))
      fail("종료 상태와 종료 시각 불일치");
    if (s.finishedAt && Date.parse(s.finishedAt) < Date.parse(s.startedAt))
      fail("종료 시각이 시작 전입니다.");
    if (s.mode === "exam") {
      if (
        !s.deadlineAt ||
        Date.parse(s.deadlineAt) - Date.parse(s.startedAt) !== 6000000 ||
        s.questions.length !== 100
      )
        fail("모의고사 문항 수·종료 시각 오류");
      if (s.finishedAt && Date.parse(s.finishedAt) > Date.parse(s.deadlineAt!))
        fail("종료 시각 경과 후 채점");
      if (s.status === "ended") fail("모의고사는 제출로 종료해야 합니다.");
      for (const area of areas)
        if (
          s.questions.filter(
            (q) =>
              q.subjectId === area.subjectId &&
              q.classification?.blueprintStatus === "confirmed" &&
              q.classification.blueprintAreaCode === area.code,
          ).length !== area.targetQuestions
        )
          fail("모의고사 영역별 편성 불일치");
    } else if (s.deadlineAt !== null) fail("학습 세션의 종료 제한 시각 오류");
  }
  const attemptIds = new Set<string>(),
    pairs = new Set<string>();
  for (const a of state.attempts) {
    if (attemptIds.has(a.attemptId)) fail("중복 응답 식별자");
    attemptIds.add(a.attemptId);
    const pair = JSON.stringify([a.sessionId, a.questionId]);
    if (pairs.has(pair)) fail("동일 풀이에서 중복 응답");
    pairs.add(pair);
    const s = state.sessions.find((s) => s.id === a.sessionId),
      q = s?.questions.find((q) => q.id === a.questionId);
    if (!s || !q) throw new Error("원문 백업: 응답·문항 스냅샷 불일치");
    if (
      a.mode !== s.mode ||
      a.revision !== q.revision ||
      a.gradingRevision !== q.gradingRevision ||
      canonical(a.expectedChoices) !==
        canonical(q.officialAnswer.acceptedChoices)
    )
      fail("응답·문항 스냅샷 불일치");
    if (
      a.result !== responseResult(a.response, a.expectedChoices) ||
      (s.responses[a.questionId] ?? null) !== a.response
    )
      fail("응답 결과·임시 답안 불일치");
    if (a.mode !== "exam" && a.response === null)
      fail("미응답 학습 기록은 만들 수 없습니다.");
    if (a.mode === "exam" && s.status === "active")
      fail("제출 전 모의고사 채점 기록");
    if (
      Date.parse(a.answeredAt) < Date.parse(s.startedAt) ||
      (s.finishedAt && Date.parse(a.answeredAt) > Date.parse(s.finishedAt))
    )
      fail("응답 시각 오류");
  }
  for (const s of state.sessions)
    for (const q of s.questions) {
      const hasAttempt = pairs.has(JSON.stringify([s.id, q.id]));
      const shouldHaveAttempt =
        s.mode === "exam"
          ? s.status === "completed"
          : s.responses[q.id] != null;
      if (hasAttempt !== shouldHaveAttempt) fail("응답 누락 또는 미확정 기록");
      if (s.mode !== "exam" && s.status === "completed" && !hasAttempt)
        fail("학습 완료 상태 오류");
    }
  if (
    Object.keys(state.marks).some(
      (id) => !state.data.questions.some((q) => q.id === id),
    )
  )
    fail("다시 보기 참조 오류");
  return state;
}
const backupShape = z
  .object({
    format: z.literal("police-learning-backup"),
    backupVersion: z.literal(2),
    namespace: z.enum(["real", "demo"]),
    exportedAt: timestamp,
    original: z.unknown(),
    ox: z.unknown(),
    generations: z
      .object({
        original: z.number().int().nonnegative(),
        ox: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export async function validateFullBackup(
  value: unknown,
  namespace: Namespace,
): Promise<FullBackup> {
  const parsed = backupShape.parse(value);
  if (parsed.namespace !== namespace)
    throw new Error(
      "실제/시연 백업 영역이 다릅니다. 같은 영역에서 복구하세요.",
    );
  const original = await validateOriginalState(parsed.original, namespace);
  const ox = validateOxBackup(parsed.ox, namespace);
  return { ...parsed, original, ox: oxBackup(ox, namespace) };
}
export class OriginalRepository {
  private db: Promise<IDBDatabase>;
  private accountId: string | null = null;
  useAccount(id: string | null) {
    this.accountId = id;
  }
  private stateKey(namespace: Namespace) {
    return namespace === "real" && this.accountId
      ? accountStateKey(this.accountId)
      : `original:${namespace}`;
  }
  constructor(name = "police-ox-storage") {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("states"))
          request.result.createObjectStore("states");
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("다른 탭을 닫고 다시 시도하세요."));
    });
  }
  async load(namespace: Namespace): Promise<OriginalEnvelope> {
    const key = this.stateKey(namespace);
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly");
      const req = tx.objectStore("states").get(key);
      let result: OriginalEnvelope;
      req.onsuccess = () => {
        result = req.result ?? {
          generation: 0,
          state: initialOriginalState(namespace),
        };
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("불러오기 실패"));
      tx.onabort = () => reject(tx.error ?? new Error("불러오기 실패"));
    });
  }
  async save(
    namespace: Namespace,
    state: OriginalState,
    expectedGeneration: number,
  ): Promise<OriginalEnvelope> {
    const key = this.stateKey(namespace),
      owner = namespace === "real" ? this.accountId : null;
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readwrite"),
        store = tx.objectStore("states");
      let failure: Error | null = null,
        next: OriginalEnvelope;
      const metadata = owner ? store.get(syncMetaKey(owner)) : null;
      const get = store.get(key);
      get.onsuccess = () => {
        if ((get.result?.generation ?? 0) !== expectedGeneration) {
          failure = new ConflictError();
          tx.abort();
          return;
        }
        const previous = get.result?.state as OriginalState | undefined;
        if (
          previous &&
          activeSession(previous) &&
          (canonical(previous.data) !== canonical(state.data) ||
            canonical(previous.removedQuestionIds ?? []) !==
              canonical(state.removedQuestionIds ?? []))
        ) {
          failure = new Error(
            "진행 중 원문 풀이를 종료한 뒤 문제를 관리하세요.",
          );
          tx.abort();
          return;
        }
        next = { generation: expectedGeneration + 1, state };
        try {
          if (owner)
            store.put(
              queueChanges(
                previous,
                state,
                metadata?.result ?? emptySyncLocal(),
              ),
              syncMetaKey(owner),
            );
          store.put(next, key);
        } catch (e) {
          failure = e instanceof Error ? e : new Error(String(e));
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        if (owner) notifySyncLocal();
        resolve(next);
      };
      tx.onerror = () => reject(failure ?? tx.error ?? new Error("저장 실패"));
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("저장 실패"));
    });
  }
  async fullBackup(namespace: Namespace): Promise<FullBackup> {
    const key = this.stateKey(namespace);
    const oxKey =
      namespace === "real" && this.accountId
        ? "ox:real:user:" + this.accountId
        : namespace;
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readonly"),
        store = tx.objectStore("states");
      const original = store.get(key),
        ox = store.get(oxKey);
      tx.oncomplete = () =>
        resolve({
          format: "police-learning-backup",
          backupVersion: 2,
          namespace,
          exportedAt: new Date().toISOString(),
          original: original.result?.state ?? initialOriginalState(namespace),
          ox: oxBackup(
            ox.result?.state ?? initialOxState(namespace === "demo"),
            namespace,
          ),
          generations: {
            original: original.result?.generation ?? 0,
            ox: ox.result?.generation ?? 0,
          },
        });
      tx.onerror = () => reject(tx.error ?? new Error("백업 실패"));
      tx.onabort = () => reject(tx.error ?? new Error("백업 실패"));
    });
  }
  async restore(
    namespace: Namespace,
    value: unknown,
    expectedGeneration: number,
    expectedOxGeneration?: number,
  ): Promise<OriginalEnvelope> {
    const key = this.stateKey(namespace),
      owner = namespace === "real" ? this.accountId : null;
    // Capture both generations before asynchronous validation. The transaction
    // checks them again so an OX tab cannot be silently overwritten mid-restore.
    if (owner)
      throw new Error(
        "계정의 백업은 계정·기기 동기화 화면에서 미리보기 후 병합하세요.",
      );
    const current = await this.fullBackup(namespace);
    if (
      expectedOxGeneration !== undefined &&
      current.generations.ox !== expectedOxGeneration
    )
      throw new ConflictError();
    const validated = await validateFullBackup(value, namespace);
    if (activeSession(current.original))
      throw new Error("진행 중 원문 풀이를 종료한 뒤 복구하세요.");
    if (current.ox.state.sessions.some((s) => s.status === "active"))
      throw new Error("진행 중 OX 풀이를 종료한 뒤 전체 복구하세요.");
    const oxState = validateOxBackup(validated.ox, namespace);
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("states", "readwrite"),
        store = tx.objectStore("states");
      let failure: Error | null = null,
        next: OriginalEnvelope;
      const metadata = owner ? store.get(syncMetaKey(owner)) : null;
      const original = store.get(key),
        ox = store.get(namespace);
      ox.onsuccess = () => {
        if (
          (original.result?.generation ?? 0) !== expectedGeneration ||
          (ox.result?.generation ?? 0) !== current.generations.ox
        ) {
          failure = new ConflictError();
          tx.abort();
          return;
        }
        next = {
          generation: expectedGeneration + 1,
          state: validated.original,
        };
        try {
          if (owner)
            store.put(
              queueChanges(
                original.result?.state,
                validated.original,
                metadata?.result ?? emptySyncLocal(),
              ),
              syncMetaKey(owner),
            );
          store.put(next, key);
          store.put(
            {
              generation: current.generations.ox + 1,
              state: oxState as OxState,
            },
            namespace,
          );
        } catch (e) {
          failure = e instanceof Error ? e : new Error(String(e));
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        if (owner) notifySyncLocal();
        resolve(next);
      };
      tx.onerror = () => reject(failure ?? tx.error ?? new Error("복구 실패"));
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("복구 실패"));
    });
  }
  async close() {
    (await this.db).close();
  }
}
