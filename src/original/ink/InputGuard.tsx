import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { InkFingerPan, InkInputCoordinator, type InkMode } from "./model";

const Policy = createContext<{
  mode: InkMode;
  setMode: (mode: InkMode) => void;
  input: InkInputCoordinator;
} | null>(null);
export const useQuizInput = () => useContext(Policy);

/** Reused unified finger-pan path; horizontal movement stays in local figures/tables. */
function scrollInkAncestors(origin: Element, x: number, y: number): void {
  const root = document.scrollingElement ?? document.documentElement;
  const move = (axis: "x" | "y", amount: number) => {
    let remaining = amount;
    if (!remaining) return;
    for (let node: Element | null = origin; node; node = node.parentElement) {
      if (!(node instanceof HTMLElement) || node === root) continue;
      const style = getComputedStyle(node);
      if (
        !/auto|scroll|overlay/.test(
          axis === "y" ? style.overflowY : style.overflowX,
        )
      )
        continue;
      const before = axis === "y" ? node.scrollTop : node.scrollLeft;
      if (axis === "y") node.scrollTop += remaining;
      else node.scrollLeft += remaining;
      remaining -= (axis === "y" ? node.scrollTop : node.scrollLeft) - before;
      if (Math.abs(remaining) < 0.5) return;
    }
    // Overlay dialogs retain their own scroll area without moving the background.
    if (
      axis === "y" &&
      !/hidden|clip/.test(getComputedStyle(document.body).overflowY) &&
      !/hidden|clip/.test(getComputedStyle(root).overflowY)
    )
      root.scrollTop += remaining;
  };
  move("x", x);
  move("y", y);
}
interface Contact {
  id: number;
  type: string;
  control: Element | null;
  origin: Element;
  x: number;
  y: number;
  moved: boolean;
  blocked: boolean;
  cancelled: boolean;
  ended: boolean;
}
const controlOf = (target: EventTarget | null) =>
  target instanceof Element
    ? target.closest("button,a,input,select,textarea,summary")
    : null;

/** Session-owned physical contacts, independent of the pencil/eraser tool. */
export function QuizInputGuard({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<InkMode>("pen");
  const input = useRef(new InkInputCoordinator()).current;
  const scope = useRef<HTMLDivElement>(null);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    const pointerSupported = typeof PointerEvent !== "undefined";
    setSupported(pointerSupported);
    const contacts = new Map<number, Contact>();
    // Native Touch identifiers and PointerEvent IDs occupy different namespaces.
    const nativeContacts = new Map<number, Contact>();
    let last: Contact | null = null;
    const pan = new InkFingerPan();
    const inside = (target: EventTarget | null) =>
      target instanceof Node && !!scope.current?.contains(target);
    const stop = (e: Event) => {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
    };
    const distance = (c: Contact, x: number, y: number) => {
      if (Math.hypot(x - c.x, y - c.y) >= 8) c.moved = true;
    };
    const remember = (c: Contact) => {
      last = c;
      // Keep contact-specific trailing-click decisions, with bounded metadata.
      if (contacts.size > 128)
        for (const [id, old] of contacts) {
          if (old.ended && old !== c) contacts.delete(id);
          if (contacts.size <= 96) break;
        }
    };
    const pointer = (event: Event) => {
      const e = event as PointerEvent,
        scoped = inside(e.target);
      let c = contacts.get(e.pointerId);
      if (e.type === "pointerdown") {
        if (!scoped || !(e.target instanceof Element)) return;
        c = {
          id: e.pointerId,
          type: e.pointerType,
          control: controlOf(e.target),
          origin: e.target,
          x: e.clientX,
          y: e.clientY,
          moved: false,
          blocked: false,
          cancelled: false,
          ended: false,
        };
        contacts.set(e.pointerId, c);
        if (e.pointerType === "pen") {
          input.penDown(e.pointerId);
          for (const old of contacts.values())
            if (old.type === "touch" && !old.ended) old.blocked = true;
          for (const old of nativeContacts.values()) old.blocked = true;
          pan.cancel();
        } else if (e.pointerType === "touch") {
          input.touchDown(e.pointerId);
          c.blocked = input.touchBlocked(e.pointerId);
          if (input.canPan(e.pointerId))
            pan.start(e.pointerId, e.clientX, e.clientY);
          else pan.cancel();
          // Two fingers may be a native pinch, but neither is a number-button tap.
          for (const old of contacts.values())
            if (
              old.type === "touch" &&
              !old.ended &&
              input.touchBlocked(old.id)
            )
              old.blocked = true;
        }
        remember(c);
      }
      if (!c || c.ended) return;
      distance(c, e.clientX, e.clientY);
      if (c.type === "pen") {
        if (
          ["pointerup", "pointercancel", "lostpointercapture"].includes(e.type)
        ) {
          c.ended = true;
          c.cancelled = e.type !== "pointerup";
          input.penUp(e.pointerId);
          remember(c);
        }
        return;
      }
      if (c.type !== "touch") {
        if (e.type === "pointerup" || e.type === "pointercancel") {
          c.ended = true;
          c.cancelled = e.type === "pointercancel";
          remember(c);
        }
        return;
      }
      c.blocked ||= input.touchBlocked(e.pointerId);
      if (e.type === "pointermove") {
        const delta = pan.move(
          e.pointerId,
          e.clientX,
          e.clientY,
          input.canPan(e.pointerId),
        );
        if (delta.x || delta.y) {
          scrollInkAncestors(c.origin, delta.x, delta.y);
          if (e.cancelable) e.preventDefault();
        }
      }
      if (e.type === "lostpointercapture") {
        pan.end(e.pointerId);
        c.cancelled = true;
        c.blocked = true;
        input.invalidateTouch(e.pointerId);
      }
      if (e.type === "pointerup" || e.type === "pointercancel") {
        c.cancelled ||= e.type === "pointercancel";
        c.ended = true;
        input.touchUp(e.pointerId);
        pan.end(e.pointerId);
        remember(c);
      }
      if (c.blocked && scoped) stop(e);
    };
    const touch = (event: Event) => {
      if (!inside(event.target) || !(event.target instanceof Element)) return;
      const e = event as TouchEvent,
        target = event.target;
      let changedBlocked = false;
      for (const t of Array.from(e.changedTouches)) {
        let c = nativeContacts.get(t.identifier);
        if (e.type === "touchstart") {
          c = {
            id: t.identifier,
            type: "touch",
            control: controlOf(t.target),
            origin: target,
            x: t.clientX,
            y: t.clientY,
            moved: false,
            blocked: input.penActive,
            cancelled: false,
            ended: false,
          };
          nativeContacts.set(t.identifier, c);
        }
        if (!c) continue;
        c.blocked ||= input.penActive;
        distance(c, t.clientX, t.clientY);
        changedBlocked ||= c.blocked;
        if (e.type === "touchend" || e.type === "touchcancel") {
          c.ended = true;
          c.cancelled = e.type === "touchcancel";
          nativeContacts.delete(t.identifier);
        }
        // Native-only palms can later generate a MouseEvent with no pointer ID.
        if (c.blocked || !pointerSupported) last = c;
      }
      // Prevent UA pinch/compat gestures for rejected contacts. A separate fresh
      // valid PointerEvent can still manually pan while an old palm remains held.
      if (
        input.penActive ||
        changedBlocked ||
        (e.type === "touchmove" &&
          [...nativeContacts.values()].some((c) => c.blocked))
      )
        if (e.cancelable) e.preventDefault();
    };
    const click = (event: Event) => {
      if (!inside(event.target)) return;
      const e = event as MouseEvent & {
        pointerType?: string;
        pointerId?: number;
        sourceCapabilities?: { firesTouchEvents?: boolean };
      };
      if (e.detail === 0 && !e.pointerType) return;
      const typed = e.pointerType;
      let c = e.pointerId !== undefined ? contacts.get(e.pointerId) : undefined;
      if (c && typed && c.type !== typed) c = undefined;
      // A real contact ID must have a matching down in this session. Fallback
      // applies only to legacy MouseEvent/default-ID compatibility clicks.
      const identified = e.pointerId !== undefined && e.pointerId > 0;
      if (!c && !identified && (!typed || typed === last?.type))
        c = last ?? undefined;
      const type =
        typed || (e.sourceCapabilities?.firesTouchEvents ? "touch" : c?.type);
      if (type === "mouse" && typed === "mouse") return;
      if (
        type === "touch" &&
        (!c ||
          !c.ended ||
          c.control !== controlOf(e.target) ||
          input.penActive ||
          c?.blocked ||
          c?.cancelled ||
          c?.moved ||
          (c && input.touchBlocked(c.id)))
      ) {
        stop(e);
        return;
      }
      if (
        type === "pen" &&
        c &&
        (c.cancelled || c.moved || c.control !== controlOf(e.target))
      )
        stop(e);
    };
    const mouse = (event: Event) => {
      if (!inside(event.target) || !(event.target instanceof Element)) return;
      const e = event as MouseEvent & {
        sourceCapabilities?: { firesTouchEvents?: boolean };
      };
      if (e.sourceCapabilities?.firesTouchEvents) return;
      // A pointer-capable browser supplies a fresh mouse pointerdown first.
      // Do not recategorize a touch compatibility mousedown as real mouse input.
      if (pointerSupported && last?.type !== "mouse") return;
      if (!pointerSupported || e.sourceCapabilities?.firesTouchEvents === false)
        last = {
          id: -1,
          type: "mouse",
          control: controlOf(e.target),
          origin: event.target,
          x: e.clientX,
          y: e.clientY,
          moved: false,
          blocked: false,
          cancelled: false,
          ended: true,
        };
    };
    const context = (e: Event) => {
      if (
        inside(e.target) &&
        (input.penActive ||
          (last?.type === "touch" &&
            (last.blocked || last.moved || last.cancelled)))
      )
        stop(e);
    };
    const reset = () => {
      pan.cancel();
      for (const c of contacts.values())
        if (!c.ended) {
          c.cancelled = true;
          c.blocked ||= c.type === "touch";
          c.ended = true;
        }
      for (const c of nativeContacts.values()) {
        c.cancelled = true;
        c.ended = true;
        c.blocked = true;
      }
      nativeContacts.clear();
      input.reset();
    };
    const hide = () => {
      if (document.visibilityState === "hidden") reset();
    };
    const pointerTypes = [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "lostpointercapture",
      ],
      touchTypes = ["touchstart", "touchmove", "touchend", "touchcancel"];
    pointerTypes.forEach((t) =>
      document.addEventListener(t, pointer, { capture: true, passive: false }),
    );
    touchTypes.forEach((t) =>
      document.addEventListener(t, touch, { capture: true, passive: false }),
    );
    ["click", "auxclick", "dblclick"].forEach((t) =>
      document.addEventListener(t, click, true),
    );
    document.addEventListener("mousedown", mouse, true);
    document.addEventListener("contextmenu", context, true);
    document.addEventListener("selectstart", context, true);
    window.addEventListener("blur", reset);
    window.addEventListener("pagehide", reset);
    document.addEventListener("visibilitychange", hide);
    return () => {
      pointerTypes.forEach((t) =>
        document.removeEventListener(t, pointer, true),
      );
      touchTypes.forEach((t) => document.removeEventListener(t, touch, true));
      ["click", "auxclick", "dblclick"].forEach((t) =>
        document.removeEventListener(t, click, true),
      );
      document.removeEventListener("mousedown", mouse, true);
      document.removeEventListener("contextmenu", context, true);
      document.removeEventListener("selectstart", context, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pagehide", reset);
      document.removeEventListener("visibilitychange", hide);
      reset();
    };
  }, [input]);
  return (
    <Policy.Provider value={{ mode, setMode, input }}>
      <div
        ref={scope}
        className="quiz-input-scope"
        data-pointer-supported={supported ? "true" : "false"}
      >
        {!supported && (
          <p role="status" className="original-notice">
            이 브라우저는 펜 종류를 구분하지 못해 필기를 지원하지 않습니다.
            손가락 이동과 일반 조작은 사용할 수 있습니다.
          </p>
        )}
        {children}
      </div>
    </Policy.Provider>
  );
}
