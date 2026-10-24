import { useEffect, useRef, useState, type ReactNode } from "react";
import "./tablet-reading.css";

export interface QuizMenuItem {
  label: string;
  onSelect: () => void;
}
export interface QuizChromeProps {
  subjectLabel: string;
  current: number;
  total: number;
  answered: number;
  mode: "study" | "round" | "exam";
  timeLabel?: string;
  expired?: boolean;
  busy?: boolean;
  answerSheetOpen: boolean;
  onToggleAnswers: () => void;
  menuItems: QuizMenuItem[];
  fontScale?: number;
  onFontScaleChange?: (scale: number) => void;
  readingFlow?: boolean;
  onReadingFlowChange?: (value: boolean) => void;
}
export function QuizChrome({
  subjectLabel,
  current,
  total,
  answered,
  mode,
  timeLabel,
  expired = false,
  busy = false,
  answerSheetOpen,
  onToggleAnswers,
  menuItems,
  fontScale = 1,
  onFontScaleChange,
  readingFlow = true,
  onReadingFlowChange,
}: QuizChromeProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const fontScales = [1, 1.25, 1.5, 2];
  const smaller = [...fontScales].reverse().find((scale) => scale < fontScale);
  const larger = fontScales.find((scale) => scale > fontScale);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [menuOpen]);
  return (
    <header className="quiz-reading-toolbar" aria-label="문제 풀이 도구">
      <div className="quiz-reading-position">
        <strong>{subjectLabel}</strong>
        <span>
          {mode === "exam"
            ? "실전 모의고사"
            : mode === "round"
              ? "회차별 풀이"
              : "원문 학습"}{" "}
          <b>
            {current}
            <span aria-hidden="true"> / </span>
            <span className="sr-only"> / </span>
            {total}
          </b>
        </span>
      </div>
      <div className="quiz-reading-tools">
        {onFontScaleChange && (
          <div
            className="quiz-font-controls"
            role="group"
            aria-label="글씨 크기"
          >
            <button
              type="button"
              aria-label="글씨 줄이기"
              disabled={busy || smaller === undefined}
              onClick={() =>
                smaller !== undefined && onFontScaleChange(smaller)
              }
            >
              글씨 −
            </button>
            <output aria-label="현재 글씨 크기">
              {Math.round(fontScale * 100)}%
            </output>
            <button
              type="button"
              aria-label="글씨 키우기"
              disabled={busy || larger === undefined}
              onClick={() => larger !== undefined && onFontScaleChange(larger)}
            >
              글씨 +
            </button>
          </div>
        )}
        {onReadingFlowChange && (
          <button
            type="button"
            className="quiz-flow-trigger"
            aria-label="줄바꿈 방식 전환"
            aria-pressed={readingFlow}
            disabled={busy}
            title="자동은 물리적 줄바꿈을 화면 폭에 맞춥니다. 원문은 원래 줄바꿈을 표시합니다."
            onClick={() => onReadingFlowChange(!readingFlow)}
          >
            줄바꿈 {readingFlow ? "자동" : "원문"}
          </button>
        )}
        {mode === "exam" && (
          <div
            className={`quiz-reading-time${expired ? " expired" : ""}`}
            role="timer"
            aria-label="남은 시간"
          >
            <span>남은 시간</span>
            <strong>{timeLabel ?? "—"}</strong>
          </div>
        )}
        <button
          type="button"
          className="quiz-answer-trigger"
          disabled={busy}
          aria-expanded={answerSheetOpen}
          aria-controls="quiz-answer-sheet"
          onClick={onToggleAnswers}
        >
          답안표 {answered}/{total}
        </button>
        <div className="quiz-reading-menu" ref={menuRoot}>
          <button
            type="button"
            ref={menuButton}
            disabled={busy}
            aria-expanded={menuOpen}
            aria-controls="quiz-reading-menu-items"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            메뉴
          </button>
          {menuOpen && (
            <nav id="quiz-reading-menu-items" aria-label="풀이 메뉴">
              {menuItems.map((item) => (
                <button
                  type="button"
                  disabled={busy}
                  key={item.label}
                  onClick={() => {
                    setMenuOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          )}
        </div>
      </div>
    </header>
  );
}

export interface QuizAnswerSheetProps {
  open: boolean;
  onClose: () => void;
  fontScale: number;
  children: ReactNode;
}
export function QuizAnswerSheet({
  open,
  onClose,
  children,
}: QuizAnswerSheetProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeButton.current?.focus());
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trap, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected && previousFocus.getClientRects().length)
        previousFocus.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <div
      id="quiz-answer-sheet"
      className="quiz-answer-shell"
      data-overlay="true"
      data-open={open ? "true" : "false"}
      hidden={!open}
      role="dialog"
      aria-modal={open ? true : undefined}
      aria-label="답안표"
      ref={dialog}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="quiz-answer-surface">
        <div className="quiz-answer-sheet-heading">
          <h2>답안표</h2>
          <button
            type="button"
            ref={closeButton}
            onClick={onClose}
            aria-label="답안표 닫기"
          >
            닫기 ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
