import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  choicePointerAllowed,
  InkInputCoordinator,
  editInk,
  eraseInk,
  inkIdentityKey,
  inkWidth,
  isDrawingPointer,
  localInkPoint,
  redoInk,
  undoInk,
  type InkHistory,
  type InkIdentity,
  type InkMode,
  type InkPoint,
  type InkStroke,
} from "./model";
import { type InkSessionMemory } from "./memory";
import "./ink.css";
import { useQuizInput } from "./InputGuard";

interface InkContextValue {
  identityKey: string;
  mode: InkMode;
  setMode: (mode: InkMode) => void;
  drawing: boolean;
  claim: (token: string) => boolean;
  release: (token: string) => void;
  history: InkHistory;
  commit: (transform: (history: InkHistory) => InkHistory) => void;
  finishPending: () => void;
  registerFinish: (finish: () => void) => () => void;
  input: InkInputCoordinator;
}
const InkContext = createContext<InkContextValue | null>(null);
export const useInk = (): InkContextValue => {
  const context = useContext(InkContext);
  if (!context) throw new Error("InkSurface에는 InkProvider가 필요합니다.");
  return context;
};
export const useInkMode = (): InkMode => useContext(InkContext)?.mode ?? "pen";

export interface InkProviderProps extends InkIdentity {
  children: ReactNode;
  memory: InkSessionMemory;
}
/** The app owns memory across question/provider remounts, never across a page restart. */
export function InkProvider({
  children,
  memory,
  ...identity
}: InkProviderProps) {
  const identityKey = inkIdentityKey(identity);
  const entry = useMemo(() => memory.capture(identity), [memory, identityKey]);
  const [, setRevision] = useState(0);
  const policy = useQuizInput();
  const [fallbackMode, setFallbackMode] = useState<InkMode>("pen");
  const mode = policy?.mode ?? fallbackMode;
  const setMode = policy?.setMode ?? setFallbackMode;
  const finishers = useRef(new Set<() => void>());
  const [drawing, setDrawing] = useState(false);
  const active = useRef<string | null>(null);
  const fallbackInput = useRef(new InkInputCoordinator());
  const input = policy?.input ?? fallbackInput.current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const commit = useCallback(
    (transform: (value: InkHistory) => InkHistory) => {
      const before = entry.history;
      const after = entry.update(transform);
      if (mounted.current && after !== before)
        setRevision((revision) => revision + 1);
    },
    [entry],
  );
  const claim = useCallback((token: string) => {
    if (active.current) return false;
    active.current = token;
    setDrawing(true);
    return true;
  }, []);
  const release = useCallback((token: string) => {
    if (active.current !== token) return;
    active.current = null;
    if (mounted.current) setDrawing(false);
  }, []);
  const registerFinish = useCallback((finish: () => void) => {
    finishers.current.add(finish);
    return () => {
      finishers.current.delete(finish);
    };
  }, []);
  const finishPending = useCallback(() => {
    for (const finish of [...finishers.current]) finish();
  }, []);
  const context = useMemo<InkContextValue>(
    () => ({
      identityKey,
      mode,
      setMode,
      drawing,
      claim,
      release,
      history: entry.history,
      commit,
      finishPending,
      registerFinish,
      input,
    }),
    [
      identityKey,
      mode,
      setMode,
      drawing,
      claim,
      release,
      entry.history,
      commit,
      finishPending,
      registerFinish,
      input,
    ],
  );
  return <InkContext.Provider value={context}>{children}</InkContext.Provider>;
}

export function InkToolbar() {
  const ink = useInk();
  return (
    <section className="ink-tools" aria-label="문항 필기">
      <div className="ink-tool-row">
        <div className="ink-tool-buttons" role="group" aria-label="필기 도구">
          <button
            type="button"
            aria-pressed={ink.mode === "pen"}
            onClick={() => ink.setMode("pen")}
          >
            연필
          </button>
          <button
            type="button"
            aria-pressed={ink.mode === "eraser"}
            onClick={() => ink.setMode("eraser")}
          >
            지우개
          </button>
          <button
            type="button"
            disabled={ink.drawing || !ink.history.undo.length}
            onClick={() => ink.commit(undoInk)}
            aria-label="필기 실행 취소"
          >
            실행 취소
          </button>
          <button
            type="button"
            disabled={ink.drawing || !ink.history.redo.length}
            onClick={() => ink.commit(redoInk)}
            aria-label="필기 다시 실행"
          >
            다시 실행
          </button>
          <button
            type="button"
            disabled={ink.drawing || !ink.history.strokes.length}
            onClick={() => ink.commit((history) => editInk(history, []))}
          >
            현재 문항 필기 지우기
          </button>
        </div>
        <p className="ink-temporary-note">
          필기는 현재 학습 중에만 유지됩니다. 새로고침하거나 학습을 종료하면
          사라집니다.
        </p>
      </div>
    </section>
  );
}

const strokePath = (points: InkPoint[]) =>
  points.length
    ? `M${points.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" L")}${points.length === 1 ? " l0.01 0.01" : ""}`
    : "";
const strokePressure = (points: InkPoint[]) =>
  points.reduce((sum, point) => sum + point.pressure, 0) /
  Math.max(1, points.length);
/** Committed strokes are immutable, so unrelated tool updates reuse their drawing. */
const CompletedInkStroke = memo(function CompletedInkStroke({
  stroke,
  hidden,
}: {
  stroke: InkStroke;
  hidden: boolean;
}) {
  const drawing = useMemo(() => {
    const pressure = strokePressure(stroke.points);
    return {
      path: strokePath(stroke.points),
      opacity: 0.72 + pressure * 0.16,
      width: inkWidth(pressure),
    };
  }, [stroke]);
  return (
    <g data-ink-stroke={stroke.id} visibility={hidden ? "hidden" : undefined}>
      <path
        d={drawing.path}
        fill="none"
        stroke="#454747"
        strokeOpacity={drawing.opacity}
        strokeWidth={drawing.width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
});
interface Gesture {
  pointerId: number;
  token: string;
  mode: "pen" | "eraser";
  points: InkPoint[];
  strokes: InkStroke[];
  base: InkStroke[];
  commit: InkContextValue["commit"];
  release: InkContextValue["release"];
  input: InkInputCoordinator;
}
export function InkSurface({
  surfaceId,
  children,
}: {
  surfaceId: string;
  children: ReactNode;
}) {
  const ink = useInk();
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const draft = useRef<SVGPathElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const paint = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const current = gesture.current;
      if (!current) return;
      if (current.mode === "pen") {
        draft.current?.setAttribute("d", strokePath(current.points));
        draft.current?.setAttribute(
          "stroke-width",
          String(inkWidth(strokePressure(current.points))),
        );
      } else {
        const remaining = new Set(current.strokes.map((stroke) => stroke.id));
        setHidden(
          new Set(
            current.base
              .filter((stroke) => !remaining.has(stroke.id))
              .map((stroke) => stroke.id),
          ),
        );
      }
    });
  }, []);
  const finish = useCallback(() => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    current.input.markInkGesture();
    cancelAnimationFrame(frame.current);
    draft.current?.setAttribute("d", "");
    setHidden(new Set());
    if (current.mode === "pen" && current.points.length) {
      const stroke: InkStroke = {
        id: crypto.randomUUID(),
        surfaceId,
        points: current.points,
      };
      current.commit((history) =>
        editInk(history, [...history.strokes, stroke]),
      );
    } else if (current.mode === "eraser" && current.strokes !== current.base) {
      const removed = new Set(
        current.base
          .filter(
            (stroke) =>
              !current.strokes.some((remaining) => remaining.id === stroke.id),
          )
          .map((stroke) => stroke.id),
      );
      current.commit((history) =>
        editInk(
          history,
          history.strokes.filter((stroke) => !removed.has(stroke.id)),
        ),
      );
    }
    current.release(current.token);
    // Completing a memory stroke (tool/navigation/exit) is not a physical
    // pen-up. Keep its contact/capture until the real up/cancel; the session
    // input guard owns physical release and still blocks palms in between.
  }, [surfaceId]);
  // Finish the previous target with the callback captured at pointerdown. A
  // provider identity change can never put its final point into the new target.
  useLayoutEffect(() => {
    finish();
  }, [ink.identityKey, ink.mode, finish]);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") finish();
    };
    window.addEventListener("blur", finish);
    window.addEventListener("pagehide", finish);
    document.addEventListener("visibilitychange", hide);
    return () => {
      finish();
      window.removeEventListener("blur", finish);
      window.removeEventListener("pagehide", finish);
      document.removeEventListener("visibilitychange", hide);
      cancelAnimationFrame(frame.current);
    };
  }, [finish]);
  useEffect(() => ink.registerFinish(finish), [ink.registerFinish, finish]);
  const append = (event: PointerEvent) => {
    const current = gesture.current,
      element = content.current;
    if (!current || current.pointerId !== event.pointerId || !element) return;
    const rect = element.getBoundingClientRect();
    let samples: PointerEvent[] = [];
    try {
      if (typeof event.getCoalescedEvents === "function")
        samples = event.getCoalescedEvents();
    } catch {
      /* unsupported browser */
    }
    if (!samples.length) samples = [event];
    for (const sample of samples) {
      const previous = current.points[current.points.length - 1];
      const next = localInkPoint(sample, rect, previous?.pressure ?? 0.5);
      if (
        previous &&
        Math.hypot(next.x - previous.x, next.y - previous.y) < 0.3
      )
        continue;
      if (current.mode === "eraser")
        current.strokes = eraseInk(
          current.strokes,
          surfaceId,
          previous ?? next,
          next,
        );
      current.points.push(next);
    }
    paint();
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDrawingPointer(event.pointerType)) return;
    if (
      event.target instanceof Element &&
      event.target.closest("button,a,input,select,textarea,summary")
    )
      return;
    event.stopPropagation();
    event.preventDefault();
    if (gesture.current || !content.current) return;
    const token = `${surfaceId}:${event.pointerId}`;
    if (!ink.claim(token)) return;
    ink.input.penDown(event.pointerId);
    const first = localInkPoint(event, content.current.getBoundingClientRect());
    gesture.current = {
      pointerId: event.pointerId,
      token,
      mode: ink.mode,
      points: [first],
      strokes: ink.history.strokes,
      base: ink.history.strokes,
      commit: ink.commit,
      release: ink.release,
      input: ink.input,
    };
    if (ink.mode === "eraser")
      gesture.current.strokes = eraseInk(
        ink.history.strokes,
        surfaceId,
        first,
        first,
      );
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* unsupported capture */
    }
    paint();
  };
  const strokes = useMemo(
    () =>
      ink.history.strokes.filter((stroke) => stroke.surfaceId === surfaceId),
    [ink.history.strokes, surfaceId],
  );
  return (
    <div
      ref={host}
      className="ink-surface"
      data-ink-surface={surfaceId}
      data-ink-mode={ink.mode}
      data-ink-ready="true"
      onPointerDown={down}
      onPointerMove={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.buttons === 0 && event.pressure === 0) finish();
        else append(event.nativeEvent);
      }}
      onPointerUp={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        append(event.nativeEvent);
        finish();
      }}
      onPointerCancel={(event) => {
        if (event.pointerType === "pen") ink.input.penUp(event.pointerId);
        if (gesture.current?.pointerId === event.pointerId) finish();
      }}
      onLostPointerCapture={(event) => {
        if (gesture.current?.pointerId === event.pointerId) finish();
      }}
      onPointerLeave={(event) => {
        const captured =
          typeof event.currentTarget.hasPointerCapture === "function" &&
          event.currentTarget.hasPointerCapture(event.pointerId);
        if (gesture.current?.pointerId === event.pointerId && !captured)
          finish();
      }}
      onClick={(event) => {
        if (
          (event.nativeEvent as MouseEvent & { pointerType?: string })
            .pointerType === "pen"
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="ink-content" ref={content}>
        {children}
      </div>
      <svg className="ink-layer" aria-hidden="true">
        {strokes.map((stroke) => (
          <CompletedInkStroke
            key={stroke.id}
            stroke={stroke}
            hidden={hidden.has(stroke.id)}
          />
        ))}
        <path
          ref={draft}
          className="ink-draft"
          fill="none"
          stroke="#454747"
          strokeOpacity="0.82"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      </svg>
    </div>
  );
}

/** Number controls exclude starting contacts from paper writing and reject drags. */
export function InkChoiceButton({
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ink = useInk();
  const pointer = useRef<{
    id: number;
    type: string;
    x: number;
    y: number;
    moved: boolean;
    cancelled: boolean;
    ended: boolean;
    blocked: boolean;
  } | null>(null);
  useEffect(() => {
    const reset = () => {
      if (pointer.current && !pointer.current.ended)
        pointer.current.cancelled = true;
    };
    const hide = () => {
      if (document.visibilityState === "hidden") reset();
    };
    window.addEventListener("blur", reset);
    window.addEventListener("pagehide", reset);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("pagehide", reset);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  return (
    <button
      {...props}
      className={[className, "ink-choice-button"].filter(Boolean).join(" ")}
      onPointerDown={(event) => {
        // A fresh contact replaces old per-button suppression immediately.
        pointer.current = {
          id: event.pointerId,
          type: event.pointerType,
          x: event.clientX,
          y: event.clientY,
          moved: false,
          cancelled: false,
          ended: false,
          blocked:
            event.pointerType === "touch" &&
            ink.input.touchBlocked(event.pointerId),
        };
        if (event.pointerType === "pen")
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* synthetic/unavailable capture */
          }
        if (pointer.current.blocked) {
          event.preventDefault();
          event.stopPropagation();
        }
        onPointerDown?.(event);
      }}
      onPointerMove={(event) => {
        const down = pointer.current;
        if (
          down?.id === event.pointerId &&
          Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 8
        )
          down.moved = true;
        onPointerMove?.(event);
      }}
      onPointerUp={(event) => {
        const down = pointer.current;
        if (down?.id === event.pointerId) {
          down.blocked ||=
            down.type === "touch" && ink.input.touchBlocked(down.id);
          down.ended = true;
          if (Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 8)
            down.moved = true;
          if (down.type === "pen") {
            const rect = event.currentTarget.getBoundingClientRect();
            down.cancelled ||=
              event.clientX < rect.left ||
              event.clientX >= rect.right ||
              event.clientY < rect.top ||
              event.clientY >= rect.bottom ||
              (event.nativeEvent.isTrusted &&
                document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest("button") !== event.currentTarget);
          }
          if (
            !choicePointerAllowed(
              down.type,
              down.moved,
              down.cancelled,
              down.blocked,
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }
        onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        if (pointer.current?.id === event.pointerId) {
          pointer.current.cancelled = true;
          pointer.current.ended = true;
        }
        onPointerCancel?.(event);
      }}
      onLostPointerCapture={(event) => {
        if (pointer.current?.id === event.pointerId && !pointer.current.ended)
          pointer.current.cancelled = true;
        onLostPointerCapture?.(event);
      }}
      onClick={(event) => {
        const native = event.nativeEvent as MouseEvent & {
          pointerType?: string;
          pointerId?: number;
        };
        const keyboard = event.detail === 0 && !native.pointerType;
        const saved = pointer.current;
        const down =
          saved &&
          (!native.pointerType || saved.type === native.pointerType) &&
          (!native.pointerId || saved.id === native.pointerId)
            ? saved
            : null;
        const type =
          native.pointerType ||
          (event.detail ? (down?.type ?? "mouse") : "keyboard");
        const blocked =
          type === "touch" &&
          (down?.blocked ||
            ink.input.touchBlocked(native.pointerId ?? down?.id));
        if (
          !keyboard &&
          !choicePointerAllowed(
            type,
            down?.moved ?? false,
            down?.cancelled ?? false,
            !!blocked,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        pointer.current = null;
        onClick?.(event);
      }}
    />
  );
}
