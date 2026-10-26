export type InkMode = "read" | "pen" | "eraser";
export interface InkIdentity {
  ownerKey: string;
  namespace: "real" | "demo";
  sessionId: string;
  questionId: string;
  contentVersion: string;
}
export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
}
export interface InkStroke {
  id: string;
  surfaceId: string;
  points: InkPoint[];
}
export interface InkHistory {
  strokes: InkStroke[];
  undo: InkStroke[][];
  redo: InkStroke[][];
}
export interface InkDocument {
  schemaVersion: 1;
  identity: InkIdentity;
  layouts: Record<string, InkHistory>;
}
export const inkIdentityKey = (identity: InkIdentity): string =>
  JSON.stringify([
    identity.ownerKey,
    identity.namespace,
    identity.sessionId,
    identity.questionId,
    identity.contentVersion,
  ]);
export const emptyInkHistory = (): InkHistory => ({
  strokes: [],
  undo: [],
  redo: [],
});
export const emptyInkDocument = (identity: InkIdentity): InkDocument => ({
  schemaVersion: 1,
  identity: { ...identity },
  layouts: {},
});
export function editInk(history: InkHistory, strokes: InkStroke[]): InkHistory {
  if (strokes === history.strokes) return history;
  return {
    strokes,
    undo: [...history.undo, history.strokes].slice(-50),
    redo: [],
  };
}
export function undoInk(history: InkHistory): InkHistory {
  if (!history.undo.length) return history;
  return {
    strokes: history.undo[history.undo.length - 1],
    undo: history.undo.slice(0, -1),
    redo: [...history.redo, history.strokes].slice(-50),
  };
}
export function redoInk(history: InkHistory): InkHistory {
  if (!history.redo.length) return history;
  return {
    strokes: history.redo[history.redo.length - 1],
    undo: [...history.undo, history.strokes].slice(-50),
    redo: history.redo.slice(0, -1),
  };
}
export function sameInkIdentity(
  left: InkIdentity,
  right: InkIdentity,
): boolean {
  return inkIdentityKey(left) === inkIdentityKey(right);
}
export function validInkDocument(
  value: unknown,
  identity: InkIdentity,
): value is InkDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as InkDocument;
  if (
    doc.schemaVersion !== 1 ||
    !doc.identity ||
    !sameInkIdentity(doc.identity, identity) ||
    !doc.layouts ||
    typeof doc.layouts !== "object" ||
    Array.isArray(doc.layouts)
  )
    return false;
  const validStroke = (stroke: InkStroke): boolean =>
    !!stroke &&
    typeof stroke.id === "string" &&
    typeof stroke.surfaceId === "string" &&
    Array.isArray(stroke.points) &&
    stroke.points.length > 0 &&
    stroke.points.every(
      (p) =>
        !!p &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        Number.isFinite(p.pressure) &&
        p.pressure > 0 &&
        p.pressure <= 1,
    );
  return Object.values(doc.layouts).every(
    (layout) =>
      layout &&
      [
        layout.strokes,
        ...((Array.isArray(layout.undo) && layout.undo) || []),
        ...((Array.isArray(layout.redo) && layout.redo) || []),
      ].every(
        (strokes) => Array.isArray(strokes) && strokes.every(validStroke),
      ) &&
      Array.isArray(layout.undo) &&
      Array.isArray(layout.redo),
  );
}
export function inkPressure(value: number, fallback = 0.5): number {
  return Number.isFinite(value) && value > 0 && value <= 1
    ? Math.max(0.1, value)
    : fallback;
}
export function inkWidth(pressure: number): number {
  return 1.4 + inkPressure(pressure) * 0.8;
}
export function localInkPoint(
  sample: { clientX: number; clientY: number; pressure: number },
  rect: { left: number; top: number },
  fallback = 0.5,
): InkPoint {
  return {
    x: sample.clientX - rect.left,
    y: sample.clientY - rect.top,
    pressure: inkPressure(sample.pressure, fallback),
  };
}
export const isDrawingPointer = (pointerType: string): boolean =>
  pointerType === "pen";
export function choicePointerAllowed(
  pointerType: string,
  moved: boolean,
  cancelled = false,
  touchBlocked = false,
): boolean {
  return !cancelled && !moved && !(pointerType === "touch" && touchBlocked);
}
/** Contacts identified while the pen is down stay palms until they lift. */
export class InkInputCoordinator {
  private pens = new Set<number>();
  private touches = new Map<number, { palm: boolean; multiple: boolean }>();
  private releasedBlocked = new Map<number, number>();
  private multiple = false;
  private inkClickUntil = 0;
  constructor(private readonly now = () => Date.now()) {}
  get penActive(): boolean {
    return this.pens.size > 0;
  }
  get hasContacts(): boolean {
    return this.penActive || this.touches.size > 0;
  }
  get hasPalmTouch(): boolean {
    return [...this.touches.values()].some((touch) => touch.palm);
  }
  penDown(id: number): void {
    this.pens.add(id);
    for (const touch of this.touches.values()) touch.palm = true;
  }
  penUp(id: number): void {
    this.pens.delete(id);
  }
  touchDown(id: number): void {
    if (this.touches.has(id)) return;
    this.releasedBlocked.delete(id);
    this.touches.set(id, {
      palm: this.penActive || this.hasPalmTouch,
      multiple: this.multiple,
    });
    if (this.touches.size > 1) {
      this.multiple = true;
      for (const touch of this.touches.values()) touch.multiple = true;
    }
  }
  touchUp(id: number): void {
    const touch = this.touches.get(id);
    if (touch && (touch.palm || touch.multiple))
      this.releasedBlocked.set(id, this.now() + 1000);
    this.touches.delete(id);
    if (!this.touches.size) this.multiple = false;
    for (const [pointer, expiry] of this.releasedBlocked)
      if (expiry <= this.now()) this.releasedBlocked.delete(pointer);
  }
  touchBlocked(id?: number): boolean {
    return (
      this.penActive ||
      this.hasPalmTouch ||
      (id !== undefined &&
        (!!this.touches.get(id)?.palm ||
          !!this.touches.get(id)?.multiple ||
          (this.releasedBlocked.get(id) ?? 0) > this.now()))
    );
  }
  palmBlocked(id: number): boolean {
    return this.penActive || this.hasPalmTouch || !!this.touches.get(id)?.palm;
  }
  canPan(id: number): boolean {
    return (
      this.touches.has(id) &&
      this.touches.size === 1 &&
      !this.multiple &&
      !this.touchBlocked(id)
    );
  }
  markInkGesture(): void {
    this.inkClickUntil = this.now() + 500;
  }
  recentInkGesture(): boolean {
    return this.inkClickUntil > this.now();
  }
  reset(): void {
    this.pens.clear();
    this.touches.clear();
    this.releasedBlocked.clear();
    this.multiple = false;
    this.inkClickUntil = 0;
  }
}
export interface InkPanDelta {
  x: number;
  y: number;
}
/** Slop and a locked dominant axis prevent jitter and a gesture changing purpose mid-drag. */
export class InkFingerPan {
  private pointer: {
    id: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    axis: "x" | "y" | null;
  } | null = null;
  get pointerId(): number | undefined {
    return this.pointer?.id;
  }
  start(id: number, x: number, y: number): void {
    this.pointer = { id, startX: x, startY: y, lastX: x, lastY: y, axis: null };
  }
  move(id: number, x: number, y: number, allowed: boolean): InkPanDelta {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== id) return { x: 0, y: 0 };
    if (!allowed) {
      this.cancel();
      return { x: 0, y: 0 };
    }
    if (!pointer.axis) {
      const dx = Math.abs(x - pointer.startX),
        dy = Math.abs(y - pointer.startY);
      if (Math.max(dx, dy) < 8) return { x: 0, y: 0 };
      pointer.axis = dy >= dx ? "y" : "x";
    }
    const delta = {
      x: pointer.axis === "x" ? pointer.lastX - x : 0,
      y: pointer.axis === "y" ? pointer.lastY - y : 0,
    };
    pointer.lastX = x;
    pointer.lastY = y;
    return delta;
  }
  end(id: number): void {
    if (this.pointer?.id === id) this.cancel();
  }
  cancel(): void {
    this.pointer = null;
  }
}
const pointDistance = (p: InkPoint, a: InkPoint, b: InkPoint): number => {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t =
    dx === 0 && dy === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy),
          ),
        );
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
};
const cross = (a: InkPoint, b: InkPoint, c: InkPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function segmentDistance(
  a: InkPoint,
  b: InkPoint,
  c: InkPoint,
  d: InkPoint,
): number {
  const ca = cross(a, b, c),
    da = cross(a, b, d),
    ac = cross(c, d, a),
    bc = cross(c, d, b);
  if (
    ((ca > 0 && da < 0) || (ca < 0 && da > 0)) &&
    ((ac > 0 && bc < 0) || (ac < 0 && bc > 0))
  )
    return 0;
  return Math.min(
    pointDistance(a, c, d),
    pointDistance(b, c, d),
    pointDistance(c, a, b),
    pointDistance(d, a, b),
  );
}
export function eraseInk(
  strokes: InkStroke[],
  surfaceId: string,
  from: InkPoint,
  to: InkPoint,
  radius = 10,
): InkStroke[] {
  const next = strokes.filter((stroke) => {
    if (stroke.surfaceId !== surfaceId) return true;
    const points = stroke.points;
    if (points.length === 1) return pointDistance(points[0], from, to) > radius;
    for (let i = 1; i < points.length; i++) {
      if (segmentDistance(points[i - 1], points[i], from, to) <= radius)
        return false;
    }
    return true;
  });
  return next.length === strokes.length ? strokes : next;
}
