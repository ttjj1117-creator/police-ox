import { useEffect, useMemo, useRef, useState } from "react";
import type { Namespace, Question } from "../model";
import { activeSession, type OriginalState } from "../engine";
import { isEligible, subjectLabels, units } from "../validation";
import { errorMessage } from "../../domain/schema";
import {
  sourceKey,
  type ExplanationPackage,
  type TargetSelector,
} from "../explanations/contract";
import type { ExplanationLoadState } from "../explanations/ExplanationUI";
import type { InstructorPackage } from "../instructor/contract";
import type { FrequentFilter, FrequentIssuesPackage } from "./contract";
import {
  analyzeUnifiedFrequentIssues,
  emptyFrequentFilter,
  getFrequentIssuesIndex,
} from "./analysis";
import "./frequent.css";

type FrequentIndex = Awaited<ReturnType<typeof getFrequentIssuesIndex>>;
type Analysis = ReturnType<typeof analyzeUnifiedFrequentIssues>;
type FrequentRow = Analysis["rows"][number];
type ReadingSource = FrequentRow["reading"]["sources"][number];

interface FrequentReadingViewState {
  expanded: string[];
  showAllExcerpts: boolean;
  showAllVariants: boolean;
}

const emptyReadingView = (): FrequentReadingViewState => ({
  expanded: [],
  showAllExcerpts: false,
  showAllVariants: false,
});

export interface FrequentViewState {
  filter: FrequentFilter;
  selectedKey: string;
  mode: "questions" | "reading";
  search: string;
  page: number;
  scrollY: number;
  listScrollY: number;
  listPaneScroll: number;
  detailScroll: number;
  detailOpen: boolean;
  reading: FrequentReadingViewState;
}

export function createFrequentViewState(): FrequentViewState {
  return {
    filter: { ...emptyFrequentFilter, subjectId: "constitution" },
    selectedKey: "",
    mode: "questions",
    search: "",
    page: 0,
    scrollY: 0,
    listScrollY: 0,
    listPaneScroll: 0,
    detailScroll: 0,
    detailOpen: false,
    reading: emptyReadingView(),
  };
}

/** Old source-lane selections are discarded; only a canonical topic can reopen. */
export function normalizeFrequentViewState(
  value: Partial<FrequentViewState> & { kind?: unknown },
  defaultSubject = "constitution",
): FrequentViewState {
  const initial = createFrequentViewState();
  const oldSourceSelection =
    value.kind !== undefined && value.kind !== "reviewed-topic";
  const canonicalSelection =
    !oldSourceSelection &&
    typeof value.selectedKey === "string" &&
    value.selectedKey.startsWith("reviewed-topic:");
  const position = (number: number | undefined) =>
    typeof number === "number" && Number.isFinite(number)
      ? Math.max(0, number)
      : 0;
  return {
    filter: {
      ...initial.filter,
      ...value.filter,
      subjectId: value.filter?.subjectId ?? defaultSubject,
    },
    selectedKey: canonicalSelection ? value.selectedKey! : "",
    mode: value.mode === "reading" ? "reading" : "questions",
    search: oldSourceSelection ? "" : (value.search ?? ""),
    page: oldSourceSelection ? 0 : Math.floor(position(value.page)),
    scrollY: position(value.scrollY),
    listScrollY: position(value.listScrollY ?? value.scrollY),
    listPaneScroll: position(value.listPaneScroll),
    detailScroll: position(value.detailScroll),
    detailOpen: canonicalSelection && (value.detailOpen ?? true),
    reading: canonicalSelection
      ? (value.reading ?? emptyReadingView())
      : emptyReadingView(),
  };
}

export interface FrequentIssuesProps {
  state: OriginalState;
  namespace: Namespace;
  ownerKey: string;
  legacyPackages: ExplanationPackage[];
  instructorPackages: InstructorPackage[];
  handoff: FrequentIssuesPackage | null;
  libraryState: ExplanationLoadState;
  viewState: FrequentViewState;
  onViewStateChange: (value: FrequentViewState) => void;
  onViewQuestion: (questionId: string) => void;
  onPractice: (questionIds: string[]) => void;
  onResume: () => void;
}

const classificationLabels = {
  topic: "주제",
  issue: "쟁점",
  subissue: "세부 쟁점",
  unspecified: "기존 검토 쟁점 · 분류 수준 미지정",
};

function questionLabel(question: Question) {
  return `${question.source.examName} · ${subjectLabels[question.subjectId] ?? question.subjectId} · ${question.source.year}년 ${question.source.round}차 ${question.source.questionNumber}번`;
}

function targetLabel(selector: TargetSelector | null) {
  if (!selector) return "문항 전체";
  if (selector.kind === "choice") return `${selector.number}번 선택지`;
  const area =
    selector.area === "body" ? "본문" : `${selector.choiceNumber}번 선택지`;
  return selector.kind === "entry"
    ? `${area} 보기 ${selector.label}`
    : `${area} 문장`;
}

function httpSource(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? value
      : null;
  } catch {
    return null;
  }
}

function SourceReference({
  source,
  expanded,
  onExpand,
}: {
  source: ReadingSource;
  expanded: boolean;
  onExpand: (open: boolean) => void;
}) {
  const url = httpSource(source.sourceUrl);
  return (
    <li className="frequent-source">
      <strong>{source.title}</strong>
      <p className="frequent-meta">
        {source.kind === "legacy"
          ? "원문 근거"
          : source.sourceType === "ai_assisted_reference"
            ? "AI 활용 참고자료"
            : source.sourceType === "instructor"
              ? "강사 해설"
              : "해설 출처 · 유형 미기재"}
        {" · "}
        {source.legalStatus === "verified"
          ? "원문 검증 기록 유지"
          : "법률 상태 미검토"}
      </p>
      {source.locator && (
        <p className="frequent-source-locator">발췌 위치: {source.locator}</p>
      )}
      {source.locations.length > 0 && (
        <details
          open={expanded}
          onToggle={(event) => onExpand(event.currentTarget.open)}
        >
          <summary>
            PDF{" "}
            {Array.from(
              new Set(source.locations.map((location) => location.page)),
            ).join(", ")}
            쪽 · 위치 확인
          </summary>
          <p className="frequent-meta">
            {source.locationPrecision === "source-lines"
              ? "원문 줄과 대조한 인용 위치입니다."
              : "해설 문단의 위치입니다. 인용문 한 줄의 위치로 보지 않습니다."}
          </p>
          <ul className="frequent-location-list">
            {source.locations.map((location, index) => (
              <li key={`${location.page}:${index}`}>
                PDF {location.page}쪽
                {location.printedPage != null &&
                  ` · 인쇄 ${location.printedPage}쪽`}
                {location.bbox &&
                  ` · 영역 ${location.bbox.map((value) => Math.round(value * 10) / 10).join(", ")}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer">
          출처 원문 열기 ↗
        </a>
      )}
    </li>
  );
}

function RowMetrics({
  row,
  wrong,
  unanswered,
}: {
  row: FrequentRow;
  wrong: number;
  unanswered: number;
}) {
  return (
    <dl className="frequent-row-metrics">
      <div>
        <dt>고유 문항</dt>
        <dd>
          {row.questions}
          <small>문항</small>
        </dd>
      </div>
      <div>
        <dt>반복 회차</dt>
        <dd>
          {row.rounds}
          <small>회</small>
        </dd>
      </div>
      <div>
        <dt>개인 오답</dt>
        <dd>
          {wrong}
          <small>문항</small>
        </dd>
      </div>
      <div>
        <dt>미풀이</dt>
        <dd>
          {unanswered}
          <small>문항</small>
        </dd>
      </div>
    </dl>
  );
}

function Coverage({ result }: { result: Analysis }) {
  const diagnostics = result.diagnosticAnalysis;
  const lanes = [
    { key: "legacy" as const, label: "원문 근거 검증 기준" },
    { key: "source" as const, label: "강사 해설 인용 기준" },
    { key: "reviewed" as const, label: "학습 쟁점 의미 확인 기준" },
  ];
  return (
    <details className="frequent-data-details">
      <summary>데이터 상세 · 연결률·보류 상태</summary>
      <section className="frequent-coverage" aria-label="선택 범위의 연결 현황">
        <div className="frequent-section-heading">
          <h2>선택 범위의 연결 현황</h2>
          <span>고유 원본 {result.total.toLocaleString()}문항</span>
        </div>
        <div className="frequent-coverage-grid">
          {lanes.map(({ key, label }) => {
            const lane =
              key === "reviewed"
                ? result.lanes.reviewed
                : diagnostics.lanes[key];
            return (
              <div className="frequent-coverage-item" key={key}>
                <h3>{label}</h3>
                <p>
                  <strong>{lane.covered.toLocaleString()}</strong> /{" "}
                  {lane.total.toLocaleString()}문항 <b>{lane.coverage}%</b>
                </p>
                <p className="frequent-meta">
                  미연결 {lane.unlinked.toLocaleString()}문항 · 지문{" "}
                  {lane.targets.toLocaleString()}개
                </p>
              </div>
            );
          })}
        </div>
        <p className="frequent-meta">
          연결률은 하나 이상 해당 연결이 있는 원본 문항의 비율입니다. 모든
          지문의 해설 완성률이 아니며, 세 기준의 문항은 서로 겹칠 수 있습니다.
          출처 연결률을 학습 쟁점의 의미 분류 완료율로 사용하지 않습니다.
        </p>
        {[
          { label: "의미 분류 상태", statuses: result.statuses },
          { label: "기존 근거·출처 연결 상태", statuses: diagnostics.statuses },
        ].map(({ label, statuses }) => (
          <div className="frequent-statuses" aria-label={label} key={label}>
            <strong>{label}</strong>
            <span>
              {label === "의미 분류 상태" ? "의미 미확인" : "미식별·검토"}{" "}
              {statuses.unknown.toLocaleString()}문항
            </span>
            <span>보류 {statuses.hold.toLocaleString()}문항</span>
            <span>충돌 {statuses.conflict.toLocaleString()}문항</span>
            <span>버전 불일치 {statuses.stale.toLocaleString()}문항</span>
          </div>
        ))}
        <p className="frequent-meta">
          상태는 문항별로 셉니다. 한 문항이 여러 상태에 포함될 수 있으며, 의미
          미확인·보류·충돌·버전 불일치 연결은 학습 쟁점 빈도에서 제외합니다.
          인용 미식별은 의미 확인 여부와 별도로 관리합니다.
        </p>
        {result.duplicates.length > 0 && (
          <details className="frequent-duplicates">
            <summary>
              같은 원본 중복 {result.duplicates.length}건 · 내용 충돌{" "}
              {result.ambiguous}건 제외
            </summary>
            <p>
              같은 시험·과목·연도·회차·문항 번호는 한 번 셉니다. 여러 강사, 인용
              중복, 재가져오기와 재풀이는 출제 수를 늘리지 않습니다.
            </p>
          </details>
        )}
      </section>
    </details>
  );
}

function ReadingPanel({
  row,
  view,
  onChange,
  onViewQuestion,
}: {
  row: FrequentRow;
  view: FrequentReadingViewState;
  onChange: (value: FrequentReadingViewState) => void;
  onViewQuestion: (id: string) => void;
}) {
  const excerpts = [
    ...new Map(
      row.reading.excerpts.map((excerpt) => [
        JSON.stringify([excerpt.kind, excerpt.sourceId, excerpt.text]),
        excerpt,
      ]),
    ).values(),
  ];
  const verified = excerpts.filter(
    (excerpt) => excerpt.kind === "verified-excerpt",
  );
  const contexts = excerpts.filter(
    (excerpt) => excerpt.kind === "instructor-context",
  );
  const shownContexts = view.showAllExcerpts ? contexts : contexts.slice(0, 8);
  const variants = view.showAllVariants ? row.links : row.links.slice(0, 12);
  const expand = (id: string, open: boolean) => {
    if (view.expanded.includes(id) === open) return;
    onChange({
      ...view,
      expanded: open
        ? [...view.expanded, id]
        : view.expanded.filter((value) => value !== id),
    });
  };
  const labels = new Map(
    row.related.map((question) => [question.id, questionLabel(question)]),
  );
  return (
    <div className="frequent-reading">
      {verified.length > 0 && (
        <section aria-label="확인한 원문 발췌">
          <h3>확인한 원문 발췌</h3>
          <p className="frequent-meta">
            기존 검증 자료의 원문 발췌입니다. 조건·예외를 합친 새 해설로
            확대하지 않습니다.
          </p>
          {verified.map((excerpt) => (
            <figure className="frequent-excerpt" key={excerpt.id}>
              <figcaption>{excerpt.title} · 원문 검증 발췌</figcaption>
              <blockquote>{excerpt.text}</blockquote>
            </figure>
          ))}
        </section>
      )}
      {row.reading.notes.length > 0 && (
        <details className="frequent-review-record">
          <summary>의미 연결 검토 기록 {row.reading.notes.length}개</summary>
          <ul className="frequent-review-notes">
            {row.reading.notes.map((note) => (
              <li key={note.id}>
                <p>{note.text}</p>
                <small>
                  {labels.get(note.questionId) ?? "연결 문항"} ·{" "}
                  {targetLabel(note.selector)}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {contexts.length > 0 && (
        <section aria-label="확인한 해설 문맥">
          <h3>확인한 해설 문맥</h3>
          <p className="frequent-meta">
            원문 해설의 문단을 그대로 표시합니다. 인용 대조·문맥 연결과 현행
            법률 검증은 구분합니다.
          </p>
          {shownContexts.map((excerpt) => (
            <details
              className="frequent-context"
              key={excerpt.id}
              open={view.expanded.includes(`context:${excerpt.id}`)}
              onToggle={(event) =>
                expand(`context:${excerpt.id}`, event.currentTarget.open)
              }
            >
              <summary>
                {excerpt.title} · {targetLabel(excerpt.selector)}
              </summary>
              <p className="frequent-meta">
                {labels.get(excerpt.questionId) ?? "연결 문항"} · 법률 상태
                미검토
              </p>
              <blockquote>{excerpt.text}</blockquote>
            </details>
          ))}
          {!view.showAllExcerpts && contexts.length > shownContexts.length && (
            <button
              onClick={() => onChange({ ...view, showAllExcerpts: true })}
            >
              나머지 해설 문맥 {contexts.length - shownContexts.length}개 보기
            </button>
          )}
        </section>
      )}
      {variants.length > 0 && (
        <section aria-label="기출 변형과 비교">
          <h3>기출 변형·비교</h3>
          <p className="frequent-meta">
            실제 출제된 지문과 연결 검토 기록입니다. 출제 지문 자체가 옳은
            명제라는 뜻은 아니며 정오 판단은 문제 화면에서 확인합니다.
          </p>
          <ol className="frequent-variants">
            {variants.map((link) => (
              <li key={link.id}>
                <strong>
                  {questionLabel(link.question)} · {targetLabel(link.selector)}
                </strong>
                {link.selector && link.expectedText ? (
                  <blockquote>{link.expectedText}</blockquote>
                ) : (
                  <p className="frequent-meta">
                    문항 전체 연결입니다. 특정 지문의 연결로 세지 않습니다.
                  </p>
                )}
                {link.semanticReason && (
                  <p className="frequent-semantic-note">
                    문맥 검토: {link.semanticReason}
                  </p>
                )}
                <button onClick={() => onViewQuestion(link.question.id)}>
                  관련 원문 보기
                </button>
              </li>
            ))}
          </ol>
          {!view.showAllVariants && row.links.length > variants.length && (
            <button
              onClick={() => onChange({ ...view, showAllVariants: true })}
            >
              나머지 기출 연결 {row.links.length - variants.length}개 보기
            </button>
          )}
        </section>
      )}
      {row.reading.sources.length > 0 && (
        <section aria-label="관련 해설·출처">
          <h3>출처</h3>
          <ul className="frequent-sources">
            {row.reading.sources.map((source, index) => (
              <SourceReference
                key={`${source.id}:${index}`}
                source={source}
                expanded={view.expanded.includes(
                  `source:${source.id}:${index}`,
                )}
                onExpand={(open) =>
                  expand(`source:${source.id}:${index}`, open)
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function FrequentIssues({
  state,
  namespace,
  ownerKey,
  legacyPackages,
  instructorPackages,
  handoff,
  libraryState,
  viewState: suppliedViewState,
  onViewStateChange,
  onViewQuestion,
  onPractice,
  onResume,
}: FrequentIssuesProps) {
  const active = activeSession(state);
  const hidden = active?.mode === "exam";
  const eligible = useMemo(() => {
    const removed = new Set(state.removedQuestionIds ?? []);
    return state.data.questions.filter(
      (question) =>
        !removed.has(question.id) && isEligible(question, namespace),
    );
  }, [state.data.questions, state.removedQuestionIds, namespace]);
  const subjects = Object.entries(subjectLabels).filter(([id]) =>
    eligible.some((question) => question.subjectId === id),
  );
  const defaultSubject = subjects[0]?.[0] ?? "constitution";
  const viewState = useMemo(
    () => normalizeFrequentViewState(suppliedViewState, defaultSubject),
    [suppliedViewState, defaultSubject],
  );
  useEffect(() => {
    if (JSON.stringify(suppliedViewState) !== JSON.stringify(viewState))
      onViewStateChange(viewState);
  }, [suppliedViewState, viewState, onViewStateChange]);
  useEffect(() => {
    const subjectId = viewState.filter.subjectId;
    if (
      !eligible.length ||
      !subjectId ||
      eligible.some((question) => question.subjectId === subjectId)
    )
      return;
    onViewStateChange({
      ...viewState,
      filter: { ...viewState.filter, subjectId: defaultSubject, unitId: "" },
      selectedKey: "",
      detailOpen: false,
      page: 0,
      detailScroll: 0,
    });
  }, [eligible, defaultSubject, viewState, onViewStateChange]);
  const rootRef = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(window.innerWidth <= 850);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width <= 850),
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [hidden]);
  const [loaded, setLoaded] = useState<{
    input: Parameters<typeof getFrequentIssuesIndex>[0];
    index: FrequentIndex;
  } | null>(null);
  const [failure, setFailure] = useState<{
    input: Parameters<typeof getFrequentIssuesIndex>[0];
    message: string;
  } | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const viewRef = useRef(viewState);
  const changeRef = useRef(onViewStateChange);
  viewRef.current = viewState;
  changeRef.current = onViewStateChange;
  const restored = useRef(false);
  const input = useMemo(
    () => ({
      questions: state.data.questions,
      assets: state.data.assets,
      legacyPackages,
      instructorPackages,
      handoff,
      namespace,
      ownerKey,
      removed: state.removedQuestionIds,
    }),
    [
      state.data.questions,
      state.data.assets,
      state.removedQuestionIds,
      legacyPackages,
      instructorPackages,
      handoff,
      namespace,
      ownerKey,
    ],
  );
  useEffect(() => {
    let current = true;
    if (hidden || libraryState.loading || libraryState.error) return;
    getFrequentIssuesIndex(input)
      .then((index) => {
        if (current) {
          setLoaded({ input, index });
          setFailure(null);
        }
      })
      .catch((error) => {
        if (current) setFailure({ input, message: errorMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [input, hidden, libraryState.loading, libraryState.error]);
  const index =
    loaded?.input === input && !libraryState.loading && !libraryState.error
      ? loaded.index
      : null;
  const filter = useMemo(
    () => viewState.filter,
    [
      viewState.filter.subjectId,
      viewState.filter.unitId,
      viewState.filter.examCode,
      viewState.filter.year,
      viewState.filter.round,
    ],
  );
  const result = useMemo(
    () => (index ? analyzeUnifiedFrequentIssues(index, filter) : null),
    [index, filter],
  );
  const error = failure?.input === input ? failure.message : "";
  useEffect(() => {
    if (!result || restored.current || hidden) return;
    restored.current = true;
    const saved = viewRef.current.scrollY;
    let nextFrame = 0;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => {
        window.scrollTo({ top: saved, behavior: "instant" });
        if (listRef.current)
          listRef.current.scrollTop = viewRef.current.listPaneScroll;
        if (detailRef.current)
          detailRef.current.scrollTop = viewRef.current.detailScroll;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
    };
  }, [result, hidden]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (!restored.current || hidden || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const latest = viewRef.current;
        const listPaneScroll =
          listRef.current?.scrollTop ?? latest.listPaneScroll;
        const detailScroll =
          detailRef.current?.scrollTop ?? latest.detailScroll;
        if (
          Math.abs(window.scrollY - latest.scrollY) > 2 ||
          Math.abs(listPaneScroll - latest.listPaneScroll) > 2 ||
          Math.abs(detailScroll - latest.detailScroll) > 2
        )
          changeRef.current({
            ...latest,
            scrollY: window.scrollY,
            listPaneScroll,
            detailScroll,
          });
      }, 180);
    };
    window.addEventListener("scroll", save, { passive: true });
    const list = listRef.current;
    const detail = detailRef.current;
    list?.addEventListener("scroll", save, { passive: true });
    detail?.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      list?.removeEventListener("scroll", save);
      detail?.removeEventListener("scroll", save);
      if (timer) clearTimeout(timer);
    };
  }, [hidden, !!result]);
  const outcomes = useMemo(() => {
    const questions = new Map(
      state.data.questions.map((question) => [question.id, question]),
    );
    const outcomes = new Map<string, string>();
    for (const attempt of state.attempts) {
      const question = questions.get(attempt.questionId);
      if (question && attempt.gradingRevision === question.gradingRevision)
        outcomes.set(sourceKey(question), attempt.result);
    }
    return outcomes;
  }, [state.data.questions, state.attempts]);
  const wrongFor = (row: FrequentRow) =>
    row.related.filter(
      (question) => outcomes.get(sourceKey(question)) === "incorrect",
    );
  const unansweredFor = (row: FrequentRow) =>
    row.related.filter((question) => !outcomes.has(sourceKey(question)));
  const patch = (value: Partial<FrequentViewState>) =>
    onViewStateChange({ ...viewRef.current, ...value });
  const currentPosition = () => ({
    scrollY: window.scrollY,
    listPaneScroll: listRef.current?.scrollTop ?? viewState.listPaneScroll,
    detailScroll: detailRef.current?.scrollTop ?? viewState.detailScroll,
  });
  const openQuestion = (id: string) => {
    patch(currentPosition());
    onViewQuestion(id);
  };
  const practice = (questions: Question[]) => {
    if (active || !questions.length) return;
    patch(currentPosition());
    onPractice(questions.map((question) => question.id));
  };
  const changeFilter = (value: Partial<FrequentFilter>) =>
    patch({
      filter: { ...viewState.filter, ...value },
      page: 0,
      selectedKey: "",
      mode: "questions",
      detailOpen: false,
      listPaneScroll: 0,
      detailScroll: 0,
    });
  const choices = (field: "examCode" | "year" | "round") =>
    Array.from(
      new Set(
        eligible
          .filter(
            (question) =>
              !viewState.filter.subjectId ||
              question.subjectId === viewState.filter.subjectId,
          )
          .map((question) => String(question.source[field])),
      ),
    ).sort((a, b) => b.localeCompare(a, "ko", { numeric: true }));
  const selected = result?.rows.find(
    (row) => row.key === viewState.selectedKey,
  );
  const rows = result?.rows ?? [];
  const search = viewState.search.trim().toLocaleLowerCase("ko");
  const visibleRows = rows.filter(
    (row) =>
      !search ||
      [row.title, ...row.aliases].some((title) =>
        title.toLocaleLowerCase("ko").includes(search),
      ),
  );
  const ranks = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const row of rows) {
    const group = `${row.subjectId}:${row.classificationLevel}`;
    const rank = (groupCounts.get(group) ?? 0) + 1;
    groupCounts.set(group, rank);
    ranks.set(row.key, rank);
  }
  const pageSize = 24;
  const pages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const page = Math.min(Math.max(viewState.page, 0), pages - 1);
  const pageRows = visibleRows.slice(page * pageSize, (page + 1) * pageSize);
  const pageGroups = pageRows.reduce<
    {
      subjectId: FrequentRow["subjectId"];
      level: FrequentRow["classificationLevel"];
      rows: FrequentRow[];
    }[]
  >((groups, row) => {
    const group = groups.find(
      (group) =>
        group.subjectId === row.subjectId &&
        group.level === row.classificationLevel,
    );
    if (group) group.rows.push(row);
    else
      groups.push({
        subjectId: row.subjectId,
        level: row.classificationLevel,
        rows: [row],
      });
    return groups;
  }, []);
  const selectRow = (row: FrequentRow, mode: FrequentViewState["mode"]) => {
    patch({
      selectedKey: row.key,
      mode,
      ...currentPosition(),
      listScrollY:
        viewState.detailOpen && narrow ? viewState.listScrollY : window.scrollY,
      detailOpen: true,
      detailScroll: 0,
      reading:
        row.key === viewState.selectedKey
          ? viewState.reading
          : emptyReadingView(),
    });
    requestAnimationFrame(() => {
      if (detailRef.current) detailRef.current.scrollTop = 0;
      if (narrow) window.scrollTo({ top: 0, behavior: "instant" });
      detailHeadingRef.current?.focus({ preventScroll: true });
    });
  };
  const returnToList = () => {
    patch({ detailOpen: false, scrollY: viewState.listScrollY });
    requestAnimationFrame(() => {
      window.scrollTo({ top: viewState.listScrollY, behavior: "instant" });
      if (listRef.current) listRef.current.scrollTop = viewState.listPaneScroll;
      listRef.current
        ?.querySelector<HTMLButtonElement>(".is-selected h3 button")
        ?.focus({ preventScroll: true });
    });
  };

  if (hidden)
    return (
      <section className="frequent-issues" aria-label="빈출 쟁점">
        <h1>빈출 쟁점</h1>
        <p className="frequent-reading-notice">
          진행 중인 모의고사의 쟁점·근거·해설은 제출 뒤 확인할 수 있습니다.
        </p>
        <button className="primary" onClick={onResume}>
          진행 중 시험 이어 풀기
        </button>
      </section>
    );

  return (
    <section
      className={`frequent-issues${viewState.detailOpen && selected ? " is-detail-open" : ""}`}
      aria-label="빈출 쟁점"
      ref={rootRef}
    >
      <div className="frequent-overview">
        <header className="frequent-heading">
          <div>
            <h1>빈출 쟁점</h1>
          </div>
          <p>과목·단원을 골라 관련 기출을 확인하고 바로 풀 수 있습니다.</p>
        </header>
        <p className="frequent-meta">
          {namespace === "demo"
            ? "시연 자료의 집계입니다. 실제 출제 통계가 아닙니다. "
            : "등록된 원본과 현재 버전이 맞는 연결을 집계합니다. "}
          출제 문제 수는 개인 풀이 횟수와 구분하며, 미래 출제 확률을 뜻하지
          않습니다.
        </p>
        <div
          className="frequent-filters"
          role="group"
          aria-label="빈출 쟁점 범위"
        >
          <label>
            과목
            <select
              aria-label="과목"
              value={viewState.filter.subjectId}
              onChange={(event) =>
                changeFilter({ subjectId: event.target.value, unitId: "" })
              }
            >
              <option value="">전체 과목</option>
              {!subjects.length && viewState.filter.subjectId && (
                <option value={viewState.filter.subjectId}>
                  {Object.entries(subjectLabels).find(
                    ([id]) => id === viewState.filter.subjectId,
                  )?.[1] ?? "헌법"}
                </option>
              )}
              {subjects.map(([id, label]) => (
                <option value={id} key={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="frequent-unit-filter">
            기존 단원
            <select
              aria-label="기존 단원"
              value={viewState.filter.unitId}
              onChange={(event) => changeFilter({ unitId: event.target.value })}
            >
              <option value="">전체 단원</option>
              {Array.from(
                new Set(
                  units
                    .filter(
                      (unit) =>
                        !viewState.filter.subjectId ||
                        unit.subjectId === viewState.filter.subjectId,
                    )
                    .map((unit) => unit.group),
                ),
              ).map((group) => (
                <optgroup label={group} key={group}>
                  {units
                    .filter(
                      (unit) =>
                        unit.group === group &&
                        (!viewState.filter.subjectId ||
                          unit.subjectId === viewState.filter.subjectId),
                    )
                    .map((unit) => (
                      <option value={unit.code} key={unit.code}>
                        {viewState.filter.subjectId
                          ? ""
                          : `${subjectLabels[unit.subjectId]} · `}
                        {unit.title}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          {(["examCode", "year", "round"] as const).map((field) => (
            <label key={field}>
              {field === "examCode"
                ? "시험"
                : field === "year"
                  ? "연도"
                  : "회차"}
              <select
                aria-label={
                  field === "examCode"
                    ? "시험"
                    : field === "year"
                      ? "연도"
                      : "회차"
                }
                value={viewState.filter[field]}
                onChange={(event) =>
                  changeFilter({ [field]: event.target.value })
                }
              >
                <option value="">전체</option>
                {choices(field).map((value) => (
                  <option value={value} key={value}>
                    {field === "examCode"
                      ? value === "po"
                        ? "순경"
                        : value === "lieut"
                          ? "경위"
                          : "시연"
                      : field === "year"
                        ? `${value}년`
                        : `${value}차`}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>
      {libraryState.loading && (
        <p role="status">연결·해설 자료를 불러오는 중…</p>
      )}
      {libraryState.error && (
        <p role="alert">
          연결 자료를 불러오지 못했습니다. {libraryState.error}{" "}
          <button onClick={libraryState.reload}>자료 다시 불러오기</button>
        </p>
      )}
      {!libraryState.loading && !libraryState.error && (
        <>
          {error && (
            <p role="alert">
              집계를 완료하지 못했습니다. {error}{" "}
              <button onClick={libraryState.reload}>자료 다시 불러오기</button>
            </p>
          )}
          {!result && !error && (
            <p role="status">원본 버전과 연결을 확인하는 중…</p>
          )}
          {result && (
            <>
              {!handoff &&
                !legacyPackages.some((pack) => pack.dataKind === namespace) && (
                  <p className="frequent-reading-notice" role="status">
                    연결 자료가 등록되지 않았습니다. 문항·해설에서 의미를 확인한
                    연결 자료가 도착하면 학습 쟁점으로 표시합니다. 현재 0건은
                    중요도가 낮다는 뜻이 아닙니다.
                  </p>
                )}
              <div className="frequent-analysis-summary">
                <p className="frequent-semantic-coverage" role="status">
                  의미 확인 {result.covered.toLocaleString()} /{" "}
                  {result.total.toLocaleString()}문항 · 학습 쟁점{" "}
                  {result.rows.length.toLocaleString()}개
                  <span>
                    현재 확인한 범위이며, 미연결은 미출제를 뜻하지 않습니다.
                  </span>
                </p>
                <Coverage result={result} />
              </div>
              <div className="frequent-workspace">
                <div className="frequent-list-area" ref={listRef}>
                  <label className="frequent-search">
                    쟁점·별칭 검색
                    <input
                      type="search"
                      value={viewState.search}
                      placeholder="쟁점명 또는 별칭으로 찾기"
                      onChange={(event) =>
                        patch({
                          search: event.target.value,
                          page: 0,
                          detailOpen: false,
                        })
                      }
                    />
                  </label>
                  <p className="frequent-list-count" role="status">
                    {visibleRows.length.toLocaleString()}개 쟁점 · 같은 분류
                    수준에서 문항 수 → 반복 회차 → 최근 출제 순
                  </p>
                  {!pageRows.length && (
                    <div className="frequent-empty">
                      <h2>
                        {search
                          ? "검색한 제목이 없습니다"
                          : "이 범위의 의미 확인 쟁점이 없습니다"}
                      </h2>
                      <p>
                        {search
                          ? "다른 쟁점명이나 별칭으로 검색하세요."
                          : "과목·단원·시험 범위를 바꾸거나 데이터 상세를 확인하세요."}
                      </p>
                    </div>
                  )}
                  {pageGroups.map(({ subjectId, level, rows: groupRows }) => (
                    <section
                      className="frequent-level-group"
                      key={`${subjectId}:${level}`}
                      aria-label={`${subjectLabels[subjectId]} · ${classificationLabels[level]} 순위`}
                    >
                      <h2 className="frequent-level-heading">
                        {subjectLabels[subjectId]} ·{" "}
                        {classificationLabels[level]} 순위
                      </h2>
                      <ol className="frequent-topic-list">
                        {groupRows.map((row) => (
                          <li
                            className={`frequent-topic-card${selected?.key === row.key ? " is-selected" : ""}`}
                            key={row.key}
                          >
                            <h3>
                              <span
                                className="frequent-rank"
                                aria-label={`${ranks.get(row.key)}위`}
                              >
                                {ranks.get(row.key)}
                              </span>
                              <button
                                aria-pressed={selected?.key === row.key}
                                onClick={() => selectRow(row, "questions")}
                              >
                                {row.title}
                              </button>
                            </h3>
                            <RowMetrics
                              row={row}
                              wrong={wrongFor(row).length}
                              unanswered={unansweredFor(row).length}
                            />
                            <p className="frequent-meta">
                              최근 출제 {row.latest}
                            </p>
                            <div className="frequent-card-actions">
                              <button
                                onClick={() => selectRow(row, "questions")}
                              >
                                관련 기출 보기
                              </button>
                              <button
                                className="primary"
                                disabled={!!active || !row.related.length}
                                onClick={() => practice(row.related)}
                              >
                                바로 풀기
                              </button>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))}
                  {pages > 1 && (
                    <nav
                      className="frequent-pagination"
                      aria-label="쟁점 목록 페이지"
                    >
                      <button
                        disabled={page === 0}
                        onClick={() => {
                          patch({ page: page - 1, listPaneScroll: 0 });
                          if (listRef.current) listRef.current.scrollTop = 0;
                          if (narrow)
                            listRef.current?.scrollIntoView({ block: "start" });
                        }}
                      >
                        이전
                      </button>
                      <span>
                        {page + 1} / {pages}
                      </span>
                      <button
                        disabled={page + 1 >= pages}
                        onClick={() => {
                          patch({ page: page + 1, listPaneScroll: 0 });
                          if (listRef.current) listRef.current.scrollTop = 0;
                          if (narrow)
                            listRef.current?.scrollIntoView({ block: "start" });
                        }}
                      >
                        다음
                      </button>
                    </nav>
                  )}
                </div>
                <section
                  className="frequent-detail"
                  ref={detailRef}
                  aria-label="선택한 쟁점의 관련 기출과 해설·출처"
                >
                  {selected ? (
                    <>
                      <button className="frequent-back" onClick={returnToList}>
                        ← 쟁점 목록으로 돌아가기
                      </button>
                      <p className="frequent-eyebrow">
                        {subjectLabels[selected.subjectId]} ·{" "}
                        {classificationLabels[selected.classificationLevel]}{" "}
                        순위 {ranks.get(selected.key)}위
                      </p>
                      <h2 tabIndex={-1} ref={detailHeadingRef}>
                        {selected.title}
                      </h2>
                      <RowMetrics
                        row={selected}
                        wrong={wrongFor(selected).length}
                        unanswered={unansweredFor(selected).length}
                      />
                      <p className="frequent-meta">
                        최근 출제 {selected.latest}
                        {` · 의미 확인 지문 ${selected.targets}개`}
                        {selected.wholeQuestions > 0 &&
                          ` · 문항 전체 연결 ${selected.wholeQuestions}개는 등장 지문 수에 포함하지 않습니다.`}
                      </p>
                      <div className="frequent-practice-actions">
                        <button
                          className="primary"
                          disabled={!!active || !selected.related.length}
                          onClick={() => practice(selected.related)}
                        >
                          관련 기출 {selected.questions}문항 풀기
                        </button>
                        <button
                          disabled={!!active || !wrongFor(selected).length}
                          onClick={() => practice(wrongFor(selected))}
                        >
                          오답만 {wrongFor(selected).length}문항 풀기
                        </button>
                      </div>
                      <p className="frequent-meta">
                        개인 오답은 현재 채점 버전의 최근 풀이 결과입니다. 다시
                        풀어도 출제 수는 늘지 않습니다.
                      </p>
                      {active && (
                        <p className="frequent-reading-notice">
                          진행 중인 학습을 먼저 이어 풀거나 종료한 뒤 새 풀이를
                          시작할 수 있습니다.{" "}
                          <button onClick={onResume}>
                            진행 중 학습 이어 풀기
                          </button>
                        </p>
                      )}
                      <div
                        className="frequent-detail-buttons"
                        role="group"
                        aria-label="쟁점 상세 보기"
                      >
                        <button
                          aria-pressed={viewState.mode === "questions"}
                          onClick={() =>
                            patch({ mode: "questions", detailScroll: 0 })
                          }
                        >
                          관련 기출
                        </button>
                        <button
                          aria-pressed={viewState.mode === "reading"}
                          onClick={() =>
                            patch({ mode: "reading", detailScroll: 0 })
                          }
                        >
                          관련 해설·출처
                        </button>
                      </div>
                      {viewState.mode === "reading" ? (
                        <ReadingPanel
                          key={selected.key}
                          row={selected}
                          view={viewState.reading ?? emptyReadingView()}
                          onChange={(reading) => patch({ reading })}
                          onViewQuestion={openQuestion}
                        />
                      ) : (
                        <ul className="frequent-related-list">
                          {selected.related.map((question) => (
                            <li key={question.id}>
                              <div>
                                <strong>{questionLabel(question)}</strong>
                                {outcomes.get(sourceKey(question)) ===
                                  "incorrect" && (
                                  <span className="frequent-badge is-wrong">
                                    개인 오답
                                  </span>
                                )}
                                {!outcomes.has(sourceKey(question)) && (
                                  <span className="frequent-badge">미풀이</span>
                                )}
                              </div>
                              <button onClick={() => openQuestion(question.id)}>
                                관련 원문 보기
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <div className="frequent-detail-empty">
                      <p className="frequent-eyebrow">
                        쟁점 → 관련 기출 → 바로 풀기
                      </p>
                      <h2>확인할 쟁점을 선택하세요</h2>
                      <p>
                        관련 기출과 개인 오답을 모아 풀고, 같은 연결에 등록된
                        원문·해설 문맥을 읽을 수 있습니다.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
