import { useEffect, useRef, useState } from "react";
import {
  State,
  Selection,
  Namespace,
  defaultSelection,
  errorMessage,
  Item,
  Session,
} from "../domain/schema";
import {
  candidates,
  cycleInfo,
  eligible,
  latest,
  markKey,
  next,
  selectItems,
  sessionWeak,
  startSession,
  submit,
  summary,
  subjectSummaries,
  descendants,
} from "../domain/engine";
import { Repository, Envelope, ConflictError } from "../data/repository";
import {
  backup,
  download,
  MAX_FILE_BYTES,
  mergeDataset,
  parseFile,
  validateBackup,
} from "../data/transfer";
import { subjects } from "../fixtures/data";
import { useCurrentLearning } from "../domain/current-policy";
import { UnitTree } from "./UnitTree";
import { installBookTaxonomies } from "../data/book-taxonomies";

const repository = new Repository();
type Page = "home" | "scope" | "quiz" | "result" | "settings";
type Pending = {
  kind: "import" | "restore";
  value: unknown;
  description: string;
};
const labels = { exam: "출제 당시", current: "현행 기준" };
export function App() {
  const [namespace, setNamespace] = useState<Namespace>(
    new URLSearchParams(location.search).get("mode") === "demo"
      ? "demo"
      : "real",
  );
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [page, setPage] = useState<Page>("home");
  const [selection, setSelection] = useState<Selection>(defaultSelection);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const lock = useRef(false);
  const retry = useRef<(() => Promise<void>) | null>(null);
  const unsaved = useRef<State | null>(null);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("mode", namespace);
    history.replaceState(null, "", url);
    let alive = true;
    setEnvelope(null);
    setPending(null);
    retry.current = null;
    unsaved.current = null;
    setError("");
    repository
      .load(namespace)
      .then(async (loaded) => {
        let e = loaded;
        const policyChanged = useCurrentLearning(e.state, namespace === "demo");
        const booksChanged =
          namespace === "real" && installBookTaxonomies(e.state);
        if (policyChanged || booksChanged) {
          try {
            e = await repository.save(namespace, e.state, e.generation);
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
            e = await repository.load(namespace);
          }
        }
        if (!alive) return;
        setEnvelope(e);
        const active = e.state.sessions.find((x) => x.status === "active");
        setSessionId(active?.id ?? null);
        setPage(active ? "quiz" : "home");
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [namespace]);
  const s = envelope?.state;
  const session = s?.sessions.find((x) => x.id === sessionId);
  const active = s?.sessions.find((x) => x.status === "active");
  async function mutate(change: (draft: State) => void, done?: () => void) {
    if (lock.current || !envelope) return;
    lock.current = true;
    setBusy(true);
    setError("");
    let draft: State | null = null;
    try {
      draft = structuredClone(envelope.state);
      change(draft);
      const saved = await repository.save(
        namespace,
        draft,
        envelope.generation,
      );
      setEnvelope(saved);
      retry.current = null;
      unsaved.current = null;
      done?.();
    } catch (e) {
      if (e instanceof ConflictError) {
        setEnvelope(await repository.load(namespace));
        retry.current = null;
        unsaved.current = null;
        setError(errorMessage(e));
      } else {
        setError("저장되지 않음: " + errorMessage(e));
        unsaved.current = draft;
        retry.current = () => mutate(change, done);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function go(p: Page) {
    setPage(p);
    setNotice("");
  }
  async function begin(items?: Item[]) {
    if (active) {
      setSessionId(active.id);
      go("quiz");
      return;
    }
    await mutate(
      (d) => startSession(d, selection, items),
      () => {
        setSessionId(null);
        setPage("quiz");
      },
    );
  }
  // A successfully created session is selected from the saved state only.
  useEffect(() => {
    if (page === "quiz" && !sessionId && active) setSessionId(active.id);
  }, [page, sessionId, active]);
  async function readFile(file: File | undefined, kind: Pending["kind"]) {
    setError("");
    setPending(null);
    if (!file || !s) return;
    try {
      if (active)
        throw new Error("진행 중 세션을 종료한 뒤 가져오기·복구를 진행하세요.");
      if (file.size > MAX_FILE_BYTES)
        throw new Error("파일은 20MB 이하여야 합니다.");
      const value = parseFile(await file.text());
      if (kind === "import") {
        const preview = mergeDataset(s.dataset, value);
        setPending({
          kind,
          value,
          description: `지문 추가 ${preview.added}개 · 수정 ${preview.updated}개 · 미변경 ${preview.unchanged}개. 누락된 기존 지문은 유지합니다. 목차·묶음·처리 상태도 함께 반영합니다.`,
        });
      } else {
        const restored = validateBackup(value, namespace);
        setPending({
          kind,
          value,
          description: `문제 ${restored.dataset.items.length}개 · 응답 ${restored.attempts.length}개 · 세션 ${restored.sessions.length}개. 현재 ${namespace === "real" ? "실제" : "시연"} 영역을 전부 교체합니다. 먼저 전체 백업을 권장합니다.`,
        });
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  if (!s)
    return (
      <main>
        <h1>경찰시험 OX</h1>
        <p role="status">{error || "학습실을 불러오는 중…"}</p>
        {error && <button onClick={() => location.reload()}>다시 시도</button>}
      </main>
    );
  const allStats = summary(
    s.attempts.filter((a) => a.basis === selection.basis),
  );
  const subjectStats = subjectSummaries(s, selection.basis);
  return (
    <div style={{ fontSize: `${s.settings.fontScale}rem` }}>
      <header>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go("home");
          }}
        >
          <span className="brand-icon">OX</span>
          <span>
            경찰시험 OX<small>나의 학습실</small>
          </span>
        </a>
        <span className="privacy">내 기기에 저장</span>
      </header>
      {namespace === "demo" && (
        <aside className="demo-banner">
          기능 확인용 예시 · 실제 기출이 아닙니다. 기록은 별도 저장됩니다.
        </aside>
      )}
      <nav aria-label="주 메뉴">
        {(
          [
            ["home", "학습 홈"],
            ["scope", "범위 선택"],
            ["settings", "데이터·설정"],
          ] as const
        ).map(([p, label]) => (
          <button
            disabled={busy}
            className={page === p ? "selected" : ""}
            key={p}
            onClick={() => go(p)}
          >
            {label}
          </button>
        ))}
      </nav>
      <main>
        {error && (
          <section className="error" role="alert">
            <strong>
              {error.startsWith("저장되지") ? "저장되지 않음" : "확인해 주세요"}
            </strong>
            <p className="pre">{error}</p>
            {retry.current && (
              <button onClick={() => retry.current?.()}>저장 재시도</button>
            )}
            <button
              onClick={() =>
                download(
                  backup(unsaved.current ?? s, namespace),
                  `police-ox-${namespace}-recovery.json`,
                )
              }
            >
              현재 상태 내보내기
            </button>
          </section>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {page === "home" && (
          <>
            <div className="eyebrow">MY STUDY ROOM</div>
            <h1>
              오늘의 노력이,
              <br />
              내일의 시민을 지킵니다.
            </h1>
            <p className="muted">
              국민이 믿고 의지할 경찰, 그 자부심을 향해 오늘도 한 걸음.
            </p>
            {active && (
              <section className="resume">
                <div>
                  <strong>이어서 학습할 수 있어요</strong>
                  <p>
                    {subjects[active.selection.subjectId]} ·{" "}
                    {labels[active.selection.basis]} · {active.index + 1}/
                    {active.items.length}
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setSessionId(active.id);
                    go("quiz");
                  }}
                >
                  이어 풀기
                </button>
              </section>
            )}
            <section className="stats" aria-label="전체 학습 통계">
              <div>
                <strong>{s.dataset.items.length}</strong>
                <span>등록 지문</span>
              </div>
              <div>
                <strong>{allStats.answered}</strong>
                <span>누적 풀이 수</span>
              </div>
              <div>
                <strong>{allStats.rate}</strong>
                <span>전체 정답률</span>
              </div>
            </section>
            <p className="muted">
              현행 법령·판례 기준으로 푼 기록입니다. 반복 풀이와 ‘모르겠음’도
              풀이 수에 포함됩니다.
            </p>
            <h2>과목별 정답률</h2>
            <p className="muted">
              정답률과 풀이 수를 함께 비교하고, 더 공부할 과목을 선택하세요.
            </p>
            <div className="subject-grid">
              {Object.entries(subjects).map(([id, label], i) => {
                const registered = s.dataset.items.filter(
                  (v) => v.subjectId === id,
                );
                const stats = subjectStats[id];
                return (
                  <button
                    className="subject-card"
                    key={id}
                    onClick={() => {
                      setSelection({
                        ...defaultSelection,
                        basis: selection.basis,
                        subjectId: id as Selection["subjectId"],
                      });
                      go("scope");
                    }}
                  >
                    <span className="subject-number">0{i + 1}</span>
                    <strong>{label}</strong>
                    <div className="subject-performance">
                      <b>{stats.rate}</b>
                      <span>정답률</span>
                    </div>
                    <span className="rate-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${stats.answered ? (stats.correct / stats.answered) * 100 : 0}%`,
                        }}
                      />
                    </span>
                    <span>
                      {stats.answered
                        ? `정답 ${stats.correct}회 / 풀이 ${stats.answered}회`
                        : "아직 푼 기록이 없어요"}
                    </span>
                    <span>
                      {registered.length
                        ? `${registered.length}개 등록 · ${registered.filter((v) => eligible(v, selection.basis)).length}개 검증`
                        : "등록된 지문 없음"}
                    </span>
                    <span className="arrow">→</span>
                  </button>
                );
              })}
            </div>
            {!s.dataset.items.length && (
              <section className="empty">
                <h2>문제 데이터를 기다리고 있어요</h2>
                <p>
                  기본서 목차는 등록되어 있습니다. 실제 문제·해설은 아직
                  입력되지 않았습니다. 검증된 JSON을 가져오거나 기능 확인용
                  예시로 시작하세요.
                </p>
                <div className="actions">
                  <button className="primary" onClick={() => go("settings")}>
                    문제 데이터 가져오기
                  </button>
                  <button onClick={() => setNamespace("demo")}>
                    시연 시작
                  </button>
                </div>
              </section>
            )}
            <p className="muted">
              형사소송법은 수사·증거의 임시 분류만 제공합니다. 검증 표시는
              법률적 정확성을 자동 보증하지 않습니다.
            </p>
          </>
        )}
        {page === "scope" && (
          <Scope
            state={s}
            selection={selection}
            onChange={setSelection}
            busy={busy}
            onBegin={() => begin()}
            onRestart={() =>
              mutate(
                (d) => {
                  const info = cycleInfo(d, selection);
                  d.cycles[info.key] = {
                    ...info.cycle,
                    remaining: [...info.cycle.candidates],
                    round: info.cycle.round + 1,
                  };
                },
                () => setNotice("새 순회를 시작할 수 있습니다."),
              )
            }
            active={!!active}
          />
        )}
        {page === "quiz" && session && (
          <Quiz
            state={s}
            session={session}
            busy={busy}
            onSubmit={(response) =>
              mutate((d) => submit(d, session.id, response))
            }
            onMark={() =>
              mutate((d) => {
                const key = markKey(
                  session.items[session.index].id,
                  session.selection.basis,
                );
                d.marks[key] = !d.marks[key];
              })
            }
            onNext={() =>
              mutate(
                (d) => next(d, session.id),
                () => {
                  if (session.index === session.items.length - 1) go("result");
                },
              )
            }
            onEnd={() =>
              mutate(
                (d) => {
                  d.sessions.find((x) => x.id === session.id)!.status = "ended";
                },
                () => go("result"),
              )
            }
          />
        )}
        {page === "result" && session && (
          <Result
            state={s}
            session={session}
            onClose={() => go("home")}
            onRetry={() => {
              const items = sessionWeak(s, session);
              mutate(
                (d) => startSession(d, session.selection, items),
                () => {
                  setSessionId(null);
                  go("quiz");
                },
              );
            }}
          />
        )}
        {page === "settings" && (
          <>
            <div className="eyebrow">DATA & SETTINGS</div>
            <h1>데이터·설정</h1>
            <section>
              <h2>학습 환경</h2>
              <label className="field">
                저장 영역
                <select
                  disabled={busy}
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value as Namespace)}
                >
                  <option value="real">실제 학습</option>
                  <option value="demo">기능 확인용 예시</option>
                </select>
              </label>
              <label className="field">
                글자 크기
                <select
                  disabled={busy}
                  value={s.settings.fontScale}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    mutate((d) => {
                      d.settings.fontScale = n;
                    });
                  }}
                >
                  {[1, 1.25, 1.5, 2].map((n) => (
                    <option value={n} key={n}>
                      {n * 100}%
                    </option>
                  ))}
                </select>
              </label>
              <p>실제·시연 영역은 문제, 기록, 백업을 각각 보관합니다.</p>
            </section>
            <section>
              <h2>문제 데이터</h2>
              <p>
                JSON · 최대 20MB. 파일 검사 후 변경 내용을 확인하고 적용합니다.
              </p>
              {active && (
                <p className="notice">
                  진행 중 세션이 있습니다. 이어 풀기 화면에서 종료한 뒤
                  가져오세요.
                </p>
              )}
              <label className="field">
                문제 JSON 가져오기
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={busy || !!active}
                  onChange={(e) => {
                    readFile(e.target.files?.[0], "import");
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                onClick={() =>
                  download(
                    { ...s.dataset, exportedAt: new Date().toISOString() },
                    `police-ox-${namespace}-questions.json`,
                  )
                }
              >
                문제 JSON 내보내기
              </button>
              <p className="muted">학습 기록은 포함하지 않습니다.</p>
            </section>
            <section>
              <h2>전체 백업·복구</h2>
              <p>
                현재 {namespace === "real" ? "실제" : "시연"} 영역의 문제, 기록,
                표시, 세션, 순회와 설정을 포함합니다.
              </p>
              <button
                className="primary"
                onClick={() =>
                  download(
                    backup(s, namespace),
                    `police-ox-${namespace}-backup.json`,
                  )
                }
              >
                전체 백업 다운로드
              </button>
              <label className="field">
                전체 백업 복구
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={busy || !!active}
                  onChange={(e) => {
                    readFile(e.target.files?.[0], "restore");
                    e.target.value = "";
                  }}
                />
              </label>
            </section>
            {pending && (
              <section className="preview" aria-label="가져오기 미리보기">
                <h2>
                  {pending.kind === "restore"
                    ? "전체 교체 확인"
                    : "가져오기 미리보기"}
                </h2>
                <p>{pending.description}</p>
                <div className="actions">
                  <button
                    disabled={busy}
                    className="primary"
                    onClick={() =>
                      mutate(
                        (d) => {
                          if (d.sessions.some((x) => x.status === "active"))
                            throw new Error("진행 중 세션을 종료하세요.");
                          if (pending.kind === "import")
                            d.dataset = mergeDataset(
                              d.dataset,
                              pending.value,
                            ).dataset;
                          else
                            Object.assign(
                              d,
                              validateBackup(pending.value, namespace),
                            );
                          useCurrentLearning(d, namespace === "demo");
                          if (namespace === "real") installBookTaxonomies(d);
                        },
                        () => {
                          setPending(null);
                          setNotice("검증한 데이터를 저장했습니다.");
                          setSessionId(null);
                        },
                      )
                    }
                  >
                    확인하고 적용
                  </button>
                  <button onClick={() => setPending(null)}>취소</button>
                </div>
              </section>
            )}
            <section>
              <h2>학습 기록 초기화</h2>
              <p>
                현재 {namespace === "real" ? "실제" : "시연"} 영역의 응답·다시
                보기·세션·순회·배정 기록을 삭제합니다. 문제와 글자 크기는
                유지합니다.
              </p>
              <button
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `현재 ${namespace === "real" ? "실제" : "시연"} 영역의 학습 기록을 모두 삭제할까요? 문제는 유지됩니다.`,
                    )
                  )
                    mutate(
                      (d) => {
                        d.attempts = [];
                        d.marks = {};
                        d.sessions = [];
                        d.cycles = {};
                        d.allocations = {};
                      },
                      () => {
                        setSessionId(null);
                        setNotice("학습 기록을 초기화했습니다.");
                      },
                    );
                }}
              >
                학습 기록 초기화
              </button>
            </section>
            <section>
              <h2>자료 처리 상태</h2>
              {s.dataset.coverage.length ? (
                s.dataset.coverage.map((c) => (
                  <p key={c.id}>
                    {c.year} · {c.round} · {subjects[c.subjectId]}:{" "}
                    {
                      {
                        not_started: "처리 전",
                        partial: "일부 처리",
                        complete: "처리 완료",
                      }[c.status]
                    }{" "}
                    / 분류 {c.classificationComplete ? "완료" : "미완료"}
                  </p>
                ))
              ) : (
                <p>자료 처리 상태 등록 전</p>
              )}
            </section>
          </>
        )}
      </main>
      <footer>
        경찰시험 OX · 개인 학습용
        <br />
        데이터는 이 브라우저에 저장됩니다. 정기적으로 백업하세요.
      </footer>
    </div>
  );
}

function Scope({
  state: s,
  selection: q,
  onChange,
  busy,
  onBegin,
  onRestart,
  active,
}: {
  state: State;
  selection: Selection;
  onChange: (q: Selection) => void;
  busy: boolean;
  onBegin: () => void;
  onRestart: () => void;
  active: boolean;
}) {
  const update = (patch: Partial<Selection>) => onChange({ ...q, ...patch });
  const plan = selectItems(s, q);
  const nodes = s.dataset.taxonomies.filter((n) => n.subjectId === q.subjectId);
  const groups = s.dataset.studyGroups
    .filter((g) => g.subjectId === q.subjectId)
    .sort((a, b) => a.order - b.order);
  const select = (key: "unitIds" | "groupIds", id: string) =>
    update({
      [key]: q[key].includes(id)
        ? q[key].filter((v) => v !== id)
        : [...q[key], id],
    });
  const counts = (id: string) => {
    const ids = descendants(s, [id]),
      registered = s.dataset.items.filter(
        (v) => v.primaryUnitId && ids.has(v.primaryUnitId),
      ),
      valid = registered.filter((v) => eligible(v, q.basis));
    return `등록 ${registered.length} · 검증 ${valid.length} · 미풀이 ${valid.filter((v) => !latest(s, v, q.basis)).length} · 원문 문항 ${new Set(registered.map((v) => v.originalQuestionId)).size}`;
  };
  return (
    <>
      <div className="eyebrow">BUILD YOUR SESSION</div>
      <h1>오늘의 학습 범위</h1>
      <p className="muted">
        여러 단원을 선택해도 같은 지문은 한 번만 나옵니다.
      </p>
      <section>
        <div className="form-grid">
          <label className="field">
            과목
            <select
              value={q.subjectId}
              onChange={(e) =>
                update({
                  subjectId: e.target.value as Selection["subjectId"],
                  unitIds: [],
                  groupIds: [],
                })
              }
            >
              {Object.entries(subjects).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {q.basis === "current" && (
          <p className="notice">
            현행 판단이 검증된 지문만 출제합니다. 검증일 이후의 법령 변경까지
            자동 확인하지 않습니다.
          </p>
        )}
        <div className="segmented">
          <button
            aria-pressed={q.view === "units"}
            className={q.view === "units" ? "selected" : ""}
            onClick={() => update({ view: "units" })}
          >
            기본서 목차별
          </button>
          <button
            aria-pressed={q.view === "groups"}
            className={q.view === "groups" ? "selected" : ""}
            onClick={() => update({ view: "groups" })}
          >
            학습 묶음별
          </button>
        </div>
        <p>
          선택하지 않으면 과목 전체를 학습합니다. 분류 보류 지문은 과목 전체에만
          포함됩니다.
        </p>
        {q.view === "units" ? (
          nodes.length ? (
            <>
              <p className="muted">
                단원 이름을 눌러 하위 단원을 펼치세요. 왼쪽 체크로 전체 또는
                일부를 선택할 수 있습니다.
              </p>
              <UnitTree
                key={q.subjectId}
                nodes={nodes}
                selected={q.unitIds}
                onChange={(unitIds) => update({ unitIds })}
                counts={counts}
              />
            </>
          ) : (
            <p className="empty-inline">목차 등록 전</p>
          )
        ) : groups.length ? (
          groups.map((g) => (
            <label className="unit" key={g.id}>
              <input
                type="checkbox"
                checked={q.groupIds.includes(g.id)}
                onChange={() => select("groupIds", g.id)}
              />
              {g.title}
            </label>
          ))
        ) : (
          <p className="empty-inline">학습 묶음 등록 전</p>
        )}
      </section>
      <section>
        <h2>출제 설정</h2>
        <div className="form-grid">
          <label className="field">
            시험 연도
            <select
              value={q.year}
              onChange={(e) => update({ year: e.target.value })}
            >
              <option value="">전체 연도</option>
              {[
                ...new Set(
                  s.dataset.items
                    .filter((v) => v.subjectId === q.subjectId)
                    .map((v) => v.source.year),
                ),
              ]
                .sort()
                .map((y) => (
                  <option key={y}>{y}</option>
                ))}
            </select>
          </label>
          <label className="field">
            회차
            <select
              value={q.round}
              onChange={(e) => update({ round: e.target.value })}
            >
              <option value="">전체 회차</option>
              {[
                ...new Set(
                  s.dataset.items
                    .filter((v) => v.subjectId === q.subjectId)
                    .map((v) => v.source.round),
                ),
              ].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="field">
            대상 필터
            <select
              value={q.filter}
              onChange={(e) =>
                update({ filter: e.target.value as Selection["filter"] })
              }
            >
              {Object.entries({
                all: "전체",
                unanswered: "미풀이 / 새 판단 재학습",
                incorrect: "오답",
                unknown: "모르겠음",
                marked: "다시 보기",
              }).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            출제 모드
            <select
              value={q.mode}
              onChange={(e) =>
                update({ mode: e.target.value as Selection["mode"] })
              }
            >
              <option value="cycle">전체 지문 순회</option>
              <option value="balanced">단원 균형 학습</option>
              <option value="weak">취약 지문 복습</option>
            </select>
          </label>
          <label className="field">
            순서
            <select
              value={q.order}
              onChange={(e) =>
                update({ order: e.target.value as Selection["order"] })
              }
            >
              <option value="ordered">순서대로</option>
              <option value="random">무작위</option>
            </select>
          </label>
          <label className="field">
            분량
            <select
              value={q.limit}
              onChange={(e) =>
                update({ limit: Number(e.target.value) as Selection["limit"] })
              }
            >
              {[10, 20, 30, 0].map((n) => (
                <option value={n} key={n}>
                  {n || "전체"}
                  {n ? "개" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <section className="start-panel">
        <span>이번에 풀 지문</span>
        <strong className="count">
          {plan.items.length}
          <small>개</small>
        </strong>
        <p>조건에 맞는 검증 지문 {candidates(s, q).length}개</p>
        {plan.updated && (
          <p role="status">후보가 달라져 순회 목록을 갱신합니다.</p>
        )}
        {plan.complete ? (
          <>
            <p>1회독 완료! 새 순회를 시작할 수 있습니다.</p>
            <button disabled={busy} onClick={onRestart}>
              새 순회 시작
            </button>
          </>
        ) : (
          <>
            <button
              className="primary"
              disabled={busy || (!plan.items.length && !active)}
              onClick={onBegin}
            >
              {active ? "진행 중 세션 이어 풀기" : "학습 시작"}
            </button>
            {!plan.items.length && (
              <p>이 조건에서 출제 가능한 지문이 없습니다.</p>
            )}
          </>
        )}
      </section>
    </>
  );
}

function Quiz({
  state: s,
  session,
  busy,
  onSubmit,
  onMark,
  onNext,
  onEnd,
}: {
  state: State;
  session: Session;
  busy: boolean;
  onSubmit: (r: "O" | "X" | "unknown") => void;
  onMark: () => void;
  onNext: () => void;
  onEnd: () => void;
}) {
  const v = session.items[session.index],
    b = session.selection.basis,
    j = v.judgments[b],
    a = s.attempts.find((x) => x.sessionId === session.id && x.itemId === v.id);
  const marked = !!s.marks[markKey(v.id, b)];
  return (
    <>
      <div className="quiz-meta">
        <span>
          {subjects[v.subjectId]} · {labels[b]}
        </span>
        <strong>
          {session.index + 1} / {session.items.length}
        </strong>
      </div>
      <progress
        aria-label="학습 진행"
        value={session.index + (session.revealed ? 1 : 0)}
        max={session.items.length}
      />
      <div className="quiz-heading">
        <p>
          {s.dataset.taxonomies.find((n) => n.id === v.primaryUnitId)?.label ??
            "분류 보류"}
        </p>
        <button aria-pressed={marked} disabled={busy} onClick={onMark}>
          {marked ? "★ 다시 보기 해제" : "☆ 다시 보기"}
        </button>
      </div>
      <section className="question" aria-label="문제">
        <span className="eyebrow">
          QUESTION {String(session.index + 1).padStart(2, "0")}
        </span>
        {v.contextText && <p className="context">{v.contextText}</p>}
        <h1 className="statement">{v.displayText}</h1>
      </section>
      {!session.revealed ? (
        <div className="answers">
          <button
            disabled={busy}
            className="answer-o"
            onClick={() => onSubmit("O")}
          >
            <strong>O</strong>맞다
          </button>
          <button
            disabled={busy}
            className="answer-x"
            onClick={() => onSubmit("X")}
          >
            <strong>X</strong>틀리다
          </button>
          <button
            disabled={busy}
            className="unknown"
            onClick={() => onSubmit("unknown")}
          >
            모르겠음
          </button>
        </div>
      ) : (
        <section className="feedback" aria-live="polite">
          <span className="result-badge">
            {a?.result === "correct"
              ? "✓ 정답"
              : a?.result === "unknown"
                ? "? 모르겠음"
                : "✕ 오답"}
          </span>
          <h2>정답 {j.answer}</h2>
          {j.answer === "X" ? (
            j.corrections.map((c, i) => (
              <div className="correction" key={i}>
                <div>
                  <small>틀린 표현</small>
                  <p>{c.wrong}</p>
                </div>
                <span aria-hidden="true">→</span>
                <div>
                  <small>올바른 표현</small>
                  <p>{c.correct}</p>
                </div>
              </div>
            ))
          ) : (
            <p>
              <strong>핵심 조건·범위</strong>
              <br />
              {j.keyPoint}
            </p>
          )}
          <p>{j.shortReason}</p>
          <p className="muted">
            기준일 {j.asOfDate} · 검증일{" "}
            {j.verifiedAt ? new Date(j.verifiedAt).toLocaleString() : ""}
          </p>
          <details>
            <summary>근거 펼치기</summary>
            {j.evidence.map((e, i) => (
              <div key={i}>
                <h3>{e.title}</h3>
                <p>
                  {e.caseNumber} {e.decisionDate} {e.article}
                </p>
                {e.excerpt && <blockquote>{e.excerpt}</blockquote>}
                <p>
                  판례 문장 직접 대조:{" "}
                  {e.caseTextCompared ? "확인" : "미확인 / 해당 없음"}
                </p>
                {e.url && /^https?:\/\//i.test(e.url) && (
                  <a href={e.url} target="_blank" rel="noopener noreferrer">
                    근거 링크 열기 ↗
                  </a>
                )}
              </div>
            ))}
          </details>
          <p>
            출처: {v.source.examName} · {v.source.year} · {v.source.round} ·{" "}
            {v.source.questionNumber}번 {v.source.option} {v.source.fileRef}{" "}
            {v.source.page ? `${v.source.page}쪽` : ""}
          </p>
          <button className="primary wide" disabled={busy} onClick={onNext}>
            {session.index === session.items.length - 1
              ? "결과 보기"
              : "다음 문제 →"}
          </button>
        </section>
      )}
      <button className="text-button" disabled={busy} onClick={onEnd}>
        이번 세션 종료
      </button>
      <p className="muted">
        미응답 지문은 오답으로 기록하지 않습니다. 저장된 위치에서 이어 풀 수
        있습니다.
      </p>
    </>
  );
}
function Result({
  state: s,
  session,
  onClose,
  onRetry,
}: {
  state: State;
  session: Session;
  onClose: () => void;
  onRetry: () => void;
}) {
  const stats = summary(s.attempts.filter((a) => a.sessionId === session.id)),
    weakItems = sessionWeak(s, session);
  return (
    <>
      <div className="eyebrow">SESSION COMPLETE</div>
      <h1>오늘도 한 걸음 쌓았어요.</h1>
      <p>
        {labels[session.selection.basis]} · 응답 {stats.answered}/
        {session.items.length}개
      </p>
      <section className="result-panel">
        <span>이번 세션 정답률</span>
        <strong>{stats.rate}</strong>
        <div className="stats">
          <div>
            <strong>{stats.correct}</strong>
            <span>✓ 정답</span>
          </div>
          <div>
            <strong>{stats.incorrect}</strong>
            <span>✕ 오답</span>
          </div>
          <div>
            <strong>{stats.unknown}</strong>
            <span>? 모르겠음</span>
          </div>
        </div>
      </section>
      <section>
        <h2>다시 확인하면 좋을 지문</h2>
        <p>이번 세션의 오답·모르겠음·다시 보기 {weakItems.length}개</p>
        <button
          className="primary"
          disabled={!weakItems.length}
          onClick={onRetry}
        >
          이번 취약 지문 다시 풀기
        </button>
      </section>
      <button onClick={onClose}>학습 홈으로</button>
    </>
  );
}
