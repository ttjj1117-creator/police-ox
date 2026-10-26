import { useEffect, useState } from "react";
import type { Asset, Namespace, Question } from "../model";
import type { OriginalState } from "../engine";
import { activeSession } from "../engine";
import { subjectLabels } from "../validation";
import { download } from "../../data/transfer";
import { errorMessage } from "../../domain/schema";
import {
  explanationIndex,
  MAX_EXPLANATION_BYTES,
  validateExplanationPackage,
  type ExplanationPackage,
} from "./contract";
import {
  emptyFrequencyFilter,
  frequencyAnalysis,
  resolveExplanations,
  type FrequencyFilter,
  type FrequencyRow,
  type ResolvedExplanation,
} from "./analysis";
import "./explanations.css";

export interface ExplanationLoadState {
  loading: boolean;
  error: string;
  reload: () => void;
}

function LibraryNotice({ state }: { state: ExplanationLoadState }) {
  if (state.error)
    return (
      <p role="alert">
        해설 자료를 불러오지 못했습니다. {state.error} 문제 풀이와 채점은 계속
        사용할 수 있습니다.{" "}
        <button onClick={state.reload}>해설 다시 불러오기</button>
      </p>
    );
  return state.loading ? <p role="status">해설 자료 불러오는 중…</p> : null;
}

export function ExplanationManager({
  namespace,
  questions,
  assets,
  packages,
  blocked,
  loading,
  error,
  onImport,
  onReload,
}: {
  namespace: Namespace;
  questions: Question[];
  assets: Asset[];
  packages: ExplanationPackage[];
  blocked: boolean;
  loading: boolean;
  error: string;
  onImport: (value: unknown) => Promise<unknown>;
  onReload: () => void;
}) {
  const [preview, setPreview] = useState<ExplanationPackage | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <section className="explanation-manager" aria-label="해설 자료 관리">
      <h2>해설 자료 가져오기</h2>
      <p>
        미리 제작한 해설·원문 발췌를 별도로 보관합니다. 가져오기 검사는 법률
        검증을 대신하지 않습니다.
      </p>
      <p className="original-muted">
        이 기기·현재 계정·{namespace === "real" ? "실제 학습" : "시연"} 영역
        전용입니다. 기존 전체 백업·기기 동기화에는 포함되지 않습니다. 아래에서
        해설 파일을 내보내 다른 기기에 따로 가져올 수 있습니다.
      </p>
      {blocked && (
        <p role="status">
          진행 중 풀이를 종료한 뒤 해설 자료를 변경할 수 있습니다.
        </p>
      )}
      {loading && <p role="status">해설 자료 불러오는 중…</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={onReload}>해설 다시 불러오기</button>
        </p>
      )}
      <label className="original-field">
        해설 JSON 가져오기
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy || blocked || loading || !!error}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            setPreview(null);
            setMessage("");
            if (!file) return;
            setBusy(true);
            try {
              if (file.size > MAX_EXPLANATION_BYTES)
                throw Error("해설 파일은 20 MiB 이하여야 합니다.");
              setPreview(
                await validateExplanationPackage(
                  JSON.parse(await file.text()),
                  namespace,
                  questions,
                  assets,
                ),
              );
            } catch (err) {
              setMessage(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {message && (
        <p role="status" className="pre">
          {message}
        </p>
      )}
      {preview && (
        <div
          className="explanation-preview"
          aria-label="해설 가져오기 미리보기"
        >
          <h3>적용 전 확인</h3>
          <p>
            {preview.packageId} · 버전 {preview.packageVersion} · 근거{" "}
            {preview.bases.length}개 · 쟁점 {preview.issues.length}개 · 해설{" "}
            {preview.explanations.length}개
          </p>
          <p>
            검증 완료 표시는 제작자의 확인 기록을 유지합니다. 원문·정답·학습
            기록은 변경하지 않습니다. 같은 자료의 새 버전은 원자적으로
            교체합니다.
          </p>
          <button
            disabled={busy || blocked}
            onClick={async () => {
              if (busy || blocked) return;
              setBusy(true);
              try {
                await onImport(preview);
                setPreview(null);
                setMessage("검증한 해설 자료를 저장했습니다.");
              } catch (e) {
                setMessage(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            해설 확인하고 적용
          </button>
          <button disabled={busy} onClick={() => setPreview(null)}>
            해설 가져오기 취소
          </button>
        </div>
      )}
      {!packages.length && !loading && !error && (
        <p>
          등록된 해설 자료가 없습니다. 해설 없이도 기존 문제 풀이·채점은 사용할
          수 있습니다.
        </p>
      )}
      <ul>
        {packages.map((p) => (
          <li key={p.packageId}>
            {p.packageId} · 버전 {p.packageVersion} · 해설{" "}
            {p.explanations.length}개{" "}
            <button
              onClick={() => download(p, `${p.packageId}.explanations.json`)}
            >
              해설 자료 내보내기
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function displayReferences(
  references: ExplanationPackage["explanations"][number]["references"],
) {
  const map = new Map<string, Set<string>>();
  for (const ref of references) {
    const issues = map.get(ref.basisId) ?? new Set<string>();
    ref.issueIds.forEach((id) => issues.add(id));
    map.set(ref.basisId, issues);
  }
  return [...map].map(([basisId, issueIds]) => ({
    basisId,
    issueIds: [...issueIds],
  }));
}
export function ExplanationView({
  question,
  assets,
  packages,
  namespace,
  libraryState,
}: {
  question: Question;
  assets: Asset[];
  packages: ExplanationPackage[];
  namespace: Namespace;
  libraryState: ExplanationLoadState;
}) {
  const [result, setResult] = useState<{
    question: Question;
    packages: ExplanationPackage[];
    rows: ResolvedExplanation[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    resolveExplanations(
      question,
      packages.filter((p) => p.dataKind === namespace),
      assets,
    )
      .then((rows) => {
        if (live) setResult({ question, packages, rows });
      })
      .catch((e) => {
        if (live)
          setResult({ question, packages, rows: [], error: errorMessage(e) });
      });
    return () => {
      live = false;
    };
  }, [question, packages, assets, namespace]);
  const current =
    result?.question === question && result.packages === packages
      ? result
      : null;
  const index = explanationIndex(
    packages.filter((p) => p.dataKind === namespace),
  );
  const confirmed =
    current?.rows.filter((r) => r.status === "verified").length ?? 0;
  return (
    <details className="explanation-panel">
      <summary>
        지문별 해설 ·{" "}
        {libraryState.error
          ? "자료 읽기 오류"
          : libraryState.loading
            ? "불러오는 중"
            : current
              ? confirmed
                ? `확정 ${confirmed}개`
                : current.error
                  ? "자료 확인 오류"
                  : current.rows.length
                    ? "미등록·검토 상태"
                    : "해설 자료 미등록"
              : "불러오는 중"}
      </summary>
      <LibraryNotice state={libraryState} />
      {!libraryState.loading && !libraryState.error && (
        <>
          {current?.error && <p role="alert">{current.error}</p>}
          {current && !current.error && !current.rows.length && (
            <p>
              이 문항에 등록된 해설이 없습니다. 문제 풀이와 채점 결과는 그대로
              사용할 수 있습니다.
            </p>
          )}
          {current?.rows.map(({ explanation: e, status, reason }) => (
            <article
              key={e.id}
              className="explanation-entry"
              data-explanation-status={status}
            >
              <h3>
                {e.selector.kind === "choice"
                  ? `${e.selector.number}번 선택지`
                  : e.selector.kind === "entry"
                    ? `${e.selector.area === "body" ? "보기" : `${e.selector.choiceNumber}번 선택지 보기`} ${e.selector.label}`
                    : `${e.selector.area === "body" ? "본문" : `${e.selector.choiceNumber}번 선택지`} 문장`}{" "}
                ·{" "}
                {status === "verified"
                  ? namespace === "demo"
                    ? "시연 확인 자료"
                    : "검증 완료"
                  : status === "stale"
                    ? "버전 불일치"
                    : status === "hold"
                      ? "보류"
                      : "검토 중"}
              </h3>
              {status !== "verified" ? (
                <p>
                  {reason ?? "미검증 자료는 확정 해설로 표시하지 않습니다."}
                </p>
              ) : (
                <>
                  <p className="explanation-target">{e.expectedText}</p>
                  <p className="explanation-reason">{e.explanation}</p>
                  {displayReferences(e.references).map((ref, n) => {
                    const b = index.bm.get(ref.basisId)!;
                    return (
                      <div
                        className="explanation-basis"
                        key={`${ref.basisId}:${n}`}
                      >
                        <h4>{b.title}</h4>
                        <p>
                          {[
                            b.identity.authority,
                            b.identity.number,
                            b.identity.date,
                          ]
                            .filter(Boolean)
                            .join(" · ")}{" "}
                          ·{" "}
                          {b.temporalBasis === "current" ? "현행" : "출제 당시"}{" "}
                          기준 {b.asOfDate}
                        </p>
                        {[...new Set(ref.issueIds)].map((id) => {
                          const i = index.im.get(id)!;
                          return (
                            <div key={id}>
                              <b>{i.title}</b>
                              <blockquote>{i.excerpt}</blockquote>
                              <p className="original-muted">
                                발췌 위치: {i.locator}
                              </p>
                            </div>
                          );
                        })}
                        {b.sourceUrl && (
                          <a
                            href={b.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            출처 원문 새 창에서 열기
                          </a>
                        )}
                        {b.originalText && (
                          <details>
                            <summary>이 기기에 보관된 원문</summary>
                            <pre>{b.originalText}</pre>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </article>
          ))}
        </>
      )}
    </details>
  );
}

export function EvidenceAnalysis({
  state,
  namespace,
  packages,
  onOpen,
  onResume,
  libraryState,
}: {
  state: OriginalState;
  namespace: Namespace;
  packages: ExplanationPackage[];
  onOpen: (id: string) => void;
  onResume: () => void;
  libraryState: ExplanationLoadState;
}) {
  const [filter, setFilter] = useState<FrequencyFilter>(emptyFrequencyFilter),
    [kind, setKind] = useState<"basis" | "issue">("basis"),
    [selected, setSelected] = useState<FrequencyRow | null>(null);
  const [result, setResult] = useState<Awaited<
      ReturnType<typeof frequencyAnalysis>
    > | null>(null),
    [error, setError] = useState("");
  const active = activeSession(state),
    hidden = active?.mode === "exam";
  useEffect(() => {
    let live = true;
    setSelected(null);
    setResult(null);
    if (hidden || libraryState.loading || libraryState.error) return;
    frequencyAnalysis(
      state.data.questions,
      state.data.assets,
      packages,
      namespace,
      state.removedQuestionIds,
      filter,
    )
      .then((r) => {
        if (live) {
          setResult(r);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [
    state.data,
    state.removedQuestionIds,
    packages,
    namespace,
    filter,
    hidden,
    libraryState.loading,
    libraryState.error,
  ]);
  if (hidden)
    return (
      <section>
        <h1>근거·출제 빈도</h1>
        <p>진행 중인 모의고사의 근거·해설은 제출 뒤 확인할 수 있습니다.</p>
        <button onClick={onResume}>진행 중 시험 이어 풀기</button>
      </section>
    );
  const choices = (field: "examCode" | "year" | "round") =>
    [
      ...new Set(
        state.data.questions
          .filter(
            (q) => (q.source.examCode === "demo") === (namespace === "demo"),
          )
          .map((q) => String(q.source[field])),
      ),
    ].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  return (
    <section className="evidence-analysis">
      <h1>근거·출제 빈도</h1>
      <p>
        {namespace === "demo"
          ? "시연 집계 · 실제 출제 통계가 아닙니다."
          : "등록된 원본 기출과 버전이 맞는 검증 완료 연결만 집계합니다."}{" "}
        풀이 횟수·오답률과 다른 지표이며 미래 출제 확률을 뜻하지 않습니다.
      </p>
      <div className="original-fields">
        <label>
          과목
          <select
            value={filter.subjectId}
            onChange={(e) =>
              setFilter({ ...filter, subjectId: e.target.value })
            }
          >
            <option value="">전체 과목</option>
            {Object.entries(subjectLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(["examCode", "year", "round"] as const).map((field) => (
          <label key={field}>
            {field === "examCode"
              ? "시험 종류"
              : field === "year"
                ? "연도"
                : "회차"}
            <select
              value={filter[field]}
              onChange={(e) =>
                setFilter({ ...filter, [field]: e.target.value })
              }
            >
              <option value="">전체</option>
              {choices(field).map((v) => (
                <option key={v} value={v}>
                  {field === "examCode"
                    ? v === "po"
                      ? "순경"
                      : v === "lieut"
                        ? "경위"
                        : "시연"
                    : v}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <LibraryNotice state={libraryState} />
      {!libraryState.loading && !libraryState.error && (
        <>
          {error && <p role="alert">{error}</p>}
          {!result && !error && <p role="status">집계 중…</p>}
          {result && (
            <>
              {!packages.some((p) => p.dataKind === namespace) && (
                <p role="status" className="original-notice">
                  분석 자료 미등록 · 해설 자료를 등록하면 근거·출제 빈도를
                  확인할 수 있습니다. 현재 0건은 중요도가 낮다는 뜻이 아닙니다.
                </p>
              )}
              <p className="frequency-coverage" role="status">
                집계 대상 원본 {result.total}문항 · 검증 연결 문항{" "}
                {result.covered}개 ({result.coverage}%) · 미연결{" "}
                {result.unlinked}문항 · 연결된 판단 대상 {result.targets}개 ·
                검토·보류 연결 {result.pending}개 · 버전 불일치 {result.stale}개
              </p>
              <p className="original-muted">
                연결률은 하나 이상 확정 근거가 연결된 문항 비율이며, 모든 지문
                해설의 완성률은 아닙니다.
              </p>
              {result.duplicates.length > 0 && (
                <details className="original-notice">
                  <summary>
                    중복 출처 {result.duplicates.length}건 · 내용 충돌{" "}
                    {result.ambiguous}건 제외
                  </summary>
                  {result.duplicates.map((d, i) => (
                    <p key={i}>
                      {d.questionIds.join(", ")} ·{" "}
                      {d.conflict
                        ? "원문 충돌로 집계 제외"
                        : "동일 출처를 합집합으로 집계"}
                    </p>
                  ))}
                </details>
              )}
              <div role="group" aria-label="빈도 집계 종류">
                <button
                  aria-pressed={kind === "basis"}
                  onClick={() => {
                    setKind("basis");
                    setSelected(null);
                  }}
                >
                  판례·근거별
                </button>
                <button
                  aria-pressed={kind === "issue"}
                  onClick={() => {
                    setKind("issue");
                    setSelected(null);
                  }}
                >
                  쟁점별
                </button>
              </div>
              {!result.rows.some((r) => r.kind === kind) && (
                <p>이 범위에 검증 완료된 근거 연결이 없습니다.</p>
              )}
              <div className="frequency-table">
                <table>
                  <thead>
                    <tr>
                      <th>근거·쟁점</th>
                      <th>출제 문제 수</th>
                      <th>출제 회차 수</th>
                      <th>등장 지문 수</th>
                      <th>최근 출제 시점</th>
                      <th>관련 기출</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows
                      .filter((r) => r.kind === kind)
                      .map((row) => (
                        <tr key={row.id}>
                          <td>{row.title}</td>
                          <td>{row.questions}</td>
                          <td>{row.rounds}</td>
                          <td>{row.targets}</td>
                          <td>{row.latest}</td>
                          <td>
                            <button onClick={() => setSelected(row)}>
                              관련 기출 {row.questions}문항
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {selected && (
            <section aria-label="관련 기출 목록">
              <h2>{selected.title} · 관련 기출</h2>
              {active && (
                <p>
                  현재 풀이를 보존합니다. 새 문항을 풀려면 진행 중 학습을 먼저
                  종료하세요.{" "}
                  <button onClick={onResume}>진행 중 학습 이어 풀기</button>
                </p>
              )}
              <ul>
                {selected.related.map((q) => (
                  <li key={q.id}>
                    {q.source.examName} · {subjectLabels[q.subjectId]} ·{" "}
                    {q.source.year}년 {q.source.round}차{" "}
                    {q.source.questionNumber}번{" "}
                    <button disabled={!!active} onClick={() => onOpen(q.id)}>
                      이 기출 풀기
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
