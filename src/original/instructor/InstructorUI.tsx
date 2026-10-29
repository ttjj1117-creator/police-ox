import { useEffect, useRef, useState } from "react";
import type { Asset, Namespace, Question } from "../model";
import { download } from "../../data/transfer";
import { errorMessage } from "../../domain/schema";
import {
  MAX_INSTRUCTOR_BYTES,
  resolveInstructorRecords,
  summarizeInstructorPackage,
  validateInstructorPackage,
  type InstructorPackage,
} from "./contract";
import { ReadingFlowText } from "../ReadingFlowText";
import "./instructor.css";

export interface InstructorLoadState {
  loading: boolean;
  error: string;
  reload: () => void;
}

type ResolvedRecord = Awaited<
  ReturnType<typeof resolveInstructorRecords>
>[number];

function LibraryNotice({ state }: { state: InstructorLoadState }) {
  if (state.error)
    return (
      <p role="alert">
        해설 자료를 읽지 못했습니다. {state.error}{" "}
        <button onClick={state.reload}>강사 해설 다시 불러오기</button>
      </p>
    );
  return state.loading ? <p role="status">강사 해설 불러오는 중…</p> : null;
}

export function InstructorManager({
  namespace,
  questions,
  assets,
  packages,
  blocked,
  loading,
  error,
  onImport,
  onReload,
  scopeKey = "",
  legacyPackageCount = 0,
}: {
  namespace: Namespace;
  questions: Question[];
  assets: Asset[];
  packages: InstructorPackage[];
  blocked: boolean;
  loading: boolean;
  error: string;
  onImport: (value: unknown) => Promise<unknown>;
  onReload: () => void;
  scopeKey?: string;
  legacyPackageCount?: number;
}) {
  const [preview, setPreview] = useState<InstructorPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const context = JSON.stringify([scopeKey, namespace]);
  const currentContext = useRef(context);
  const currentQuestions = useRef(questions);
  const currentAssets = useRef(assets);
  currentContext.current = context;
  currentQuestions.current = questions;
  currentAssets.current = assets;
  useEffect(() => {
    setPreview(null);
    setMessage("");
  }, [context, questions, assets]);
  const disabled = busy || blocked || loading || !!error;
  const summary = preview ? summarizeInstructorPackage(preview) : null;
  return (
    <section className="instructor-manager" aria-label="강사 해설 자료 관리">
      <h2>강사 해설 가져오기</h2>
      <p>
        문제를 푼 뒤 제공 자료의 원문을 확인합니다. 새 자료를 적용하면 이
        기기·현재 계정의 이전 등록 해설을 삭제하고 교체합니다. 문제·공식
        정답·학습 기록은 그대로 유지합니다.
      </p>
      <p className="original-muted">
        {namespace === "real" ? "실제 학습" : "시연"} 영역 전용입니다. 강사
        해설은 기기마다 따로 가져옵니다. 법률 검증 자료와 구분해 표시하며,
        자료에 없는 해설은 추가하지 않습니다.
      </p>
      {legacyPackageCount > 0 && (
        <p className="instructor-replacement-notice">
          이전 등록 해설 {legacyPackageCount}개 자료 묶음이 교체 대상입니다. 새
          자료 검사가 끝나고 저장에 성공할 때 삭제합니다.
        </p>
      )}
      {blocked && (
        <p role="status">
          진행 중 풀이를 종료한 뒤 해설을 가져오거나 내보낼 수 있습니다.
        </p>
      )}
      <LibraryNotice state={{ loading, error, reload: onReload }} />
      <label className="original-field">
        강사 해설 JSON 가져오기
        <input
          type="file"
          accept=".json,application/json"
          disabled={disabled}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            setPreview(null);
            setMessage("");
            if (!file) return;
            const captured = context;
            setBusy(true);
            try {
              if (file.size > MAX_INSTRUCTOR_BYTES)
                throw Error(
                  `강사 해설 파일은 ${MAX_INSTRUCTOR_BYTES / 1024 / 1024} MiB 이하여야 합니다.`,
                );
              const value = await validateInstructorPackage(
                JSON.parse(await file.text()),
                namespace,
                questions,
                assets,
              );
              if (
                currentContext.current === captured &&
                currentQuestions.current === questions &&
                currentAssets.current === assets
              )
                setPreview(value);
            } catch (err) {
              if (currentContext.current === captured)
                setMessage(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {message && (
        <p role="status" className="instructor-message">
          {message}
        </p>
      )}
      {preview && summary && (
        <div
          className="instructor-preview"
          aria-label="강사 해설 가져오기 미리보기"
        >
          <h3>가져올 자료</h3>
          <p>
            출처 {summary.documents}개 · {summary.questions}문항 · 연결 확인{" "}
            {summary.checkedQuestions}문항 · 보류 {summary.heldQuestions}문항
          </p>
          <p>
            원문 기록 {summary.records}개 · 표·이미지 {summary.assets}개 · 버전{" "}
            {preview.packageVersion}
          </p>
          <p>
            연결 확인 자료는 답 제출 후 바로 표시합니다. 보류 자료와 문항 버전이
            맞지 않는 자료의 본문은 표시하지 않습니다.
          </p>
          <div className="instructor-actions">
            <button
              disabled={disabled}
              onClick={async () => {
                if (disabled) return;
                const captured = context;
                setBusy(true);
                try {
                  await onImport(preview);
                  if (currentContext.current === captured) {
                    setPreview(null);
                    setMessage(
                      "강사 해설을 저장하고 이전 등록 해설을 교체했습니다. 문제·정답·학습 기록은 유지했습니다.",
                    );
                  }
                } catch (err) {
                  if (currentContext.current === captured)
                    setMessage(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              기존 해설을 교체하고 가져오기
            </button>
            <button disabled={busy} onClick={() => setPreview(null)}>
              가져오기 취소
            </button>
          </div>
        </div>
      )}
      {!packages.length && !loading && !error && (
        <p>등록된 강사 해설이 없습니다.</p>
      )}
      <ul className="instructor-package-list">
        {packages.map((p) => {
          const s = summarizeInstructorPackage(p);
          return (
            <li key={p.packageId}>
              <span>
                출처 {s.documents}개 · {s.questions}문항 · 버전{" "}
                {p.packageVersion}
              </span>{" "}
              <button
                disabled={busy || blocked}
                onClick={() => {
                  if (!blocked && !busy)
                    download(p, `${p.packageId}.instructor.json`);
                }}
              >
                강사 해설 내보내기
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function selectorLabel(
  selector: ResolvedRecord["record"]["scope"]["targets"][number]["selector"],
): string {
  if (selector.kind === "choice") return `${selector.number}번 선택지`;
  const area =
    selector.area === "body" ? "보기" : `${selector.choiceNumber}번 선택지`;
  return selector.kind === "entry"
    ? `${area} ${selector.label}`
    : `${area} 문장`;
}

function scopeLabel(record: ResolvedRecord["record"]): string {
  return record.scope.kind === "question"
    ? "문항 전체"
    : record.scope.targets.map((t) => selectorLabel(t.selector)).join(" · ");
}

function pageLabel(locations: ResolvedRecord["record"]["locations"]): string {
  const physical = [...new Set(locations.map((l) => l.page))].join(", ");
  const printed = [
    ...new Set(
      locations
        .map((l) => l.printedPage)
        .filter((p) => p !== null && p !== undefined),
    ),
  ].join(", ");
  return `원문 PDF ${physical}쪽${printed ? ` · 인쇄 ${printed}쪽` : ""}`;
}

function sourceLabel(document: ResolvedRecord["document"]): string {
  return document.sourceType === "ai_assisted_reference"
    ? "AI 활용 참고자료 원문"
    : "강사 해설 원문";
}

function RecordView({ row }: { row: ResolvedRecord }) {
  const { record, status, reason } = row;
  const judgmentOnly = record.blocks.every(
    (b) => b.type !== "text" || b.role === "source_judgment",
  );
  const statusLabel =
    status === "stale"
      ? "버전 불일치"
      : status === "hold"
        ? "연결 보류"
        : "연결 검토 중";
  return (
    <article className="instructor-record" data-instructor-status={status}>
      <h4>
        {scopeLabel(record)}
        {judgmentOnly && status === "checked" ? " · 정오 표시만 수록" : ""}
        {status !== "checked" ? ` · ${statusLabel}` : ""}
      </h4>
      {status !== "checked" ? (
        <p className="instructor-hold">
          {reason ||
            [...record.extraction.reasons, ...record.matching.reasons].join(
              " ",
            ) ||
            "자료와 현재 문항의 연결을 다시 확인해야 합니다."}{" "}
          확인될 때까지 해설 본문을 표시하지 않습니다.
        </p>
      ) : (
        <>
          {record.blocks.map((block, i) => {
            if (block.type === "text")
              return (
                <p
                  key={i}
                  className={
                    block.role === "source_judgment"
                      ? "instructor-source-judgment"
                      : "instructor-source-text"
                  }
                >
                  <ReadingFlowText text={block.text} flowJudgmentMarkers />
                </p>
              );
            const asset = row.package.assets.find(
              (a) => a.assetId === block.assetId,
            );
            return asset ? (
              <figure key={i} className="instructor-source-image">
                <img
                  src={`data:${asset.mimeType};base64,${asset.base64}`}
                  alt={block.alt || asset.alt || "해설 원문 표"}
                  loading="lazy"
                  decoding="async"
                />
                {block.alt && <figcaption>{block.alt}</figcaption>}
              </figure>
            ) : (
              <p key={i} role="alert">
                원문 이미지를 불러오지 못했습니다.
              </p>
            );
          })}
          {record.scope.targets.length > 0 && (
            <details className="instructor-targets">
              <summary>연결된 지문 확인</summary>
              {record.scope.targets.map((target, i) => (
                <blockquote key={i}>
                  <b>{selectorLabel(target.selector)}</b>
                  <br />
                  <ReadingFlowText text={target.expectedText} />
                </blockquote>
              ))}
            </details>
          )}
        </>
      )}
      <p className="instructor-source-location">
        {pageLabel(record.locations)}
      </p>
    </article>
  );
}

export function InstructorExplanationView({
  question,
  assets,
  packages,
  namespace,
  libraryState,
  canReveal,
}: {
  question: Question;
  assets: Asset[];
  packages: InstructorPackage[];
  namespace: Namespace;
  libraryState: InstructorLoadState;
  canReveal: boolean;
}) {
  const [result, setResult] = useState<{
    question: Question;
    assets: Asset[];
    packages: InstructorPackage[];
    namespace: Namespace;
    rows: ResolvedRecord[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    if (!canReveal || libraryState.loading || libraryState.error)
      return () => {
        live = false;
      };
    void resolveInstructorRecords(
      question,
      packages.filter((p) => p.dataKind === namespace),
      assets,
    )
      .then((rows) => {
        if (live) setResult({ question, assets, packages, namespace, rows });
      })
      .catch((err) => {
        if (live)
          setResult({
            question,
            assets,
            packages,
            namespace,
            rows: [],
            error: errorMessage(err),
          });
      });
    return () => {
      live = false;
    };
  }, [
    question,
    assets,
    packages,
    namespace,
    canReveal,
    libraryState.loading,
    libraryState.error,
  ]);
  if (!canReveal) return null;
  const current =
    result?.question === question &&
    result.assets === assets &&
    result.packages === packages &&
    result.namespace === namespace
      ? result
      : null;
  const groups = new Map<string, ResolvedRecord[]>();
  for (const row of current?.rows ?? []) {
    const key = `${row.package.packageId}:${row.document.documentId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return (
    <section
      className="instructor-explanation-panel"
      aria-label="강사 해설 원문"
    >
      <h2>해설 원문</h2>
      <LibraryNotice state={libraryState} />
      {!libraryState.loading && !libraryState.error && (
        <>
          {!current && <p role="status">이 문항의 해설 확인 중…</p>}
          {current?.error && <p role="alert">{current.error}</p>}
          {current && !current.error && current.rows.length === 0 && (
            <p>이 문항에 등록된 해설이 없습니다.</p>
          )}
          {[...groups.entries()].map(([key, rows]) => {
            const { document, package: pack } = rows[0];
            const coverage = pack.coverage?.find(
              (c) =>
                c.documentId === document.documentId &&
                c.questionId === question.id,
            );
            const missing = coverage?.missingNarrativeTargets ?? [];
            const judgmentOnly = coverage?.judgmentOnlyTargets ?? [];
            return (
              <section
                key={key}
                className="instructor-source"
                aria-label={sourceLabel(document)}
              >
                <header>
                  <p className="instructor-source-type">
                    {sourceLabel(document)}
                  </p>
                  <h3>
                    {[document.academy, document.instructor]
                      .filter(Boolean)
                      .join(" · ") ||
                      document.title ||
                      document.originalFileName}
                  </h3>
                  <p className="instructor-source-meta">
                    {document.title}
                    {document.edition ? ` · ${document.edition}` : ""}
                    {document.authoredDate
                      ? ` · 작성 ${document.authoredDate}`
                      : ""}
                  </p>
                  {document.sourceType === "ai_assisted_reference" &&
                    document.sourceGenerator && (
                      <p className="instructor-source-meta">
                        자료에 명시된 생성 도구: {document.sourceGenerator}
                      </p>
                    )}
                  <p className="instructor-source-meta">
                    현행 법률 검토 미실시 · 법률 기준일 미확인
                  </p>
                </header>
                {rows.map((row) => (
                  <RecordView key={row.record.id} row={row} />
                ))}
                {(missing.length > 0 || judgmentOnly.length > 0) && (
                  <p className="instructor-coverage-note">
                    {missing.length > 0 &&
                      `서술해설 미수록: ${missing.map((t) => selectorLabel(t.selector)).join(" · ")}. `}
                    {judgmentOnly.length > 0 &&
                      "정오 표시만 수록된 지문은 서술해설과 구분합니다."}
                  </p>
                )}
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
