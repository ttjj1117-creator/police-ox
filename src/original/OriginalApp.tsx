import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, Block, Namespace, Question } from "./model";
import {
  activeSession,
  answer,
  defaultSelection,
  examAvailability,
  expire,
  finish,
  move,
  resultSummary,
  selectQuestions,
  startSession,
  weakQuestions,
} from "./engine";
import type {
  OriginalSelection,
  OriginalSession,
  OriginalState,
} from "./engine";
import { OriginalRepository, validateFullBackup } from "./storage";
import {
  exportOriginalPackages,
  isEligible,
  mappingReport,
  previewMerge,
  referencedAssets,
  subjectLabels,
  units,
} from "./validation";
import { useOxSync } from "../ox-sync/controller";
import {
  download,
  MAX_FILE_BYTES,
  mergeDataset,
  parseFile,
  validateBackup,
} from "../data/transfer";
import { errorMessage } from "../domain/schema";
import { PackageManager } from "./PackageManager";
import { applyPackageDeletion } from "./deletion";
import { LearningStatus } from "./LearningStatus";
import { ReviewRecommendations } from "./ReviewRecommendations";
import {
  aggregateLearning,
  DEFAULT_REVIEW_LIMIT,
  defaultReviewScope,
  reviewCandidates,
} from "./review-analytics";
import type { ReviewScope } from "./review-analytics";
import "./original.css";
import "./review-progress.css";
import { QuizChrome, QuizAnswerSheet } from "./QuizChrome";
import { ReadingFlowText } from "./ReadingFlowText";
import {
  InkProvider,
  InkToolbar,
  InkSurface,
  InkChoiceButton,
} from "./ink/Ink";
import { useCloudSync } from "./sync/controller";
import { CloudPanel } from "./sync/CloudPanel";
import { appUrl } from "../pwa/base";
import { setPwaSessionActive } from "../pwa/runtime";

type Envelope = { generation: number; state: OriginalState };
type Page =
  | "home"
  | "study"
  | "round"
  | "exam"
  | "review"
  | "progress"
  | "cloud"
  | "quiz"
  | "result"
  | "settings";
type Pending = {
  description: string;
  sample?: Question[];
  assets?: Asset[];
  apply: () => Promise<void>;
};
export type IncomingFile = { file: File; kind: "import" | "restore" };
const repository = new OriginalRepository();
const names: [Page, string][] = [
  ["home", "학습 홈"],
  ["study", "일반 학습"],
  ["round", "회차별 풀이"],
  ["exam", "모의고사"],
  ["review", "오답 복습"],
  ["progress", "학습 현황"],
  ["cloud", "계정·기기 동기화"],
  ["settings", "데이터·설정"],
];
const resultLabels = {
  correct: "정답",
  incorrect: "오답",
  unknown: "모르겠음",
  unanswered: "미응답",
};

export function OriginalApp({
  initialFile,
  onFileRead,
}: {
  initialFile?: IncomingFile;
  onFileRead: () => void;
}) {
  const [namespace, setNamespace] = useState<Namespace>(
    new URLSearchParams(location.search).get("mode") === "demo"
      ? "demo"
      : "real",
  );
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const cloud = useCloudSync(namespace);
  const oxCloud = useOxSync(namespace);
  const readingOwner = JSON.stringify([namespace, namespace === "real" ? cloud.ownerId ?? "local" : "local"]);
  const [readingPreference, setReadingPreference] = useState<{ owner: string; auto: boolean } | null>(null);
  const readingPreferenceKey = "original:reading-flow:" + readingOwner;
  let savedReadingFlow = true;
  try { savedReadingFlow = localStorage.getItem(readingPreferenceKey) !== "original"; } catch { /* optional device preference */ }
  const readingFlow = readingPreference?.owner === readingOwner ? readingPreference.auto : savedReadingFlow;
  const oxRepository = oxCloud.controller;
  const [answerSheetOpen, setAnswerSheetOpen] = useState(false);
  const envelopeRef = useRef<Envelope | null>(null);
  const [page, setPage] = useState<Page>(() =>
    typeof window !== "undefined" &&
    (new URLSearchParams(window.location.search).get("auth") === "callback" ||
      new URLSearchParams(window.location.search).get("panel") === "cloud")
      ? "cloud"
      : "home",
  );
  const [selection, setSelection] = useState<OriginalSelection>({
    ...defaultSelection,
  });
  const [progressScope, setProgressScope] = useState<ReviewScope>({
    ...defaultReviewScope,
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    setAnswerSheetOpen(false);
  }, [page, sessionId]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [choice, setChoice] = useState<1 | 2 | 3 | 4 | null>(null);
  const lock = useRef(false);
  const pendingLock = useRef(false);
  const fileRequest = useRef(0);
  const expiryRetry = useRef(new Set<string>());
  const failed = useRef<{
    state: OriginalState;
    generation: number;
    done?: () => void;
  } | null>(null);
  const nsRef = useRef(namespace);
  nsRef.current = namespace;
  function install(e: Envelope) {
    envelopeRef.current = e;
    setEnvelope(e);
  }
  useEffect(() => {
    if (!cloud.ready) return;
    let alive = true;
    repository.useAccount(cloud.ownerId);
    envelopeRef.current = null;
    setEnvelope(null);
    setError("");
    setNotice("");
    setPending(null);
    setProgressScope({ ...defaultReviewScope });
    failed.current = null;
    expiryRetry.current.clear();
    fileRequest.current++;
    const url = new URL(location.href);
    url.searchParams.set("view", "original");
    url.searchParams.set("mode", namespace);
    history.replaceState(null, "", url);
    repository
      .load(namespace)
      .then(async (e) => {
        const draft = structuredClone(e.state);
        const expiredSession = activeSession(draft);
        const didExpire = expire(draft, Date.now());
        if (didExpire) {
          try {
            e = await repository.save(namespace, draft, e.generation);
          } catch (error) {
            if (/다른 탭|충돌/.test(errorMessage(error)))
              e = await repository.load(namespace);
            else throw error;
          }
        }
        if (!alive) return;
        install(e);
        const current = activeSession(e.state);
        setSessionId(current?.id ?? (didExpire ? expiredSession!.id : null));
        setPage(
          current
            ? "quiz"
            : didExpire
              ? "result"
              : new URLSearchParams(window.location.search).get("auth") ===
                    "callback" ||
                  new URLSearchParams(window.location.search).get("panel") ===
                    "cloud"
                ? "cloud"
                : "home",
        );
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [namespace, cloud.ready, cloud.ownerId]);
  useEffect(() => {
    if (
      !cloud.ownerId ||
      namespace !== "real" ||
      !cloud.ready ||
      !envelopeRef.current ||
      lock.current
    )
      return;
    let alive = true;
    void repository.load(namespace).then((next) => {
      if (alive && next.generation > (envelopeRef.current?.generation ?? -1))
        install(next);
    });
    return () => {
      alive = false;
    };
  }, [cloud.generation, cloud.ownerId, namespace]);
  async function mutate(
    change: (draft: OriginalState) => void | Promise<void>,
    done?: () => void,
    fresh = false,
  ) {
    if (lock.current || !envelopeRef.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const capturedNs = namespace;
    let base = envelopeRef.current;
    let draft: OriginalState | undefined;
    let changeComplete = false;
    try {
      if (fresh) {
        base = await repository.load(capturedNs);
        if (nsRef.current !== capturedNs) return;
        install(base);
      }
      draft = structuredClone(base.state);
      await change(draft);
      changeComplete = true;
      const saved = await repository.save(capturedNs, draft, base.generation);
      if (nsRef.current !== capturedNs) return;
      install(saved);
      failed.current = null;
      done?.();
    } catch (e) {
      const message = errorMessage(e);
      if (/다른 탭|충돌|generation/i.test(message)) {
        try {
          install(await repository.load(capturedNs));
        } catch {}
        failed.current = null;
        setError(message);
      } else if (changeComplete) {
        if (draft)
          failed.current = { state: draft, generation: base.generation, done };
        setError("저장되지 않음: " + message);
      } else {
        failed.current = null;
        setError(message);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function retrySave() {
    const f = failed.current;
    if (!f || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const unsavedSession = activeSession(f.state);
      if (
        unsavedSession?.deadlineAt &&
        Date.now() >= Date.parse(unsavedSession.deadlineAt)
      ) {
        // Deadline grading must use the last durable answers, never a failed draft.
        const durable = await repository.load(namespace);
        const savedSession = durable.state.sessions.find(
          (s) => s.id === unsavedSession.id,
        );
        if (!savedSession) {
          install(durable);
          failed.current = null;
          setError(
            "시험 시작이 저장되지 않았습니다. 모의고사를 다시 시작하세요.",
          );
          setPage("home");
          return;
        }
        const recovered = structuredClone(durable.state);
        expire(recovered, Date.now());
        install(
          await repository.save(namespace, recovered, durable.generation),
        );
        failed.current = null;
        setError("");
        setSessionId(savedSession.id);
        setPage("result");
      } else {
        install(await repository.save(namespace, f.state, f.generation));
        failed.current = null;
        setError("");
        f.done?.();
      }
    } catch (e) {
      setError("저장되지 않음: " + errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      const e = envelopeRef.current;
      const current = e && activeSession(e.state);
      if (current?.deadlineAt && Date.now() >= Date.parse(current.deadlineAt)) {
        if (failed.current) {
          if (!expiryRetry.current.has(current.id)) {
            expiryRetry.current.add(current.id);
            void retrySave();
          }
        } else
          void mutate(
            (d) => {
              expire(d, Date.now());
            },
            () => {
              setSessionId(current.id);
              setPage("result");
            },
          );
      }
    };
    const timer = setInterval(tick, 500);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [namespace]);
  const state = envelope?.state;
  const homeAnalytics = useMemo(
    () =>
      state
        ? aggregateLearning(
            state,
            namespace,
            defaultReviewScope,
            namespace === "real" ? cloud.conflictIds : [],
          )
        : null,
    [state, namespace, cloud.conflictIds],
  );
  const progressAnalytics = useMemo(
    () =>
      !state || !homeAnalytics
        ? null
        : !progressScope.subjectId &&
            !progressScope.year &&
            !progressScope.round
          ? homeAnalytics
          : aggregateLearning(
              state,
              namespace,
              progressScope,
              namespace === "real" ? cloud.conflictIds : [],
            ),
    [state, namespace, progressScope, homeAnalytics, cloud.conflictIds],
  );
  const availableProgressQuestions = useMemo(
    () =>
      homeAnalytics
        ? Array.from(
            homeAnalytics.questions.values(),
            (entry) => entry.question,
          )
        : [],
    [homeAnalytics],
  );
  const session = state?.sessions.find((x) => x.id === sessionId);
  const active = state && activeSession(state);
  useEffect(() => {
    setPwaSessionActive(!!active);
  }, [!!active]);
  const q = session?.questions[session.index];
  const inkContentVersion = useMemo(
    () =>
      q
        ? JSON.stringify({
            renderer: "original-blocks-ink-v1",
            revision: q.revision,
            gradingRevision: q.gradingRevision,
            body: q.body,
            choices: q.choices,
            assets: session?.assets.map(({ assetId, sha256 }) => [
              assetId,
              sha256,
            ]),
          })
        : "",
    [q, session?.assets],
  );
  useEffect(() => {
    if (page === "quiz") window.scrollTo({ top: 0, left: 0 });
  }, [page, sessionId, session?.index]);
  const attempted =
    session && q
      ? state?.attempts.find(
          (a) => a.sessionId === session.id && a.questionId === q.id,
        )
      : undefined;
  const expired = !!(
    session?.deadlineAt && now >= Date.parse(session.deadlineAt)
  );
  useEffect(() => {
    setChoice(null);
  }, [sessionId, session?.index]);
  useEffect(() => {
    if (!state || !initialFile) return;
    setPage("settings");
    void readFile(initialFile.file, initialFile.kind);
    onFileRead();
  }, [!!state, initialFile]);
  const navigate = (p: Page) => {
    setPage(p);
    setNotice("");
    setPending(null);
    setChoice(null);
    if (p === "review")
      setSelection({
        ...defaultSelection,
        subjectId: "",
        filter: "weak",
        limit: 0,
      });
  };
  async function begin(
    mode: "study" | "round" | "exam",
    override?: Question[],
  ) {
    if (active) {
      setSessionId(active.id);
      setPage("quiz");
      return;
    }
    let created: OriginalSession | undefined;
    await mutate(
      (d) => {
        created = startSession(
          d,
          namespace,
          { ...selection, bookUnitIds: [] },
          mode,
          Date.now(),
          override,
        );
      },
      () => {
        setSessionId(created!.id);
        setPage("quiz");
        setChoice(null);
      },
    );
  }
  async function beginDerived(
    subjectId: string,
    unitCode: string | null,
    kind: "review" | "unanswered",
    scope: ReviewScope,
  ) {
    const requestedScope = { ...scope };
    let outcome: "started" | "resume" | "expired" | "empty" = "empty";
    let targetId: string | null = null;
    let requestedSelection: OriginalSelection | undefined;
    await mutate(
      async (draft) => {
        const current = activeSession(draft);
        if (current) {
          targetId = current.id;
          outcome = expire(draft, Date.now()) ? "expired" : "resume";
          return;
        }
        const latestCloud =
          cloud.ownerId && namespace === "real"
            ? await cloud.controller.store.read(cloud.ownerId)
            : null;
        const analytics = aggregateLearning(
          draft,
          namespace,
          requestedScope,
          latestCloud
            ? latestCloud.meta.projection.responseConflicts.map(
                (c) => c.questionId,
              )
            : [],
        );
        const candidates = reviewCandidates(
          analytics,
          subjectId,
          unitCode,
          kind,
          DEFAULT_REVIEW_LIMIT,
        );
        if (!candidates.length) return;
        requestedSelection = {
          ...defaultSelection,
          subjectId,
          unitCodes: unitCode ? [unitCode] : [],
          bookUnitIds: [],
          year: requestedScope.year,
          round: requestedScope.round,
          examCode: namespace === "real" ? "po" : "demo",
          filter: kind === "review" ? "weak" : "unanswered",
          order: "ordered",
          limit: candidates.length,
        };
        targetId = startSession(
          draft,
          namespace,
          requestedSelection,
          "study",
          Date.now(),
          candidates,
        ).id;
        outcome = "started";
      },
      () => {
        if (outcome === "empty") {
          setNotice(
            kind === "review"
              ? "현재 조회 범위에 복습할 오답·모르겠음 문항이 없습니다. 현황을 갱신했습니다."
              : "현재 조회 범위에 미풀이 문항이 없습니다. 현황을 갱신했습니다.",
          );
          return;
        }
        if (requestedSelection) setSelection(requestedSelection);
        setSessionId(targetId);
        setChoice(null);
        setPage(outcome === "expired" ? "result" : "quiz");
        setNotice(
          outcome === "resume"
            ? "진행 중인 학습을 이어갑니다. 새 학습은 현재 학습을 종료한 뒤 시작할 수 있습니다."
            : "",
        );
      },
      true,
    );
  }
  async function readFile(file: File | undefined, kind: "import" | "restore") {
    setError("");
    setPending(null);
    if (!file || !state) return;
    const request = ++fileRequest.current;
    const readNamespace = namespace;
    const isCurrent = () =>
      request === fileRequest.current && readNamespace === nsRef.current;
    const stagePending = (next: Pending) => {
      if (isCurrent()) setPending(next);
    };
    try {
      if (active)
        throw new Error("진행 중 세션을 종료한 뒤 가져오기·복구를 진행하세요.");
      if (kind === "import" && file.size > MAX_FILE_BYTES)
        throw new Error("파일은 20 MiB 이하여야 합니다.");
      const value = (
        kind === "import"
          ? parseFile(await file.text())
          : JSON.parse(await file.text())
      ) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("파일: JSON 객체 형식이 필요합니다.");
      if (kind === "import" && value.format === "police-original-questions") {
        const preview = await previewMerge(state.data, value, namespace);
        const incomingIds = new Set(
          (value.questions as Question[]).map((q) => q.id),
        );
        const restoredCount = (state.removedQuestionIds ?? []).filter((id) =>
          incomingIds.has(id),
        ).length;
        stagePending({
          description: `원문 추가 ${preview.added}개 · 갱신 ${preview.updated}개 · 동일 ${preview.unchanged}개 · 풀이 보류 ${preview.held}개${restoredCount ? ` · 다시 등록 ${restoredCount}개` : ""}. 누락된 문항은 보존합니다.`,
          sample: (value.questions as Question[]).slice(0, 3),
          assets: value.assets as Asset[],
          apply: async () => {
            await mutate(
              async (d) => {
                if (activeSession(d))
                  throw new Error("진행 중인 학습을 먼저 종료하세요.");
                d.data = (await previewMerge(d.data, value, namespace)).data;
                if (d.removedQuestionIds)
                  d.removedQuestionIds = d.removedQuestionIds.filter(
                    (id) => !incomingIds.has(id),
                  );
              },
              () => {
                setPending(null);
                setNotice("검증한 데이터를 저장했습니다.");
              },
            );
          },
        });
      } else if (
        kind === "import" &&
        value.format === undefined &&
        value.schemaVersion === 1
      ) {
        if (!oxCloud.ready)
          throw new Error("OX 저장 영역을 준비한 뒤 다시 가져오세요.");
        const ox = await oxRepository.load(namespace);
        if (ox.state.sessions.some((s) => s.status === "active"))
          throw new Error("OX 이어 풀기를 종료한 뒤 가져오세요.");
        const preview = mergeDataset(ox.state.dataset, value);
        stagePending({
          description: `기존 OX 형식입니다. OX 지문 추가 ${preview.added}개 · 갱신 ${preview.updated}개 · 동일 ${preview.unchanged}개. 원문 객관식 기록과 별도로 저장합니다.`,
          apply: async () => {
            await oxRepository.save(
              namespace,
              { ...ox.state, dataset: preview.dataset },
              ox.generation,
            );
            setPending(null);
            setNotice(
              "OX 데이터를 저장했습니다. 기존 OX 학습실에서 풀 수 있습니다.",
            );
          },
        });
      } else if (
        kind === "restore" &&
        value.format === "police-learning-backup"
      ) {
        // Validate every record before presenting destructive replacement.
        const restored = await validateFullBackup(value, namespace);
        if (cloud.ownerId && namespace === "real") {
          if (!oxCloud.ready)
            throw new Error("OX 저장 영역을 준비한 뒤 다시 가져오세요.");
          const preview = await cloud.controller.importPreview(value);
          const oxPreview = await oxRepository.importPreview(value);
          stagePending({
            description: `계정 기록에 병합: 원문 ${preview.questions}문항 · 종료 세션 ${preview.sessions}개 · 응답 ${preview.attempts}건 · 충돌 ${preview.conflicts}건. OX ${oxPreview.items}지문 · 종료 세션 ${oxPreview.sessions}개 · 응답 ${oxPreview.attempts}건 · 충돌 ${oxPreview.conflicts}건. 진행 중 세션은 전송하지 않습니다. 두 학습 기록은 구분하여 합치고 원본 백업은 보관합니다.`,
            apply: async () => {
              await cloud.controller.connectExisting(preview.state, value);
              await oxRepository.connectExisting(oxPreview.state, value);
              setPending(null);
              setNotice(
                "기존 계정 기록과 합쳤습니다. 동기화 상태에서 전송 결과를 확인하세요.",
              );
            },
          });
          return;
        }
        if (!isCurrent() || !envelopeRef.current) return;
        const previewGeneration = envelopeRef.current.generation;
        const previewOxGeneration = (await repository.fullBackup(namespace))
          .generations.ox;
        stagePending({
          description: `원문 ${restored.original.data.questions.length}문항 · 응답 ${restored.original.attempts.length}건. 원문·그림·기록·세션·설정과 포함된 OX 데이터를 현재 ${namespace === "real" ? "실제" : "시연"} 영역에 교체 복구합니다. 현재 내용이 사라집니다.`,
          apply: async () => {
            const saved = await repository.restore(
              namespace,
              value,
              previewGeneration,
              previewOxGeneration,
            );
            install(saved);
            failed.current = null;
            setPending(null);
            setSessionId(null);
            setNotice(
              "전체 백업을 복구했습니다. 이어 풀기는 학습 홈에서 확인하세요.",
            );
          },
        });
      } else if (kind === "restore" && value.backupSchemaVersion === 1) {
        const restored = validateBackup(value, namespace);
        if (cloud.ownerId && namespace === "real") {
          if (!oxCloud.ready)
            throw new Error("OX 저장 영역을 준비한 뒤 다시 가져오세요.");
          const preview = await oxRepository.importPreview(value);
          stagePending({
            description: `OX 계정 기록에 병합: ${preview.items}지문 · 종료 세션 ${preview.sessions}개 · 응답 ${preview.attempts}건 · 내용 충돌 ${preview.conflicts}건. 기존 기록과 원문 객관식은 보존하며 진행 중 세션은 전송하지 않습니다.`,
            apply: async () => {
              await oxRepository.connectExisting(preview.state, value);
              setPending(null);
              setNotice(
                "OX 계정 기록과 합쳤습니다. OX 동기화에서 전송 결과를 확인하세요.",
              );
            },
          });
          return;
        }
        const ox = await oxRepository.load(namespace);
        if (ox.state.sessions.some((s) => s.status === "active"))
          throw new Error("OX 이어 풀기를 종료한 뒤 복구하세요.");
        stagePending({
          description: `이전 OX 백업입니다. OX ${restored.dataset.items.length}지문 · 응답 ${restored.attempts.length}건을 교체합니다. 현재 OX 내용이 사라집니다. 원문 객관식 기록은 유지합니다.`,
          apply: async () => {
            await oxRepository.save(namespace, restored, ox.generation);
            setPending(null);
            setNotice("이전 OX 백업을 복구했습니다.");
          },
        });
      } else
        throw new Error(
          "파일.format: 지원하는 원문 문항·기존 OX 문제 파일 또는 전체 백업 형식을 확인하세요.",
        );
    } catch (e) {
      if (isCurrent()) setError(errorMessage(e));
    }
  }
  async function exportBackup() {
    try {
      download(
        await repository.fullBackup(namespace),
        `police-learning-${namespace}-backup.json`,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function applyPending() {
    if (!pending || lock.current || pendingLock.current) return;
    pendingLock.current = true;
    setBusy(true);
    // Original mutation takes its own lock; legacy/restore writes are awaited too.
    try {
      await pending.apply();
    } catch (e) {
      setError("저장되지 않음: " + errorMessage(e));
    } finally {
      pendingLock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        page !== "quiz" ||
        !session ||
        session.status !== "active" ||
        busy ||
        answerSheetOpen ||
        expired ||
        attempted
      )
        return;
      const target = event.target as HTMLElement;
      if (
        target.matches("input,textarea,select") ||
        !!target.closest("#quiz-reading-menu-items") ||
        target.isContentEditable ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (/^[1-4]$/.test(event.key)) {
        event.preventDefault();
        const n = Number(event.key) as 1 | 2 | 3 | 4;
        if (session.mode === "exam")
          void mutate((d) => {
            answer(d, session.id, n, Date.now());
          });
        else setChoice(n);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [page, session, busy, expired, attempted, namespace, answerSheetOpen]);
  if (!state)
    return (
      <main className="original-loading">
        <h1>원문 기출 학습</h1>
        <p role="status">{error || "학습실을 불러오는 중…"}</p>
        {error && <button onClick={() => location.reload()}>다시 시도</button>}
      </main>
    );
  const removedIds = new Set(state.removedQuestionIds ?? []);
  const listedQuestions = state.data.questions.filter(
    (q) => !removedIds.has(q.id),
  );
  const eligible = listedQuestions.filter((q) => isEligible(q, namespace));
  const held = listedQuestions.length - eligible.length;
  const visibleAssetIds = new Set([
    ...listedQuestions.flatMap(referencedAssets),
    ...state.data.packages.flatMap((pkg) => pkg.assets.map((a) => a.assetId)),
  ]);
  return (
    <div
      className={`original-app${page === "quiz" ? " is-quiz" : ""}`}
      data-large-type={state.settings.fontScale >= 1.5 ? "true" : "false"}
      style={{ fontSize: `${state.settings.fontScale}rem` }}
    >
      <header className="original-header">
        <a
          className="original-brand"
          href={appUrl(`view=original&mode=${namespace}`)}
        >
          <span className="original-emblem">正</span>
          <span>
            경찰 기출 학습실<small>원문 그대로, 나의 속도로</small>
          </span>
        </a>
        <div className="original-header-right">
          <button
            className="cloud-compact-status"
            onClick={() => navigate("cloud")}
          >
            ●{" "}
            {namespace === "real" && cloud.auth
              ? cloud.message
              : "이 기기에 저장됨"}
          </button>
          <a href={appUrl(`view=ox&mode=${namespace}`)}>기존 OX 학습실 ↗</a>
          <label className="sr-only" htmlFor="original-namespace">
            저장 영역
          </label>
          <select
            id="original-namespace"
            value={namespace}
            disabled={busy}
            onChange={(e) => setNamespace(e.target.value as Namespace)}
          >
            <option value="real">실제 학습</option>
            <option value="demo">기능 확인용 예시</option>
          </select>
        </div>
      </header>
      {namespace === "demo" && (
        <aside className="original-demo">
          기능 확인용 시연 · 실제 기출이 아닙니다. 시연 문제와 기록은 별도
          저장됩니다.
        </aside>
      )}
      <div className="original-layout">
        <nav className="original-nav" aria-label="원문 학습 메뉴">
          <div className="nav-caption">MY STUDY</div>
          {names.map(([p, label], i) => (
            <button
              key={p}
              disabled={busy}
              aria-current={page === p ? "page" : undefined}
              className={page === p ? "selected" : ""}
              onClick={() => navigate(p)}
            >
              <span aria-hidden="true">
                {["⌂", "▤", "▦", "◷", "↻", "▥", "☁", "⚙"][i]}
              </span>
              {label}
            </button>
          ))}
          <div className="nav-note">
            공식 최종 정답 기준
            <br />
            헌법 · 형사법 · 경찰학
          </div>
        </nav>
        <main className="original-main">
          {error && (
            <section role="alert" className="original-error">
              <strong>
                {error.startsWith("저장되지")
                  ? "저장되지 않음"
                  : "확인해 주세요"}
              </strong>
              <p className="pre">{error}</p>
              {failed.current && (
                <button onClick={retrySave} disabled={busy}>
                  저장 재시도
                </button>
              )}
              <button onClick={exportBackup}>저장된 전체 기록 내보내기</button>
              {failed.current && (
                <button
                  onClick={async () => {
                    const b = await repository.fullBackup(namespace);
                    download(
                      { ...b, original: failed.current!.state },
                      `police-learning-${namespace}-unsaved-recovery.json`,
                    );
                  }}
                >
                  미저장 기록 내보내기
                </button>
              )}
            </section>
          )}
          {notice && (
            <p className="original-notice" role="status">
              {notice}
            </p>
          )}
          {page === "home" && (
            <>
              <div className="original-eyebrow">YOUR DAILY PRACTICE</div>
              <h1>원문 기출 학습</h1>
              <p className="original-lead">
                기출 한 문제를 온전히 이해하는 시간.
                <br />
                오늘의 한 걸음이 쌓여 실력이 됩니다.
              </p>
              {active && (
                <section className="original-resume">
                  <div>
                    <span className="original-eyebrow">CONTINUE LEARNING</span>
                    <h2>이어서 풀 수 있어요</h2>
                    <p>
                      {active.mode === "exam" ? "실전 모의고사" : "원문 학습"} ·{" "}
                      {active.index + 1} / {active.questions.length}문항
                      {active.deadlineAt &&
                        ` · 종료 ${new Date(active.deadlineAt).toLocaleTimeString("ko-KR")}`}
                    </p>
                  </div>
                  <button
                    className="primary"
                    onClick={() => {
                      setSessionId(active.id);
                      setPage("quiz");
                    }}
                  >
                    이어 풀기 →
                  </button>
                </section>
              )}
              <div className="original-metrics">
                <div>
                  <span>학습 가능한 원문</span>
                  <strong>
                    {homeAnalytics!.overall.N}
                    <small> 문항</small>
                  </strong>
                </div>
                <div>
                  <span>풀이 문항</span>
                  <strong>
                    {homeAnalytics!.overall.A}
                    <small> 문항</small>
                  </strong>
                </div>
                <div>
                  <span>복습할 문항</span>
                  <strong>
                    {homeAnalytics!.overall.unresolved}
                    <small> 문항</small>
                  </strong>
                </div>
              </div>
              <ReviewRecommendations
                analytics={homeAnalytics!}
                busy={busy}
                onStart={beginDerived}
                scopeLabel="전체 등록 문항 기준"
                onViewProgress={() => navigate("progress")}
              />
              <h2 className="original-section-title">
                오늘은 어떤 공부를 할까요?
              </h2>
              <div className="original-cards">
                {(["constitution", "criminal", "police"] as const).map(
                  (id, i) => (
                    <button
                      key={id}
                      className="original-subject-card"
                      onClick={() => {
                        setSelection({ ...defaultSelection, subjectId: id });
                        navigate("study");
                      }}
                    >
                      <span className="original-card-number">0{i + 1}</span>
                      <h3>{subjectLabels[id]}</h3>
                      <p>
                        {eligible.filter((q) => q.subjectId === id).length}문항
                        학습 가능
                      </p>
                      <span>
                        범위 선택 <b>↗</b>
                      </span>
                    </button>
                  ),
                )}
              </div>
              {!eligible.length && (
                <section className="original-empty">
                  <span className="empty-icon">▤</span>
                  <div>
                    <h2>첫 기출 자료를 등록해 주세요</h2>
                    <p>
                      원문과 공식 정답을 확인한 자료를 가져오면 학습을 시작할 수
                      있어요.
                      <br />
                      실제 기출이 없어도 기능 확인용 예시로 흐름을 살펴볼 수
                      있습니다.
                    </p>
                    <div className="actions">
                      <button
                        className="primary"
                        onClick={() => navigate("settings")}
                      >
                        문제 데이터 가져오기
                      </button>
                      {namespace === "real" && (
                        <button onClick={() => setNamespace("demo")}>
                          시연 시작
                        </button>
                      )}
                    </div>
                  </div>
                </section>
              )}
              <div className="original-bottom-grid">
                <button
                  className="original-feature"
                  onClick={() => navigate("exam")}
                >
                  <span>100문항 · 100분</span>
                  <h3>기출 재조합 모의고사 →</h3>
                  <p>공식 영역별 비율로 실전처럼 연습하세요.</p>
                </button>
                <button
                  className="original-feature"
                  onClick={() => navigate("review")}
                >
                  <span>한 번 더, 확실하게</span>
                  <h3>오답 복습 →</h3>
                  <p>오답·모르겠음·미응답을 다시 풀어보세요.</p>
                </button>
              </div>
              {state.sessions.some((s) => s.status !== "active") && (
                <section>
                  <h2>최근 학습 기록</h2>
                  <div className="original-history">
                    {state.sessions
                      .filter((s) => s.status !== "active")
                      .slice(-5)
                      .reverse()
                      .map((record) => {
                        const result = resultSummary(state, record);
                        return (
                          <button
                            key={record.id}
                            onClick={() => {
                              setSessionId(record.id);
                              setPage("result");
                            }}
                          >
                            <span>
                              <b>
                                {record.mode === "exam"
                                  ? "모의고사"
                                  : record.mode === "round"
                                    ? "회차별 풀이"
                                    : "일반 학습"}
                              </b>
                              <small>
                                {new Date(
                                  record.finishedAt ?? record.startedAt,
                                ).toLocaleString("ko-KR")}
                              </small>
                            </span>
                            <span>
                              {record.mode === "exam"
                                ? `${result.points} / ${result.maxPoints}점`
                                : `${result.correct}문항 정답 · ${result.answered}문항 풀이`}{" "}
                              <b>→</b>
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </section>
              )}
              {held > 0 && (
                <p className="original-muted">
                  원문·정답 확인 대기 또는 특별 처리 등 {held}문항은 보관 중이며
                  풀이에서 제외됩니다.
                </p>
              )}
            </>
          )}
          {page === "progress" && (
            <LearningStatus
              analytics={progressAnalytics!}
              scope={progressScope}
              onScopeChange={setProgressScope}
              availableQuestions={availableProgressQuestions}
              busy={busy}
              onStart={beginDerived}
              active={!!active}
              onResume={() => {
                if (!active) return;
                setSessionId(active.id);
                setPage("quiz");
              }}
            />
          )}
          {page === "cloud" && (
            <CloudPanel
              cloud={cloud}
              state={state}
              namespace={namespace}
              busy={busy}
              onBackup={exportBackup}
              oxStatus={oxCloud}
            />
          )}
          {["study", "round", "exam", "review"].includes(page) && (
            <>
              <div className="original-eyebrow">
                {page === "exam" ? "PRACTICE EXAM" : "SELECT YOUR SCOPE"}
              </div>
              <h1>{names.find(([p]) => p === page)?.[1]}</h1>
              <p className="original-muted">
                {page === "exam"
                  ? "순경 공채 · 100문항 · 100분 · 250점. 영역별 문항이 모두 준비되면 시작합니다."
                  : page === "round"
                    ? "선택한 회차의 원래 문항번호 순서로 학습합니다."
                    : "과목과 범위를 고른 뒤 원하는 만큼 풀어보세요."}
              </p>
              {active && (
                <section className="original-resume">
                  <div>
                    <h2>진행 중인 학습이 있습니다</h2>
                    <p>
                      이어 풀거나 풀이 화면에서 종료한 뒤 새 학습을 시작하세요.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setSessionId(active.id);
                      setPage("quiz");
                    }}
                  >
                    이어 풀기
                  </button>
                </section>
              )}
              <Scope
                state={state}
                namespace={namespace}
                selection={selection}
                onChange={setSelection}
                page={page}
                busy={busy || !!active}
                onBegin={() =>
                  begin(
                    page === "exam"
                      ? "exam"
                      : page === "round"
                        ? "round"
                        : "study",
                  )
                }
              />
              {held > 0 && (
                <p className="original-muted">
                  보관 문항 {held}개는 풀이에서 제외됩니다. 이 결과는 특별 처리
                  문항을 포함한 원래 공식 총점의 재현이 아닙니다.
                </p>
              )}
            </>
          )}
          {page === "quiz" && session && q && (
            <InkProvider
              key={JSON.stringify([
                namespace,
                namespace === "real" ? cloud.ownerId : "local",
                session.id,
                q.id,
                inkContentVersion,
              ])}
              ownerKey={
                namespace === "real" ? (cloud.ownerId ?? "local") : "local"
              }
              namespace={namespace}
              sessionId={session.id}
              questionId={q.id}
              contentVersion={inkContentVersion}
            >
              <QuizChrome
                subjectLabel={subjectLabels[q.subjectId]}
                current={session.index + 1}
                total={session.questions.length}
                answered={
                  Object.values(session.responses).filter(
                    (value) => value != null,
                  ).length
                }
                mode={session.mode}
                timeLabel={
                  session.mode === "exam"
                    ? clockText(
                        Math.max(0, Date.parse(session.deadlineAt!) - now),
                      )
                    : undefined
                }
                expired={expired}
                readingFlow={readingFlow}
                onReadingFlowChange={(auto) => {
                  setReadingPreference({ owner: readingOwner, auto });
                  try { localStorage.setItem(readingPreferenceKey, auto ? "auto" : "original"); } catch { /* keep the current view without changing study records */ }
                }}
                fontScale={state.settings.fontScale}
                onFontScaleChange={(scale) => {
                  void mutate((draft) => {
                    draft.settings.fontScale = scale;
                  });
                }}
                busy={busy}
                answerSheetOpen={answerSheetOpen}
                onToggleAnswers={() => setAnswerSheetOpen((value) => !value)}
                menuItems={[
                  ["home", "학습 홈"],
                  ["progress", "학습 현황"],
                  ["cloud", "계정·기기 동기화"],
                  ["settings", "데이터·설정"],
                ].map(([target, label]) => ({
                  label,
                  onSelect: () => navigate(target as Page),
                }))}
              />
              <InkToolbar />
              <div className="original-quiz-grid">
                <div>
                  <section className="original-question">
                    <div className="original-question-meta">
                      <span>
                        문항 {session.index + 1} ·{" "}
                        {namespace === "demo"
                          ? "기능 확인용 시연"
                          : `${q.source.year}년 ${q.source.round}차 · 원문 ${q.source.questionNumber}번`}
                      </span>
                      <button
                        aria-label="다시 보기"
                        aria-pressed={!!state.marks[q.id]}
                        onClick={() =>
                          mutate((d) => {
                            if (
                              session.mode === "exam" &&
                              expire(d, Date.now())
                            )
                              return;
                            d.marks[q.id] = !d.marks[q.id];
                          })
                        }
                        disabled={
                          busy ||
                          (session.mode === "exam" &&
                            (expired || session.status !== "active"))
                        }
                      >
                        {state.marks[q.id] ? "★ 다시 보기" : "☆ 다시 보기"}
                      </button>
                    </div>
                    <InkSurface surfaceId="body">
                      <Blocks blocks={q.body} assets={session.assets} readingFlow={readingFlow} />
                    </InkSurface>
                    <div className="original-choices">
                      {q.choices.map((c) => {
                        const selected =
                          session.mode === "exam"
                            ? session.responses[q.id] === c.number
                            : attempted
                              ? attempted.response === c.number
                              : choice === c.number;
                        return (
                          <div className="original-choice-row" key={c.number}>
                            <InkChoiceButton
                              type="button"
                              className={`original-choice-button${selected ? " chosen" : ""}`}
                              aria-label={`${c.number}번 선택`}
                              aria-pressed={selected}
                              disabled={
                                busy ||
                                session.status !== "active" ||
                                expired ||
                                !!attempted
                              }
                              onClick={() =>
                                session.mode === "exam"
                                  ? mutate((d) => {
                                      answer(
                                        d,
                                        session.id,
                                        c.number as 1 | 2 | 3 | 4,
                                        Date.now(),
                                      );
                                    })
                                  : setChoice(c.number as 1 | 2 | 3 | 4)
                              }
                            >
                              <span className="original-choice-number">
                                {c.number}
                              </span>
                            </InkChoiceButton>
                            <div className="original-choice-text">
                              <InkSurface surfaceId={`choice-${c.number}`}>
                                <Blocks
                                  blocks={c.blocks}
                                  assets={session.assets}
                                  readingFlow={readingFlow}
                                />
                              </InkSurface>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {attempted && (
                      <div
                        className={`original-feedback ${attempted.result}`}
                        role="status"
                      >
                        <strong>{resultLabels[attempted.result]}</strong>
                        <p>
                          {namespace === "demo"
                            ? "시연 정답"
                            : "공식 최종 정답"}{" "}
                          {q.officialAnswer.acceptedChoices.join(", ")}번 · 내
                          답{" "}
                          {attempted.response === "unknown"
                            ? "모르겠음"
                            : `${attempted.response}번`}
                        </p>
                      </div>
                    )}
                    {session.mode !== "exam" && !attempted && (
                      <div className="original-quiz-actions">
                        <button
                          className="primary"
                          disabled={
                            busy ||
                            choice === null ||
                            session.status !== "active"
                          }
                          onClick={() =>
                            mutate((d) => {
                              answer(d, session.id, choice!, Date.now());
                            })
                          }
                        >
                          답 제출
                        </button>
                        <button
                          disabled={busy || session.status !== "active"}
                          onClick={() =>
                            mutate((d) => {
                              answer(d, session.id, "unknown", Date.now());
                            })
                          }
                        >
                          모르겠음 제출
                        </button>
                        <span className="original-muted">
                          키보드 1–4로 선택
                        </span>
                      </div>
                    )}
                    {session.mode === "exam" && (
                      <div className="original-quiz-actions">
                        <button
                          aria-pressed={session.responses[q.id] === "unknown"}
                          disabled={
                            busy || session.status !== "active" || expired
                          }
                          onClick={() =>
                            mutate((d) => {
                              answer(d, session.id, "unknown", Date.now());
                            })
                          }
                        >
                          모르겠음
                        </button>
                        <button
                          aria-pressed={!!session.review[q.id]}
                          disabled={
                            busy || session.status !== "active" || expired
                          }
                          onClick={() =>
                            mutate((d) => {
                              const s = d.sessions.find(
                                (x) => x.id === session.id,
                              )!;
                              if (
                                !expire(d, Date.now()) &&
                                s.status === "active"
                              )
                                s.review[q.id] = !s.review[q.id];
                            })
                          }
                        >
                          {session.review[q.id]
                            ? "검토 표시 해제"
                            : "검토 표시"}
                        </button>
                        <span className="original-muted">
                          답은 제출 전까지 바꿀 수 있어요.
                        </span>
                      </div>
                    )}
                  </section>
                  <div className="original-movement">
                    <button
                      aria-label="이전 문항"
                      disabled={
                        busy ||
                        session.index === 0 ||
                        session.status !== "active" ||
                        expired
                      }
                      onClick={() =>
                        mutate((d) => {
                          move(d, session.id, session.index - 1, Date.now());
                        })
                      }
                    >
                      ← 이전 문항
                    </button>
                    <span>
                      {session.index + 1} / {session.questions.length}
                    </span>
                    <button
                      aria-label="다음 문항"
                      disabled={
                        busy ||
                        session.index === session.questions.length - 1 ||
                        session.status !== "active" ||
                        expired ||
                        (session.mode !== "exam" && !attempted)
                      }
                      onClick={() =>
                        mutate((d) => {
                          move(d, session.id, session.index + 1, Date.now());
                        })
                      }
                    >
                      다음 문항 →
                    </button>
                  </div>
                  <div className="original-finish">
                    <button
                      className={session.mode === "exam" ? "primary" : ""}
                      disabled={busy || session.status !== "active"}
                      onClick={() => {
                        if (
                          session.mode === "exam" &&
                          !window.confirm(
                            "시험을 제출할까요? 미응답은 0점으로 확정되며 이후 답을 바꿀 수 없습니다.",
                          )
                        )
                          return;
                        void mutate(
                          (d) => {
                            finish(d, session.id, Date.now());
                          },
                          () => setPage("result"),
                        );
                      }}
                    >
                      {session.mode === "exam" ? "시험 제출" : "학습 종료"}
                    </button>
                    {namespace === "real" &&
                      cloud.auth &&
                      session.status === "active" && (
                        <button
                          disabled={busy || cloud.busy}
                          onClick={() => {
                            if (
                              session.mode === "exam" &&
                              !window.confirm(
                                "시험을 제출하고 동기화할까요? 미응답은 0점으로 확정됩니다.",
                              )
                            )
                              return;
                            void mutate(
                              (d) => {
                                finish(d, session.id, Date.now());
                              },
                              () => {
                                setPage("result");
                                void cloud.controller.sync();
                              },
                            );
                          }}
                        >
                          학습 마치고 동기화
                        </button>
                      )}
                    {session.status !== "active" && (
                      <button
                        className="primary"
                        onClick={() => setPage("result")}
                      >
                        결과 보기
                      </button>
                    )}
                  </div>
                </div>
                <QuizAnswerSheet
                  open={answerSheetOpen}
                  onClose={() => setAnswerSheetOpen(false)}
                  fontScale={state.settings.fontScale}
                >
                  <aside className="original-answer-panel">
                    <h2>{session.mode === "exam" ? "답안표" : "학습 진행"}</h2>
                    <p className="original-muted">
                      {session.mode === "exam"
                        ? "● 응답 · ◇ 검토 표시"
                        : "제출한 문항을 다시 확인할 수 있어요."}
                    </p>
                    <div className="original-answer-map">
                      {session.questions.map((item, i) => {
                        const recorded = state.attempts.some(
                          (a) =>
                            a.sessionId === session.id &&
                            a.questionId === item.id,
                        );
                        const responded = session.responses[item.id] != null;
                        return (
                          <button
                            key={item.id}
                            aria-label={`${i + 1}번 문항으로 이동`}
                            aria-current={
                              session.index === i ? "step" : undefined
                            }
                            className={`${responded || recorded ? "filled" : ""} ${session.index === i ? "current" : ""}`}
                            disabled={
                              busy ||
                              session.status !== "active" ||
                              expired ||
                              (session.mode !== "exam" &&
                                i > session.index &&
                                !attempted &&
                                !recorded)
                            }
                            onClick={() => {
                              setAnswerSheetOpen(false);
                              void mutate((d) => {
                                move(d, session.id, i, Date.now());
                              });
                            }}
                          >
                            {i + 1}
                            {session.review[item.id] && <small>◇</small>}
                          </button>
                        );
                      })}
                    </div>
                    {session.mode === "exam" && (
                      <p>
                        {
                          session.questions.filter(
                            (item) => session.responses[item.id] != null,
                          ).length
                        }{" "}
                        / {session.questions.length}문항 응답
                      </p>
                    )}
                  </aside>
                </QuizAnswerSheet>
              </div>
            </InkProvider>
          )}
          {page === "result" && session && (
            <Result
              state={state}
              session={session}
              namespace={namespace}
              onHome={() => navigate("home")}
              onRetry={() => {
                const qs = weakQuestions(state, session);
                void begin("study", qs);
              }}
              busy={busy}
            />
          )}
          {page === "settings" && (
            <>
              <div className="original-eyebrow">DATA & SETTINGS</div>
              <h1>데이터·설정</h1>
              <p className="original-muted">
                문제 데이터와 학습 기록은 이 브라우저에 저장됩니다.
              </p>
              <section>
                <h2>학습 환경</h2>
                <label className="original-field">
                  글자 크기
                  <select
                    value={state.settings.fontScale}
                    disabled={busy}
                    onChange={(e) =>
                      mutate((d) => {
                        d.settings.fontScale = Number(e.target.value);
                      })
                    }
                  >
                    {[1, 1.25, 1.5, 2].map((n) => (
                      <option key={n} value={n}>
                        {n * 100}%
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  현재 {namespace === "demo" ? "기능 확인용 시연" : "실제 학습"}{" "}
                  영역 · 원문 {listedQuestions.length}문항 · 풀이 가능{" "}
                  {eligible.length}문항 · 보류 {held}문항
                </p>
              </section>
              <section>
                <h2>문제 데이터 가져오기</h2>
                <p>
                  UTF-8 JSON · 최대 20 MiB. 검사와 변경 미리보기 후 반영합니다.
                  원문 객관식과 기존 OX 형식을 자동으로 구분합니다.
                </p>
                {active && (
                  <p className="original-notice">
                    진행 중 세션을 종료한 뒤 가져오기·복구를 진행하세요.
                  </p>
                )}
                <label className="original-field">
                  문제 JSON 가져오기
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={busy || !!active}
                    onChange={(e) => {
                      void readFile(e.target.files?.[0], "import");
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  onClick={() => {
                    try {
                      for (const pkg of exportOriginalPackages(
                        {
                          ...state.data,
                          questions: listedQuestions,
                          assets: state.data.assets.filter((asset) =>
                            visibleAssetIds.has(asset.assetId),
                          ),
                        },
                        namespace,
                      ))
                        download(pkg, `${pkg.packageId}.json`);
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  문제 데이터만 내보내기
                </button>
                <p className="original-muted">
                  최신 문항과 그림을 가져올 수 있는 묶음으로 내보냅니다. 학습
                  기록은 전체 백업에 포함됩니다.
                </p>
              </section>
              <PackageManager
                state={state}
                namespace={namespace}
                busy={busy}
                onPreview={() => {
                  setPending(null);
                  fileRequest.current++;
                }}
                onDelete={async (ids, includeUnassigned) => {
                  let saved = false;
                  await mutate(
                    (d) => {
                      applyPackageDeletion(d, ids, includeUnassigned);
                    },
                    () => {
                      saved = true;
                      setPending(null);
                      fileRequest.current++;
                      setNotice("선택한 문제 데이터를 삭제했습니다.");
                    },
                  );
                  return saved;
                }}
              />
              <section>
                <h2>전체 백업·복구</h2>
                <p>
                  원문·그림·응답·다시 보기·진행 세션·설정과 기존 OX 데이터를
                  함께 백업합니다. 실제·시연 영역은 구분합니다.
                </p>
                <button className="primary" onClick={exportBackup}>
                  전체 백업 내보내기
                </button>
                <label className="original-field">
                  전체 백업 복구
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={busy || !!active}
                    onChange={(e) => {
                      void readFile(e.target.files?.[0], "restore");
                      e.target.value = "";
                    }}
                  />
                </label>
              </section>
              {pending && (
                <section
                  className="original-pending"
                  role="region"
                  aria-label="가져오기 미리보기"
                >
                  <h2>적용 전 확인</h2>
                  <p>{pending.description}</p>
                  {pending.sample?.map((q, i) => (
                    <details key={q.id}>
                      <summary>
                        미리보기 {i + 1} · {subjectLabels[q.subjectId]} ·{" "}
                        {namespace === "demo"
                          ? "기능 확인용 시연"
                          : `${q.source.year}년 ${q.source.round}차 ${q.source.questionNumber}번`}
                      </summary>
                      <Blocks blocks={q.body} assets={pending.assets ?? []} />
                      {q.choices.map((c) => (
                        <div className="original-result-choice" key={c.number}>
                          <b>{c.number}.</b>
                          <Blocks
                            blocks={c.blocks}
                            assets={pending.assets ?? []}
                          />
                        </div>
                      ))}
                      <p className="original-muted">
                        {isEligible(q, namespace)
                          ? "풀이 가능"
                          : "보관 전용 · 원문·정답 확인 또는 특별 처리 상태를 확인하세요."}
                        {q.classification?.studyStatus !== "confirmed"
                          ? " · 학습 단원 분류 보류"
                          : ""}
                        {q.classification?.blueprintStatus !== "confirmed"
                          ? " · 모의고사 영역 분류 보류"
                          : ""}
                      </p>
                    </details>
                  ))}
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={applyPending}
                    >
                      확인하고 적용
                    </button>
                    <button onClick={() => setPending(null)}>취소</button>
                  </div>
                </section>
              )}
              <section>
                <h2>학습 자료 현황</h2>
                <p>
                  헌법 19 · 형법총론 12 · 형법각론 20 · 경찰학 29개 단원과
                  형사소송법 수사·증거 임시 대분류를 사용합니다.
                </p>
                <p className="original-muted">
                  분류가 보류된 문항도 원문과 정답 검수가 완료되면 과목
                  전체·회차별로 풀 수 있습니다. 경위·미래 과목의 시험 편성은
                  비활성입니다.
                </p>
                <details>
                  <summary>목차 연결 확인 결과</summary>
                  <pre>{JSON.stringify(mappingReport, null, 2)}</pre>
                </details>
              </section>
            </>
          )}
          <footer className="original-footer">
            경찰 기출 학습실 · 개인 학습용
            <span>
              공식 최종 정답으로 학습합니다. 정기적으로 기록을 백업하세요.
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Scope({
  state,
  namespace,
  selection: q,
  onChange,
  page,
  busy,
  onBegin,
}: {
  state: OriginalState;
  namespace: Namespace;
  selection: OriginalSelection;
  onChange: (s: OriginalSelection) => void;
  page: Page;
  busy: boolean;
  onBegin: () => void;
}) {
  const update = (patch: Partial<OriginalSelection>) =>
    onChange({ ...q, ...patch, bookUnitIds: [] });
  const allSelected = selectQuestions(state, namespace, {
    ...q,
    bookUnitIds: [],
    order: page === "round" ? "ordered" : q.order,
  });
  const selected =
    page !== "round" && q.limit ? allSelected.slice(0, q.limit) : allSelected;
  const availability = examAvailability(state, namespace, q);
  const visibleQuestions = state.data.questions.filter(
    (question) => !(state.removedQuestionIds ?? []).includes(question.id),
  );
  const years = [...new Set(visibleQuestions.map((q) => q.source.year))].sort(
    (a, b) => b - a,
  );
  const rounds = [
    ...new Set(
      visibleQuestions
        .filter((item) => !q.year || item.source.year === Number(q.year))
        .map((q) => q.source.round),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  const currentUnits = units.filter(
    (u) => !q.subjectId || u.subjectId === q.subjectId,
  );
  const groups = [
    ...new Set(currentUnits.map((u) => u.group || "형사소송법 임시 대분류")),
  ];
  const toggle = (codes: string[]) =>
    update({
      unitCodes: codes.every((code) => q.unitCodes.includes(code))
        ? q.unitCodes.filter((code) => !codes.includes(code))
        : [...new Set([...q.unitCodes, ...codes])],
    });
  return (
    <>
      <section className="original-scope">
        <div className="original-fields">
          {page !== "exam" && (
            <label className="original-field">
              과목
              <select
                value={q.subjectId}
                onChange={(e) =>
                  update({
                    subjectId: e.target.value,
                    unitCodes: [],
                    bookUnitIds: [],
                  })
                }
              >
                <option value="">전체 과목</option>
                {["constitution", "criminal", "police"].map((id) => (
                  <option key={id} value={id}>
                    {subjectLabels[id]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="original-field">
            연도
            <select
              value={q.year}
              onChange={(e) => update({ year: e.target.value, round: "" })}
            >
              <option value="">전체 연도</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
          </label>
          <label className="original-field">
            회차
            <select
              value={q.round}
              onChange={(e) => update({ round: e.target.value })}
            >
              <option value="">전체 회차</option>
              {rounds.map((r) => (
                <option key={r} value={r}>
                  {r}차
                </option>
              ))}
            </select>
          </label>
          {page !== "exam" && (
            <label className="original-field">
              학습 대상
              <select
                value={q.filter}
                onChange={(e) =>
                  update({
                    filter: e.target.value as OriginalSelection["filter"],
                  })
                }
              >
                <option value="all">전체</option>
                <option value="unanswered">미풀이</option>
                <option value="incorrect">오답</option>
                <option value="unknown">모르겠음</option>
                <option value="marked">다시 보기</option>
                <option value="weak">오답·모르겠음·미응답</option>
              </select>
            </label>
          )}
          {page !== "exam" && page !== "round" && (
            <label className="original-field">
              순서
              <select
                value={q.order}
                onChange={(e) =>
                  update({ order: e.target.value as "ordered" | "random" })
                }
              >
                <option value="ordered">순서대로</option>
                <option value="random">무작위</option>
              </select>
            </label>
          )}
          {page !== "exam" && page !== "round" && (
            <label className="original-field">
              문항 수
              <select
                value={[0, 10, 20, 40].includes(q.limit) ? q.limit : "custom"}
                onChange={(e) =>
                  update({
                    limit:
                      e.target.value === "custom" ? 1 : Number(e.target.value),
                  })
                }
              >
                <option value={10}>10문항</option>
                <option value={20}>20문항</option>
                <option value={40}>40문항</option>
                <option value={0}>전체</option>
                <option value="custom">직접 입력</option>
              </select>
              {![0, 10, 20, 40].includes(q.limit) && (
                <input
                  aria-label="직접 입력 문항 수"
                  type="number"
                  min={1}
                  step={1}
                  value={q.limit}
                  onChange={(e) =>
                    update({
                      limit: Math.max(
                        1,
                        Math.floor(Number(e.target.value) || 1),
                      ),
                    })
                  }
                />
              )}
            </label>
          )}
        </div>
        {page !== "exam" && (
          <>
            <details className="original-unit-selector">
              <summary>
                학습 단원 선택{" "}
                <span>
                  {q.unitCodes.length
                    ? "선택 " + q.unitCodes.length + "개"
                    : "전체 범위"}
                </span>
              </summary>
              {groups.map((group) => (
                <div className="original-unit-group" key={group}>
                  <label>
                    <input
                      type="checkbox"
                      checked={currentUnits
                        .filter(
                          (u) =>
                            (u.group || "형사소송법 임시 대분류") === group,
                        )
                        .every((u) => q.unitCodes.includes(u.code))}
                      onChange={() =>
                        toggle(
                          currentUnits
                            .filter(
                              (u) =>
                                (u.group || "형사소송법 임시 대분류") === group,
                            )
                            .map((u) => u.code),
                        )
                      }
                    />
                    <b>{group}</b>
                  </label>
                  <div>
                    {currentUnits
                      .filter(
                        (u) => (u.group || "형사소송법 임시 대분류") === group,
                      )
                      .map((u) => (
                        <label key={u.code} title={u.bookLocation}>
                          <input
                            type="checkbox"
                            checked={q.unitCodes.includes(u.code)}
                            onChange={() => toggle([u.code])}
                          />
                          {u.title}
                        </label>
                      ))}
                  </div>
                </div>
              ))}
            </details>
          </>
        )}
      </section>
      {page === "exam" ? (
        <>
          <section>
            <h2>영역별 준비 현황</h2>
            <p className="original-muted">
              앱의 고정 편성 목표입니다. 모든 실제 시험이 같은 문항 수로
              출제된다는 의미는 아닙니다.
            </p>
            <div className="original-table-wrap">
              <table className="original-table">
                <thead>
                  <tr>
                    <th>과목 · 출제 영역</th>
                    <th>필요</th>
                    <th>보유</th>
                    <th>부족</th>
                  </tr>
                </thead>
                <tbody>
                  {availability.map((a) => (
                    <tr key={a.code}>
                      <td>
                        <small>{subjectLabels[a.subjectId]}</small>
                        {a.title}
                      </td>
                      <td>{a.targetQuestions}</td>
                      <td>{a.available}</td>
                      <td className={a.shortage ? "shortage" : ""}>
                        {a.shortage || "준비 완료"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="original-start">
            <div>
              <strong>
                {availability.some((a) => a.shortage)
                  ? "영역별 기출이 더 필요합니다"
                  : "100문항이 준비되었습니다"}
              </strong>
              <p>
                {namespace === "demo"
                  ? "기능 확인용 100문항 시연 시험입니다."
                  : "부족한 영역을 다른 영역이나 중복 문항으로 채우지 않습니다."}
              </p>
            </div>
            <button
              className="primary"
              disabled={busy || availability.some((a) => a.shortage)}
              onClick={onBegin}
            >
              시작하기
            </button>
          </div>
        </>
      ) : (
        <div className="original-start">
          <div>
            <strong>{selected.length}문항으로 학습합니다</strong>
            <p>
              {q.limit > 0 && page !== "round"
                ? `${q.limit}문항 요청 · 선택 범위의 유효 문항만 사용`
                : "선택 범위의 전체 문항"}
              {!selected.length ? " · 범위를 넓히거나 자료를 가져오세요." : ""}
            </p>
          </div>
          <button
            className="primary"
            disabled={
              busy ||
              !selected.length ||
              (page === "round" && (!q.subjectId || !q.year || !q.round))
            }
            onClick={onBegin}
          >
            시작하기
          </button>
        </div>
      )}
      {page === "round" && (!q.subjectId || !q.year || !q.round) && (
        <p className="original-muted">
          회차별 풀이는 과목·연도·회차를 선택한 뒤 시작합니다.
        </p>
      )}
    </>
  );
}

function Blocks({ blocks, assets, readingFlow = false }: { blocks: Block[]; assets: Asset[]; readingFlow?: boolean }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <p className="original-content" key={i}>
            <ReadingFlowText text={b.text} enabled={readingFlow} />
          </p>
        ) : b.type === "statements" ? (
          <div className="original-statements" key={i}>
            {b.entries.map((e, j) => (
              <p key={j}>
                <b>{e.label}</b>
                <span><ReadingFlowText text={e.text} enabled={readingFlow} /></span>
              </p>
            ))}
          </div>
        ) : (
          <figure key={i}>
            {assets.find((a) => a.assetId === b.assetId) ? (
              <img
                src={`data:${assets.find((a) => a.assetId === b.assetId)!.mimeType};base64,${assets.find((a) => a.assetId === b.assetId)!.base64}`}
                alt={b.alt}
              />
            ) : (
              <p>그림을 불러올 수 없습니다.</p>
            )}
            {b.alt && <figcaption>{b.alt}</figcaption>}
          </figure>
        ),
      )}
    </>
  );
}
function Result({
  state,
  session,
  namespace,
  onHome,
  onRetry,
  busy,
}: {
  state: OriginalState;
  session: OriginalSession;
  namespace: Namespace;
  onHome: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const summary = resultSummary(state, session),
    weak = weakQuestions(state, session);
  return (
    <>
      <div className="original-eyebrow">YOUR LEARNING RECORD</div>
      <h1>학습 결과</h1>
      <p className="original-muted">
        {namespace === "demo"
          ? "기능 확인용 시연 결과 · 실제 기출이 아닙니다."
          : "출제 당시 공식 최종 정답 기준"}{" "}
        · {session.mode === "exam" ? "실전 모의고사" : "원문 학습"}
      </p>
      <section className="original-result-hero">
        <div>
          <span>{session.mode === "exam" ? "총점" : "정답률"}</span>
          <strong>
            {session.mode === "exam" ? summary.points : summary.rate}
            <small>
              {session.mode === "exam" ? ` / ${summary.maxPoints}점` : "%"}
            </small>
          </strong>
        </div>
        <div className="original-result-counts">
          {(["correct", "incorrect", "unknown", "unanswered"] as const).map(
            (key) => (
              <div key={key}>
                <b>
                  {key === "unanswered" && session.mode !== "exam"
                    ? summary.total - summary.answered
                    : summary[key]}
                </b>
                <span>
                  {key === "unanswered" && session.mode !== "exam"
                    ? "미풀이"
                    : resultLabels[key]}
                </span>
              </div>
            ),
          )}
        </div>
      </section>
      <section>
        <h2>과목별 기록</h2>
        <div className="original-table-wrap">
          <table className="original-table">
            <thead>
              <tr>
                <th>과목</th>
                <th>정답</th>
                <th>오답</th>
                <th>모르겠음</th>
                <th>{session.mode === "exam" ? "미응답" : "미풀이"}</th>
                <th>점수</th>
              </tr>
            </thead>
            <tbody>
              {summary.subjects.map((s) => (
                <tr key={s.subjectId}>
                  <td>{subjectLabels[s.subjectId]}</td>
                  <td>{s.correct}</td>
                  <td>{s.incorrect}</td>
                  <td>{s.unknown}</td>
                  <td>
                    {session.mode === "exam"
                      ? s.unanswered
                      : s.total - s.answered}
                  </td>
                  <td>
                    {s.points} / {s.maxPoints}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {session.mode !== "exam" && (
          <p className="original-muted">
            학습 종료 때 답하지 않은 문항은 풀이 이력이나 자동 오답으로 기록하지
            않습니다.
          </p>
        )}
      </section>
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !weak.length}
          onClick={onRetry}
        >
          이번 오답 다시 풀기 ({weak.length})
        </button>
        <button onClick={onHome}>학습 홈으로</button>
      </div>
      <section>
        <h2>문항별 결과</h2>
        <div className="original-result-list">
          {session.questions.map((q, i) => {
            const a = state.attempts.find(
              (a) => a.sessionId === session.id && a.questionId === q.id,
            );
            return (
              <details key={q.id}>
                <summary>
                  {i + 1}번 · {subjectLabels[q.subjectId]}{" "}
                  <span>
                    {a
                      ? resultLabels[a.result]
                      : session.mode === "exam"
                        ? "미응답"
                        : "미풀이"}
                  </span>
                </summary>
                <Blocks blocks={q.body} assets={session.assets} />
                {q.choices.map((c) => (
                  <div className="original-result-choice" key={c.number}>
                    <b>{c.number}.</b>
                    <Blocks blocks={c.blocks} assets={session.assets} />
                  </div>
                ))}
                <p>
                  {namespace === "demo" ? "시연 정답" : "공식 최종 정답"}{" "}
                  {q.officialAnswer.acceptedChoices.join(", ")}번 · 내 답{" "}
                  {a?.response === "unknown"
                    ? "모르겠음"
                    : a?.response
                      ? `${a.response}번`
                      : "미응답"}
                </p>
                <p className="original-muted">
                  다시 보기 {state.marks[q.id] ? "표시됨" : "표시 없음"} · 검토{" "}
                  {session.review[q.id] ? "표시됨" : "표시 없음"}
                </p>
              </details>
            );
          })}
        </div>
      </section>
    </>
  );
}
function clockText(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
