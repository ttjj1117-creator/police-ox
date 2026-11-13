import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../../domain/schema";
import type { Question } from "../model";
import { subjectLabels } from "../validation";
import {
  createReport,
  reportKinds,
  type QuestionReport,
  type ReportKind,
} from "./repository";
import "./reports.css";

type ReportChange = (
  previous: QuestionReport | undefined,
  next: QuestionReport | null,
) => Promise<void>;

export function ReportDialog({
  question,
  previous,
  onChange,
  onClose,
}: {
  question: Question;
  previous?: QuestionReport;
  onChange: ReportChange;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saving = useRef(false);
  const [base, setBase] = useState(previous);
  const [questionChecked, setQuestionChecked] = useState(
    previous?.kind === "question" || previous?.kind === "both",
  );
  const [explanationChecked, setExplanationChecked] = useState(
    previous?.kind === "explanation" || previous?.kind === "both",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current!;
    const previousFocus = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="original-report-dialog"
      aria-labelledby="original-report-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving.current) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving.current || (!questionChecked && !explanationChecked))
            return;
          const kind = questionChecked
            ? explanationChecked
              ? "both"
              : "question"
            : "explanation";
          saving.current = true;
          setBusy(true);
          setError("");
          try {
            await onChange(base, createReport(question, kind));
            onClose();
          } catch (error) {
            setError(errorMessage(error));
          } finally {
            saving.current = false;
            setBusy(false);
          }
        }}
      >
        <h2 id="original-report-title">오류 신고</h2>
        <p>의심되는 항목을 선택하면 이 브라우저의 신고 문항에 저장됩니다.</p>
        <fieldset disabled={busy}>
          <legend>오류 의심 항목</legend>
          <button
            type="button"
            role="checkbox"
            aria-checked={questionChecked}
            className="original-report-category"
            onClick={() => setQuestionChecked(!questionChecked)}
          >
            <span aria-hidden="true">{questionChecked ? "✓" : ""}</span>
            {reportKinds.question}
          </button>
          <button
            type="button"
            role="checkbox"
            aria-checked={explanationChecked}
            className="original-report-category"
            onClick={() => setExplanationChecked(!explanationChecked)}
          >
            <span aria-hidden="true">{explanationChecked ? "✓" : ""}</span>
            {reportKinds.explanation}
          </button>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {base?.changeId !== previous?.changeId && (
          <p role="alert">
            다른 탭의 변경 사항을 반영한 뒤 신고를 수정하세요.{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBase(previous);
                setQuestionChecked(
                  previous?.kind === "question" || previous?.kind === "both",
                );
                setExplanationChecked(
                  previous?.kind === "explanation" || previous?.kind === "both",
                );
                setError("");
              }}
            >
              최신 신고 불러오기
            </button>
          </p>
        )}
        <div className="original-report-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              busy ||
              base?.changeId !== previous?.changeId ||
              (!questionChecked && !explanationChecked)
            }
          >
            {busy ? "저장 중…" : "신고 저장"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function ReportReview({
  reports,
  loading,
  error,
  reload,
  change,
  examActive,
  renderQuestion,
}: {
  reports: QuestionReport[];
  loading: boolean;
  error: string;
  reload: () => void;
  change: ReportChange;
  examActive: boolean;
  renderQuestion: (report: QuestionReport) => ReactNode;
}) {
  const [kind, setKind] = useState<"all" | ReportKind>("all");
  const [status, setStatus] = useState("pending");
  const [opened, setOpened] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const matching = reports
    .filter(
      (report) =>
        (kind === "all" ||
          kind === report.kind ||
          (kind !== "both" && report.kind === "both")) &&
        (status === "all" || (status === "resolved") === report.resolved),
    )
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.questionId.localeCompare(b.questionId),
    );
  async function update(report: QuestionReport, remove = false) {
    setWriting(true);
    setSaveError("");
    setNotice("");
    try {
      await change(
        report,
        remove
          ? null
          : {
              ...report,
              resolved: !report.resolved,
              updatedAt: new Date().toISOString(),
              changeId: crypto.randomUUID(),
            },
      );
      if (remove || status !== "all") setOpened(null);
      setNotice(
        remove
          ? "신고를 삭제했습니다."
          : report.resolved
            ? "검토 대기로 옮겼습니다."
            : "검토 완료로 옮겼습니다.",
      );
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setWriting(false);
    }
  }
  return (
    <>
      <h1>신고 문항</h1>
      <p className="original-muted">
        이 브라우저에 저장한 문항을 분류별로 다시 검토할 수 있습니다.
      </p>
      {loading && <p role="status">신고 문항을 불러오는 중…</p>}
      {error && (
        <p role="alert">
          신고 문항을 불러오지 못했습니다. {error}{" "}
          <button type="button" onClick={reload}>
            다시 시도
          </button>
        </p>
      )}
      {saveError && <p role="alert">{saveError}</p>}
      {notice && (
        <p className="original-notice" role="status">
          {notice}
        </p>
      )}
      {examActive && (
        <p className="original-muted">
          모의고사 제출 후 문항과 해설을 열 수 있습니다.
        </p>
      )}
      <div className="original-report-filters">
        <label className="original-field">
          오류 유형
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as "all" | ReportKind)
            }
          >
            <option value="all">전체 유형</option>
            {Object.entries(reportKinds).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="original-field">
          검토 상태
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="pending">검토 대기</option>
            <option value="resolved">검토 완료</option>
            <option value="all">전체 상태</option>
          </select>
        </label>
      </div>
      {!loading && !error && (
        <p role="status" className="original-muted">
          {matching.length > 0
            ? `${matching.length}문항`
            : reports.length > 0
              ? "선택한 조건의 신고 문항이 없습니다."
              : "저장한 신고 문항이 없습니다. 풀이 화면에서 오류 신고를 눌러 문항을 추가할 수 있습니다."}
        </p>
      )}
      {matching.map((report) => {
        const expanded = !examActive && opened === report.questionId;
        return (
          <section key={report.questionId} className="original-report-entry">
            <h2>
              {subjectLabels[report.subjectId]} · {report.source.year}년{" "}
              {report.source.round}차 · 원문 {report.source.questionNumber}번
            </h2>
            <p className="original-muted">
              {reportKinds[report.kind]} ·{" "}
              {report.resolved ? "검토 완료" : "검토 대기"}
            </p>
            <div className="original-report-actions">
              <button
                type="button"
                disabled={examActive}
                aria-expanded={expanded}
                onClick={() => setOpened(expanded ? null : report.questionId)}
              >
                {expanded ? "문항 닫기" : "문항 보기"}
              </button>
              <button
                type="button"
                disabled={writing}
                onClick={() => void update(report)}
              >
                {report.resolved ? "검토 대기로" : "검토 완료로"}
              </button>
              <button
                type="button"
                disabled={writing}
                onClick={() => void update(report, true)}
              >
                신고 삭제
              </button>
            </div>
            {expanded && renderQuestion(report)}
          </section>
        );
      })}
    </>
  );
}
