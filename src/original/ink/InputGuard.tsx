import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { InkMode } from "./model";

const Policy = createContext<{
  mode: InkMode;
  setMode: (mode: InkMode) => void;
} | null>(null);
export const useQuizInput = () => useContext(Policy);

/** Session boundary, outside question-keyed ink providers. Never persisted. */
export function QuizInputGuard({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<InkMode>("read");
  const live = useRef(mode);
  live.current = mode;
  const scope = useRef<HTMLDivElement>(null);
  const touches = useRef(new Set<number>()),
    blocked = useRef(new Set<number>());
  const trail = useRef(0),
    hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contact = useRef<{ id: number; x: number; y: number } | null>(null);
  const penTap = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const lastPointer = useRef<{
    type: string;
    at: number;
    control: Element | null;
  } | null>(null);
  const nativeTouchAt = useRef(0);
  const [holding, setHolding] = useState(false);
  const [supported, setSupported] = useState(true);
  const stopHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
    contact.current = null;
    setHolding(false);
  };
  const setMode = (next: InkMode) => {
    if (next !== "read")
      for (const id of touches.current) blocked.current.add(id);
    live.current = next;
    setModeState(next);
    stopHold();
  };
  useEffect(() => {
    setSupported(typeof PointerEvent !== "undefined");
    const inside = (target: EventTarget | null) =>
      target instanceof Node && !!scope.current?.contains(target);
    const stop = (e: Event) => {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
    };
    const pointer = (event: Event) => {
      const e = event as PointerEvent;
      if (e.type === "pointerdown" && inside(e.target))
        lastPointer.current = {
          type: e.pointerType,
          at: Date.now(),
          control:
            e.target instanceof Element
              ? e.target.closest("button,a,summary")
              : null,
        };
      if (e.pointerType === "pen" && inside(e.target)) {
        if (e.type === "pointerdown")
          penTap.current =
            e.target instanceof Element && e.target.closest("button,a,summary")
              ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
              : null;
        const p = penTap.current;
        if (
          p?.id === e.pointerId &&
          Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 8
        )
          p.moved = true;
        return;
      }
      const within = inside(e.target),
        ending = e.type === "pointerup" || e.type === "pointercancel";
      if (
        e.pointerType !== "touch" ||
        (!within && !(ending && touches.current.has(e.pointerId)))
      )
        return;
      if (e.type === "pointerdown") touches.current.add(e.pointerId);
      if (touches.current.size > 1) stopHold();
      const deny = live.current !== "read" || blocked.current.has(e.pointerId);
      if (deny) {
        blocked.current.add(e.pointerId);
        trail.current = Date.now() + 1500;
      }
      const recovery =
        e.target instanceof Element &&
        !!e.target.closest("[data-touch-unlock]");
      if (e.type === "pointerup" || e.type === "pointercancel") {
        touches.current.delete(e.pointerId);
        // Retain a released id for the subsequent click, even after a mode change.
        if (blocked.current.has(e.pointerId)) trail.current = Date.now() + 1500;
        blocked.current.delete(e.pointerId);
      }
      if (deny && !recovery && within) stop(e);
    };
    const touch = (event: Event) => {
      if (!inside(event.target)) return;
      nativeTouchAt.current = Date.now();
      const recovery =
        event.target instanceof Element &&
        !!event.target.closest("[data-touch-unlock]");
      if (
        (live.current !== "read" ||
          [...touches.current].some((id) => blocked.current.has(id))) &&
        !recovery
      ) {
        trail.current = Date.now() + 1500;
        stop(event);
      } else if (recovery && event.cancelable) event.preventDefault();
    };
    const click = (event: Event) => {
      if (!inside(event.target)) return;
      const e = event as MouseEvent & {
        pointerType?: string;
        pointerId?: number;
        sourceCapabilities?: { firesTouchEvents?: boolean };
      };
      const touchLike =
        e.pointerType === "touch" || e.sourceCapabilities?.firesTouchEvents;
      const unknown = e.detail > 0 && !e.pointerType;
      const known = lastPointer.current,
        control =
          e.target instanceof Element
            ? e.target.closest("button,a,summary")
            : null;
      const compatibleControl =
        !!known &&
        ["mouse", "pen"].includes(known.type) &&
        known.control !== null &&
        known.control === control &&
        Date.now() - known.at < 1500 &&
        !(known.type === "pen" && penTap.current?.moved);
      if (e.pointerType === "pen" && penTap.current?.moved) {
        stop(e);
        return;
      }
      if (
        (touchLike &&
          (live.current !== "read" ||
            blocked.current.has(e.pointerId ?? -1) ||
            Date.now() < trail.current)) ||
        (unknown &&
          !compatibleControl &&
          (live.current !== "read" || Date.now() < trail.current))
      )
        stop(e);
    };
    const context = (e: Event) => {
      if (
        inside(e.target) &&
        live.current !== "read" &&
        Date.now() < trail.current &&
        lastPointer.current?.type !== "mouse" &&
        lastPointer.current?.type !== "pen"
      )
        stop(e);
    };
    const reset = () => {
      // A contact interrupted by blur must not become a click after focus returns.
      if (touches.current.size) trail.current = Date.now() + 1500;
      touches.current.clear();
      blocked.current.clear();
      live.current = "read";
      setModeState("read");
      stopHold();
    };
    const mouse = (event: Event) => {
      const e = event as MouseEvent & {
        sourceCapabilities?: { firesTouchEvents?: boolean };
      };
      if (!inside(e.target) || e.sourceCapabilities?.firesTouchEvents) return;
      const recent = lastPointer.current;
      if (
        recent &&
        ["pen", "touch"].includes(recent.type) &&
        Date.now() - recent.at < 1500
      )
        return;
      if (
        e.sourceCapabilities?.firesTouchEvents === false ||
        Date.now() - nativeTouchAt.current > 1500
      )
        lastPointer.current = {
          type: "mouse",
          at: Date.now(),
          control:
            e.target instanceof Element
              ? e.target.closest("button,a,summary")
              : null,
        };
    };
    const hide = () => {
      if (document.visibilityState === "hidden") reset();
    };
    const pointerTypes = [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
    ];
    const touchTypes = ["touchstart", "touchmove", "touchend", "touchcancel"];
    pointerTypes.forEach((type) =>
      document.addEventListener(type, pointer, {
        capture: true,
        passive: false,
      }),
    );
    touchTypes.forEach((type) =>
      document.addEventListener(type, touch, { capture: true, passive: false }),
    );
    ["click", "auxclick", "dblclick"].forEach((type) =>
      document.addEventListener(type, click, true),
    );
    document.addEventListener("contextmenu", context, true);
    document.addEventListener("selectstart", context, true);
    document.addEventListener("mousedown", mouse, true);
    window.addEventListener("blur", reset);
    window.addEventListener("pagehide", reset);
    document.addEventListener("visibilitychange", hide);
    return () => {
      pointerTypes.forEach((type) =>
        document.removeEventListener(type, pointer, true),
      );
      touchTypes.forEach((type) =>
        document.removeEventListener(type, touch, true),
      );
      ["click", "auxclick", "dblclick"].forEach((type) =>
        document.removeEventListener(type, click, true),
      );
      document.removeEventListener("contextmenu", context, true);
      document.removeEventListener("selectstart", context, true);
      document.removeEventListener("mousedown", mouse, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pagehide", reset);
      document.removeEventListener("visibilitychange", hide);
      if (hold.current) clearTimeout(hold.current);
    };
  }, []);
  const startHold = (id: number, x: number, y: number) => {
    stopHold();
    contact.current = { id, x, y };
    setHolding(true);
    hold.current = setTimeout(() => {
      trail.current = Date.now() + 1500;
      setMode("read");
    }, 1200);
  };
  return (
    <Policy.Provider value={{ mode, setMode }}>
      <div
        ref={scope}
        className="quiz-input-scope"
        data-touch-locked={mode !== "read" ? "true" : "false"}
      >
        {mode !== "read" && (
          <div className="quiz-touch-recovery">
            <button
              type="button"
              data-touch-unlock="true"
              data-holding={holding ? "true" : "false"}
              onPointerDown={(e) => {
                if (e.pointerType === "touch") {
                  e.preventDefault();
                  if (touches.current.size !== 1) {
                    stopHold();
                    return;
                  }
                  startHold(e.pointerId, e.clientX, e.clientY);
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    /* unsupported capture */
                  }
                }
              }}
              onPointerMove={(e) => {
                const p = contact.current;
                if (
                  p?.id === e.pointerId &&
                  Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 8
                )
                  stopHold();
              }}
              onPointerUp={stopHold}
              onPointerCancel={stopHold}
              onLostPointerCapture={stopHold}
              onPointerLeave={stopHold}
              onTouchStart={(e) => {
                if (!supported && e.touches.length === 1) {
                  const t = e.touches[0];
                  startHold(t.identifier, t.clientX, t.clientY);
                }
              }}
              onTouchMove={(e) => {
                if (!supported) {
                  const p = contact.current,
                    t = Array.from(e.touches).find(
                      (t) => t.identifier === p?.id,
                    );
                  if (
                    !p ||
                    !t ||
                    e.touches.length !== 1 ||
                    Math.hypot(t.clientX - p.x, t.clientY - p.y) >= 8
                  )
                    stopHold();
                }
              }}
              onTouchEnd={() => {
                if (!supported) stopHold();
              }}
              onTouchCancel={stopHold}
              onClick={(e) => {
                const type = (e.nativeEvent as PointerEvent).pointerType;
                if (
                  type === "touch" ||
                  (Date.now() < trail.current && e.detail > 0 && !type)
                ) {
                  e.preventDefault();
                  return;
                }
                setMode("read");
              }}
            >
              {holding
                ? "계속 누르세요 · 잠금 해제 중…"
                : "터치 잠금 해제 · 1.2초 누르기"}
            </button>
          </div>
        )}
        {!supported && (
          <p role="status" className="original-notice">
            이 브라우저는 펜 종류를 구분하지 못합니다. 필기는 지원되지 않으며
            터치 잠금은 길게 눌러 해제할 수 있습니다.
          </p>
        )}
        {children}
      </div>
    </Policy.Provider>
  );
}
