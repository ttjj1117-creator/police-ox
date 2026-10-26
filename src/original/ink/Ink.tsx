import {
  createContext,
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
  emptyInkDocument,
  emptyInkHistory,
  eraseInk,
  inkIdentityKey,
  inkWidth,
  isDrawingPointer,
  localInkPoint,
  redoInk,
  undoInk,
  validInkDocument,
  type InkDocument,
  type InkHistory,
  type InkIdentity,
  type InkMode,
  type InkPoint,
  type InkStroke,
} from "./model";
import { InkRecoveryError, inkStore, type InkPersistence } from "./store";
import "./ink.css";
import { useQuizInput } from "./InputGuard";

type Measure = () => unknown;
interface InkContextValue {
  mode: InkMode;
  setMode: (mode: InkMode) => void;
  ready: boolean;
  drawing: boolean;
  claim: (token: string) => boolean;
  release: (token: string) => void;
  layoutKey: string;
  history: InkHistory;
  register: (id: string, measure: Measure) => () => void;
  measure: () => void;
  commit: (key: string, transform: (history: InkHistory) => InkHistory) => void;
  otherLayouts: boolean;
  legacyAvailable: boolean;
  status: string;
  error: boolean;
  retry: () => void;
  flush: () => Promise<boolean>;
  registerFinish: (finish: () => void) => () => void;
  input: InkInputCoordinator;
}
const InkContext = createContext<InkContextValue | null>(null);
export const useInk = (): InkContextValue => {
  const context = useContext(InkContext);
  if (!context) throw new Error("InkSurface에는 InkProvider가 필요합니다.");
  return context;
};
export const useInkMode = (): InkMode => useContext(InkContext)?.mode ?? "read";

// Native reading gestures are restored in read mode; pen mode is guarded upstream.
function useInkHost<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  return {
    ref,
    cancel: () => {},
    end: (_event: ReactPointerEvent<T>) => {},
    lost: (_event: ReactPointerEvent<T>) => {},
  };
}

export interface InkProviderProps extends InkIdentity {
  children: ReactNode;
  store?: InkPersistence;
}
/** Remount at owner/session/question boundaries; the key check also prevents a stale render if a caller forgets. */
export function InkProvider({
  children,
  store = inkStore,
  ...identity
}: InkProviderProps) {
  const identityKey = inkIdentityKey(identity);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const live = useRef<{ key: string; document: InkDocument }>({
    key: "",
    document: emptyInkDocument(identity),
  });
  const [revision, setRevision] = useState(0);
  const policy = useQuizInput();
  const [fallbackMode, setFallbackMode] = useState<InkMode>("read");
  const mode = policy?.mode ?? fallbackMode,
    setMode = policy?.setMode ?? setFallbackMode;
  const finishers = useRef(new Set<() => void>());
  const saving = useRef<Promise<void> | null>(null);
  const [layout, setLayout] = useState({ identityKey: "", key: "" });
  const [loadError, setLoadError] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const active = useRef<string | null>(null);
  const input = useRef(new InkInputCoordinator());
  const mounted = useRef(true);
  const surfaces = useRef(new Map<string, Measure>());
  const layoutFrame = useRef(0);
  const saveSequence = useRef(0);
  const ready = live.current.key === identityKey;
  const layoutKey = layout.identityKey === identityKey ? layout.key : "";
  const history =
    ready && layoutKey
      ? (live.current.document.layouts[layoutKey] ?? emptyInkHistory())
      : emptyInkHistory();

  const measure = useCallback(() => {
    cancelAnimationFrame(layoutFrame.current);
    layoutFrame.current = requestAnimationFrame(() => {
      if (!mounted.current) return;
      const measurements = [...surfaces.current]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, read]) => [id, read()]);
      // Exact layout signatures, rather than scaled coordinates or a collision-prone hash.
      const key =
        measurements.length && measurements.every(([, value]) => value !== null)
          ? JSON.stringify(measurements)
          : "";
      setLayout({ identityKey, key });
    });
  }, [identityKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimationFrame(layoutFrame.current);
    };
  }, []);
  useEffect(() => {
    let current = true;
    live.current = { key: "", document: emptyInkDocument(identityRef.current) };
    setLoadError(false);
    setSaveState("idle");

    setDrawing(false);
    active.current = null;
    void store
      .read(identityRef.current)
      .then((document) => {
        if (!current) return;
        live.current = {
          key: identityKey,
          document: document ?? emptyInkDocument(identityRef.current),
        };
        setRevision((n) => n + 1);
        measure();
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (
          error instanceof InkRecoveryError &&
          validInkDocument(error.document, identityRef.current)
        ) {
          live.current = { key: identityKey, document: error.document };
          setSaveState("error");
          setRevision((n) => n + 1);
          measure();
        } else setLoadError(true);
      });
    return () => {
      current = false;
    };
  }, [identityKey, store, loadAttempt, measure]);
  useEffect(() => {
    const routing = input.current;
    const start = (event: PointerEvent) => {
      const scoped =
        event.target instanceof Element &&
        !!event.target.closest(
          ".original-quiz-grid,.ink-tools,.quiz-reading-toolbar",
        );
      if (!scoped && !routing.hasContacts) return;
      if (event.pointerType === "pen") routing.penDown(event.pointerId);
      else if (event.pointerType === "touch")
        routing.touchDown(event.pointerId);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerType === "pen") routing.penUp(event.pointerId);
      else if (event.pointerType === "touch") routing.touchUp(event.pointerId);
    };
    const reset = () => routing.reset();
    const hide = () => {
      if (document.visibilityState === "hidden") reset();
    };
    document.addEventListener("pointerdown", start, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointerup", end, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointercancel", end, {
      capture: true,
      passive: true,
    });
    window.addEventListener("blur", reset);
    window.addEventListener("pagehide", reset);
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("pointerdown", start, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pagehide", reset);
      document.removeEventListener("visibilitychange", hide);
      reset();
    };
  }, [identityKey]);

  const persist = useCallback(
    (document: InkDocument) => {
      const capturedKey = inkIdentityKey(document.identity);
      const sequence = ++saveSequence.current;
      if (mounted.current) setSaveState("saving");
      // The store registers every pending commit synchronously across provider remounts.
      const pending = store.write(document);
      saving.current = pending;
      void pending
        .then(() => {
          if (
            mounted.current &&
            live.current.key === capturedKey &&
            saveSequence.current === sequence
          )
            setSaveState("saved");
        })
        .catch(() => {
          if (
            mounted.current &&
            live.current.key === capturedKey &&
            saveSequence.current === sequence
          )
            setSaveState("error");
        });
    },
    [store],
  );
  const commit = useCallback(
    (key: string, transform: (value: InkHistory) => InkHistory) => {
      // Key and identity are captured at pointerdown. Navigation can never write to the next question.
      if (!key || live.current.key !== identityKey) return;
      const document = live.current.document;
      const before = document.layouts[key] ?? emptyInkHistory();
      const after = transform(before);
      if (after === before) return;
      const next = {
        ...document,
        layouts: { ...document.layouts, [key]: after },
      };
      live.current = { key: identityKey, document: next };
      if (mounted.current) setRevision((n) => n + 1);
      persist(next);
    },
    [identityKey, persist],
  );
  const register = useCallback(
    (id: string, read: Measure) => {
      surfaces.current.set(id, read);
      measure();
      return () => {
        if (surfaces.current.get(id) === read) surfaces.current.delete(id);
        measure();
      };
    },
    [measure],
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
  const retry = useCallback(() => {
    if (live.current.key !== identityKey) setLoadAttempt((n) => n + 1);
    else persist(live.current.document);
  }, [identityKey, persist]);
  const registerFinish = useCallback((finish: () => void) => {
    finishers.current.add(finish);
    return () => {
      finishers.current.delete(finish);
    };
  }, []);
  const flush = useCallback(async () => {
    for (const finish of finishers.current) finish();
    if (live.current.key !== identityKey) return false;
    try {
      await saving.current;
      return true;
    } catch {
      return false;
    }
  }, [identityKey]);
  const context = useMemo<InkContextValue>(
    () => ({
      mode,
      flush,
      registerFinish,
      input: input.current,
      setMode,
      ready,
      drawing,
      claim,
      release,
      layoutKey,
      history,
      register,
      measure,
      commit,
      otherLayouts:
        ready &&
        Object.entries(live.current.document.layouts).some(
          ([key, value]) => key !== layoutKey && value.strokes.length > 0,
        ),
      legacyAvailable:
        ready &&
        Object.values(live.current.document.layouts).some((h) =>
          [h.strokes, ...h.undo, ...h.redo].some((strokes) =>
            strokes.some((s) => s.surfaceId !== "paper"),
          ),
        ),
      status: loadError
        ? "필기를 불러오지 못했습니다. 기존 필기는 보존됩니다."
        : !ready
          ? "필기 불러오는 중…"
          : saveState === "saving"
            ? "필기 저장 중…"
            : saveState === "saved"
              ? "필기 이 기기에 저장됨"
              : saveState === "error"
                ? "필기를 저장하지 못했습니다. 현재 앱에서만 임시 보관합니다. 닫기 전에 다시 시도하세요."
                : "필기 · 이 기기에 저장",
      error: loadError || saveState === "error",
      retry,
      // revision only updates this small question context after load, stroke or toolbar actions.
    }),
    [
      mode,
      ready,
      drawing,
      claim,
      release,
      layoutKey,
      layout,
      history,
      register,
      measure,
      commit,
      loadError,
      saveState,
      retry,
      revision,
      flush,
      registerFinish,
      setMode,
    ],
  );
  return <InkContext.Provider value={context}>{children}</InkContext.Provider>;
}

export function InkToolbar({
  legacy = false,
  onToggleLegacy,
}: {
  legacy?: boolean;
  onToggleLegacy?: () => void;
}) {
  const ink = useInk();
  const disabled = !ink.ready || !ink.layoutKey || ink.drawing || legacy;
  return (
    <section className="ink-tools" aria-label="문항 필기">
      <div className="ink-tool-row">
        <div className="ink-tool-buttons" role="group" aria-label="필기 도구">
          <button
            type="button"
            aria-pressed={ink.mode === "read"}
            onClick={() => ink.setMode("read")}
          >
            이동·읽기
          </button>
          <button
            type="button"
            disabled={!ink.ready || legacy}
            aria-pressed={ink.mode === "pen"}
            onClick={() => ink.setMode("pen")}
          >
            연필
          </button>
          <button
            type="button"
            disabled={!ink.ready || legacy}
            aria-pressed={ink.mode === "eraser"}
            onClick={() => ink.setMode("eraser")}
          >
            지우개
          </button>
          <button
            type="button"
            disabled={disabled || !ink.history.undo.length}
            onClick={() => ink.commit(ink.layoutKey, undoInk)}
            aria-label="필기 실행 취소"
          >
            실행 취소
          </button>
          <button
            type="button"
            disabled={disabled || !ink.history.redo.length}
            onClick={() => ink.commit(ink.layoutKey, redoInk)}
            aria-label="필기 다시 실행"
          >
            다시 실행
          </button>
          <button
            type="button"
            disabled={disabled || !ink.history.strokes.length}
            onClick={() => ink.commit(ink.layoutKey, (h) => editInk(h, []))}
          >
            현재 문항 필기 지우기
          </button>
        </div>
        {onToggleLegacy && (legacy || ink.legacyAvailable) && (
          <button type="button" onClick={onToggleLegacy}>
            {legacy ? "연속 필기로 돌아가기" : "이전 필기 배치 보기"}
          </button>
        )}
        <div
          className="ink-tool-state"
          data-error={ink.error ? "true" : "false"}
        >
          <span role={ink.error ? "alert" : "status"}>{ink.status}</span>
          <span className="ink-mode-hint">
            {ink.mode === "read"
              ? "이동·읽기 · 손 터치 사용"
              : "펜 전용 · 손 터치 잠금"}
          </span>
          {legacy && (
            <span>
              이전 필기 보관 보기 · 읽기 전용. 같은 화면 폭·글씨·줄바꿈에서
              복원합니다.
            </span>
          )}
          {ink.error && (
            <button type="button" onClick={ink.retry}>
              필기 저장 다시 시도
            </button>
          )}
        </div>
        <details
          className="ink-instructions"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary>
            필기 안내 <span aria-hidden="true">▾</span>
          </summary>
          <div className="ink-instructions-panel">
            <p>
              이동·읽기에서는 손가락으로 이동·확대·번호 선택을 합니다.
              연필·지우개에서는 펜만 사용할 수 있고 학습 화면의 손 터치를
              잠급니다.
            </p>
            <p>
              필기는 이 기기에 저장합니다. 일반 백업·기기 동기화에는 포함되지
              않습니다.
            </p>
            <p>
              펜이 인식되지 않으면 왼쪽의 터치 잠금 해제를 1.2초 누르세요.
              브라우저·운영체제의 터치를 끄는 기능은 아닙니다.
            </p>
            <p>
              글씨 크기나 화면 배치가 바뀌면 기존 필기는 별도로 보관하며, 원래
              배치로 돌아오면 다시 표시합니다.
            </p>
          </div>
        </details>
      </div>
      {ink.otherLayouts && (
        <p className="ink-layout-notice" role="status">
          다른 글씨 크기·화면 배치의 필기가 보관되어 있습니다.
        </p>
      )}
    </section>
  );
}

const rounded = (value: number) => Math.round(value * 10) / 10;
function layoutMeasurement(element: HTMLElement): unknown {
  const rect = element.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    document.fonts?.status === "loading"
  )
    return null;
  const nodes = [
    element,
    ...element.querySelectorAll<HTMLElement>(
      ".original-content,.original-statements p,img,table",
    ),
  ];
  return nodes.map((node) => {
    const box = node.getBoundingClientRect(),
      style = getComputedStyle(node);
    const fragments: number[][] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    // A font swap can change line breaks even when the outside box stays equal.
    // Store fragment geometry, never the base64 contents of image sources.
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (!text.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const part of range.getClientRects())
        fragments.push([
          rounded(part.left - rect.left),
          rounded(part.top - rect.top),
          rounded(part.width),
          rounded(part.height),
        ]);
    }
    return {
      width: rounded(box.width),
      height: rounded(box.height),
      x: rounded(box.left - rect.left),
      y: rounded(box.top - rect.top),
      font: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      line: style.lineHeight,
      spacing: style.letterSpacing,
      whiteSpace: style.whiteSpace,
      wordBreak: style.wordBreak,
      text: node.textContent,
      fragments,
      image:
        node instanceof HTMLImageElement
          ? [node.alt, node.naturalWidth, node.naturalHeight]
          : undefined,
    };
  });
}
const strokePath = (points: InkPoint[]) =>
  points.length
    ? `M${points.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L")}${points.length === 1 ? " l0.01 0.01" : ""}`
    : "";
const strokePressure = (points: InkPoint[]) =>
  points.reduce((sum, p) => sum + p.pressure, 0) / Math.max(1, points.length);
interface Gesture {
  pointerId: number;
  token: string;
  mode: "pen" | "eraser";
  layoutKey: string;
  points: InkPoint[];
  strokes: InkStroke[];
  base: InkStroke[];
}
export function InkSurface({
  surfaceId,
  children,
  readOnly = false,
}: {
  surfaceId: string;
  children: ReactNode;
  readOnly?: boolean;
}) {
  const ink = useInk();
  const fingerPan = useInkHost<HTMLDivElement>();
  const content = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGSVGElement>(null);
  const draft = useRef<SVGPathElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const lastGeometry = useRef("");
  const latest = useRef(ink);
  latest.current = ink;
  const checkGeometry = useCallback(() => {
    const element = content.current;
    if (!element) return;
    const next = JSON.stringify(layoutMeasurement(element));
    if (next !== lastGeometry.current) {
      // Hide synchronously before a resize/font reflow paints old coordinates.
      layer.current?.setAttribute("data-layout-pending", "true");
      latest.current.measure();
    }
  }, []);
  useLayoutEffect(() => {
    checkGeometry();
    if (
      content.current &&
      JSON.stringify(layoutMeasurement(content.current)) ===
        lastGeometry.current &&
      ink.layoutKey
    ) {
      layer.current?.removeAttribute("data-layout-pending");
    }
  });

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
    latest.current.input.markInkGesture();
    cancelAnimationFrame(frame.current);
    draft.current?.setAttribute("d", "");
    setHidden(new Set());
    if (current.mode === "pen" && current.points.length) {
      const stroke: InkStroke = {
        id: crypto.randomUUID(),
        surfaceId,
        points: current.points,
      };
      latest.current.commit(current.layoutKey, (history) =>
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
      latest.current.commit(current.layoutKey, (history) =>
        editInk(
          history,
          history.strokes.filter((stroke) => !removed.has(stroke.id)),
        ),
      );
    }
    latest.current.release(current.token);
    try {
      if (fingerPan.ref.current?.hasPointerCapture(current.pointerId))
        fingerPan.ref.current.releasePointerCapture(current.pointerId);
    } catch {
      /* cancelled or detached pointer */
    }
  }, [surfaceId]);

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const unregister = ink.register(surfaceId, () => {
      const measured = layoutMeasurement(element);
      lastGeometry.current = JSON.stringify(measured);
      return measured;
    });
    const observer = new ResizeObserver(checkGeometry);
    observer.observe(element);
    element.addEventListener("load", checkGeometry, true);
    document.fonts?.addEventListener("loading", checkGeometry);
    document.fonts?.addEventListener("loadingdone", checkGeometry);
    document.fonts?.addEventListener("loadingerror", checkGeometry);
    void document.fonts?.ready.then(checkGeometry);
    return () => {
      finish();
      unregister();
      observer.disconnect();
      element.removeEventListener("load", checkGeometry, true);
      document.fonts?.removeEventListener("loading", checkGeometry);
      document.fonts?.removeEventListener("loadingdone", checkGeometry);
      document.fonts?.removeEventListener("loadingerror", checkGeometry);
      cancelAnimationFrame(frame.current);
    };
  }, [surfaceId, ink.register, ink.measure, finish, checkGeometry]);
  useEffect(() => {
    finish();
  }, [ink.layoutKey, ink.mode, finish]);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") finish();
    };
    window.addEventListener("blur", finish);
    window.addEventListener("pagehide", finish);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", finish);
      window.removeEventListener("pagehide", finish);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [finish]);

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
    if (event.pointerType === "touch") return;
    if (!isDrawingPointer(event.pointerType) || ink.mode === "read" || readOnly)
      return;
    if (
      event.target instanceof Element &&
      event.target.closest("button,a,input,select,textarea,summary")
    )
      return;
    event.stopPropagation();
    event.preventDefault();
    if (
      !isDrawingPointer(event.pointerType) ||
      !ink.ready ||
      !ink.layoutKey ||
      gesture.current ||
      !content.current
    )
      return;
    const token = `${surfaceId}:${event.pointerId}`;
    if (!ink.claim(token)) return;
    const first = localInkPoint(event, content.current.getBoundingClientRect());
    gesture.current = {
      pointerId: event.pointerId,
      token,
      mode: ink.mode,
      layoutKey: ink.layoutKey,
      points: [first],
      strokes: ink.history.strokes,
      base: ink.history.strokes,
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
      /* synthetic/unsupported capture; leaving ends the stroke */
    }
    paint();
  };
  useEffect(() => ink.registerFinish(finish), [ink.registerFinish, finish]);
  const strokes = ink.history.strokes.filter(
    (stroke) => stroke.surfaceId === surfaceId,
  );
  return (
    <div
      ref={fingerPan.ref}
      className="ink-surface"
      data-ink-surface={surfaceId}
      data-ink-mode={ink.mode}
      data-ink-ready={ink.ready && !!ink.layoutKey ? "true" : "false"}
      onPointerDown={down}
      onPointerMove={(event) => {
        if (event.pointerType === "touch") return;
        if (gesture.current?.pointerId === event.pointerId) {
          event.preventDefault();
          event.stopPropagation();
          if (event.buttons === 0 && event.pressure === 0) finish();
          else append(event.nativeEvent);
        }
      }}
      onPointerUp={(event) => {
        if (event.pointerType === "touch") return;
        if (gesture.current?.pointerId === event.pointerId) {
          event.preventDefault();
          event.stopPropagation();
          append(event.nativeEvent);
          finish();
        }
      }}
      onPointerCancel={(event) => {
        fingerPan.end(event);
        if (event.pointerType === "pen") ink.input.penUp(event.pointerId);
        if (gesture.current?.pointerId === event.pointerId) finish();
      }}
      onLostPointerCapture={(event) => {
        fingerPan.lost(event);
        if (event.pointerType === "pen") ink.input.penUp(event.pointerId);
        if (gesture.current?.pointerId === event.pointerId) finish();
      }}
      onPointerLeave={(event) => {
        const captured =
          typeof event.currentTarget.hasPointerCapture === "function" &&
          event.currentTarget.hasPointerCapture(event.pointerId);
        if (gesture.current?.pointerId === event.pointerId && !captured) {
          ink.input.penUp(event.pointerId);
          finish();
        }
        if (event.pointerType === "touch" && !captured) fingerPan.cancel();
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
      <svg ref={layer} className="ink-layer" aria-hidden="true">
        {strokes.map((stroke) => (
          <g
            key={stroke.id}
            data-ink-stroke={stroke.id}
            visibility={hidden.has(stroke.id) ? "hidden" : undefined}
          >
            <path
              d={strokePath(stroke.points)}
              fill="none"
              stroke="#454747"
              strokeOpacity={0.72 + strokePressure(stroke.points) * 0.16}
              strokeWidth={inkWidth(strokePressure(stroke.points))}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
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

/** Number controls exclude their starting contacts from paper writing. */
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
  const fingerPan = useInkHost<HTMLButtonElement>();
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
  const suppress = useRef(0);
  useEffect(() => {
    const reset = () => {
      if (pointer.current && !pointer.current.ended) {
        pointer.current.cancelled = true;
        suppress.current = Date.now() + 1000;
      }
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
      ref={fingerPan.ref}
      className={[className, "ink-choice-button"].filter(Boolean).join(" ")}
      onPointerDown={(event) => {
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
        if (event.pointerType === "pen") {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* synthetic events or unavailable capture */
          }
        }
        if (
          !choicePointerAllowed(
            event.pointerType,
            false,
            false,
            pointer.current.blocked,
          )
        ) {
          suppress.current = Date.now() + 1000;
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
        ) {
          down.moved = true;
          suppress.current = Date.now() + 1000;
        }
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
          if (
            !choicePointerAllowed(
              down.type,
              down.moved,
              down.cancelled,
              down.blocked,
            )
          ) {
            suppress.current = Date.now() + 1000;
            event.preventDefault();
            event.stopPropagation();
          } else suppress.current = 0;
        }
        fingerPan.end(event);
        onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        fingerPan.end(event);
        if (event.pointerType === "pen") ink.input.penUp(event.pointerId);
        if (pointer.current?.id === event.pointerId) {
          pointer.current.cancelled = true;
          suppress.current = Date.now() + 1000;
        }
        onPointerCancel?.(event);
      }}
      onLostPointerCapture={(event) => {
        fingerPan.lost(event);
        if (event.pointerType === "pen") ink.input.penUp(event.pointerId);
        if (pointer.current?.id === event.pointerId && !pointer.current.ended) {
          pointer.current.cancelled = true;
          suppress.current = Date.now() + 1000;
        }
        onLostPointerCapture?.(event);
      }}
      onClick={(event) => {
        const native = event.nativeEvent as MouseEvent & {
          pointerType?: string;
        };
        const keyboard = event.detail === 0 && !native.pointerType;
        const type =
          native.pointerType ||
          (event.detail ? (pointer.current?.type ?? "mouse") : "keyboard");
        const down = pointer.current;
        const blocked =
          type === "touch" &&
          (down?.blocked || ink.input.touchBlocked(down?.id));
        if (
          !keyboard &&
          (suppress.current > Date.now() ||
            (type === "pen" && !down && ink.input.recentInkGesture()) ||
            !choicePointerAllowed(
              type,
              down?.moved ?? false,
              down?.cancelled ?? false,
              !!blocked,
            ))
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
