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
}: QuizChromeProps) {
  const [menuOpen, setMenuOpen] = useState(false);
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
  fontScale,
  children,
}: QuizAnswerSheetProps) {
  const [wide, setWide] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1024px)").matches,
  );
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const overlay = !wide || fontScale >= 1.5;
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!overlay || !open) return;
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
  }, [overlay, open]);
  return (
    <div
      id="quiz-answer-sheet"
      className="quiz-answer-shell"
      data-overlay={overlay ? "true" : "false"}
      data-open={open ? "true" : "false"}
      hidden={overlay && !open}
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay && open ? true : undefined}
      aria-label={overlay ? "답안표" : undefined}
      ref={dialog}
      onClick={(event) => {
        if (overlay && event.target === event.currentTarget) onClose();
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
