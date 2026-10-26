import { useEffect, useRef, useState } from "react";
import { useInk } from "./Ink";

export function QuizExitDialog({
  open,
  exam,
  sync,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  exam: boolean;
  sync: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const ink = useInk(),
    latest = useRef(ink);
  latest.current = ink;
  const cancelAction = useRef(onCancel);
  cancelAction.current = onCancel;
  const cancel = useRef<HTMLButtonElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    lock.current = false;
    setBusy(false);
    setError("");
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => cancel.current?.focus());
    void latest.current.flush().then((ok) => {
      if (!ok)
        setError(
          "필기가 아직 안전하게 저장되지 않았습니다. 저장을 다시 시도한 뒤 종료하세요.",
        );
    });
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!lock.current) cancelAction.current();
      }
      if (e.key !== "Tab") return;
      const items = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled])",
        ) ?? []),
      ];
      if (!items.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          !dialog.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !dialog.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keys);
      previous?.isConnected && previous.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="quiz-exit-backdrop">
      <div
        ref={dialog}
        className="quiz-exit-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="quiz-exit-title"
        aria-describedby="quiz-exit-description"
      >
        <h2 id="quiz-exit-title">
          {exam ? "시험을 제출할까요?" : "학습을 종료할까요?"}
        </h2>
        <p id="quiz-exit-description">
          {exam
            ? "미응답은 0점으로 확정되며 제출 후 답을 바꿀 수 없습니다. 확인 중에도 시험 시간은 계속 흐릅니다."
            : "저장한 답안과 필기는 보존합니다. 답하지 않은 문항은 자동 오답으로 기록하지 않습니다."}
          {sync ? " 종료 후 기기 동기화를 진행합니다." : ""}
        </p>
        {error && <p role="alert">{error}</p>}
        {error && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              latest.current.retry();
              if (await latest.current.flush()) setError("");
            }}
          >
            필기 저장 다시 시도
          </button>
        )}
        <div className="dialog-actions">
          <button ref={cancel} type="button" disabled={busy} onClick={onCancel}>
            취소 · 계속 풀기
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              setBusy(true);
              try {
                if (!(await latest.current.flush())) {
                  setError(
                    "필기를 저장하지 못했습니다. 저장을 다시 시도하거나 취소하세요.",
                  );
                  return;
                }
                await onConfirm();
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "종료를 저장하지 못했습니다.",
                );
              } finally {
                lock.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? "저장 중…" : exam ? "시험 제출 확정" : "학습 종료 확정"}
          </button>
        </div>
      </div>
    </div>
  );
}
