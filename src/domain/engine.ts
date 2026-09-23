import {
  Basis,
  Item,
  Selection,
  State,
  Session,
  Attempt,
  canonical,
} from "./schema";

export const markKey = (id: string, b: Basis) => JSON.stringify([id, b]);
export function eligible(v: Item, b: Basis): boolean {
  const j = v.judgments[b];
  return (
    v.lifecycle === "active" &&
    v.originalVerified &&
    j.status === "verified" &&
    !!j.answer &&
    !!j.verifiedAt &&
    !!j.asOfDate &&
    !!j.shortReason.trim() &&
    j.evidence.length > 0 &&
    (j.answer === "X" ? j.corrections.length > 0 : !!j.keyPoint.trim())
  );
}
export function latest(s: State, v: Item, b: Basis): Attempt | undefined {
  return [...s.attempts]
    .reverse()
    .filter(
      (a) =>
        a.itemId === v.id &&
        a.basis === b &&
        a.judgmentRevision === v.judgments[b].judgmentRevision,
    )
    .sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))
    .at(0);
}
export const weak = (s: State, v: Item, b: Basis) =>
  !!s.marks[markKey(v.id, b)] ||
  ["incorrect", "unknown"].includes(latest(s, v, b)?.result ?? "");
export function descendants(s: State, ids: string[]): Set<string> {
  const result = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of s.dataset.taxonomies)
      if (n.parentId && result.has(n.parentId) && !result.has(n.id)) {
        result.add(n.id);
        changed = true;
      }
  }
  return result;
}
export function candidates(s: State, q: Selection): Item[] {
  const units = descendants(s, q.unitIds);
  const groups = s.dataset.studyGroups
    .filter((g) => q.groupIds.includes(g.id))
    .map((g) => ({
      g,
      units: g.includeDescendants
        ? descendants(s, g.unitIds)
        : new Set(g.unitIds),
    }));
  return s.dataset.items
    .filter((v) => {
      if (!eligible(v, q.basis) || v.subjectId !== q.subjectId) return false;
      if (
        q.view === "units" &&
        q.unitIds.length &&
        (!v.primaryUnitId || !units.has(v.primaryUnitId))
      )
        return false;
      if (
        q.view === "groups" &&
        q.groupIds.length &&
        !groups.some(
          ({ g, units }) =>
            v.primaryUnitId &&
            units.has(v.primaryUnitId) &&
            (!g.optionalAnyTags.length ||
              g.optionalAnyTags.some((t) => v.tags.includes(t))),
        )
      )
        return false;
      if (
        (q.year && String(v.source.year) !== q.year) ||
        (q.round && v.source.round !== q.round)
      )
        return false;
      const a = latest(s, v, q.basis);
      return (
        q.filter === "all" ||
        (q.filter === "unanswered" && !a) ||
        (q.filter === "incorrect" && a?.result === "incorrect") ||
        (q.filter === "unknown" && a?.result === "unknown") ||
        (q.filter === "marked" && !!s.marks[markKey(v.id, q.basis)])
      );
    })
    .filter((v, i, all) => all.findIndex((x) => x.id === v.id) === i);
}
export function shuffle<T>(values: T[], rng = Math.random): T[] {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function ordered(s: State, values: Item[]): Item[] {
  const paths = new Map<string, string>();
  const path = (id: string | null): string => {
    if (!id) return "~";
    if (paths.has(id)) return paths.get(id)!;
    const n = s.dataset.taxonomies.find((x) => x.id === id);
    if (!n) return "~";
    const value =
      (n.parentId ? path(n.parentId) + "." : "") +
      String(n.order + 100000).padStart(8, "0") +
      ":" +
      n.id;
    paths.set(id, value);
    return value;
  };
  return [...values].sort(
    (a, b) =>
      path(a.primaryUnitId).localeCompare(path(b.primaryUnitId)) ||
      a.source.year - b.source.year ||
      a.source.round.localeCompare(b.source.round, undefined, {
        numeric: true,
      }) ||
      a.source.questionNumber - b.source.questionNumber ||
      a.source.option.localeCompare(b.source.option, undefined, {
        numeric: true,
      }) ||
      a.id.localeCompare(b.id),
  );
}
export function cycleKey(q: Selection): string {
  return canonical({
    subjectId: q.subjectId,
    basis: q.basis,
    view: q.view,
    unitIds: [...q.unitIds].sort(),
    groupIds: [...q.groupIds].sort(),
    year: q.year,
    round: q.round,
    filter: q.filter,
  });
}
const token = (v: Item, b: Basis) =>
  JSON.stringify([v.id, v.judgments[b].judgmentRevision]);
export function cycleInfo(s: State, q: Selection, values = candidates(s, q)) {
  const key = cycleKey(q),
    old = s.cycles[key];
  const tokens = values.map((v) => token(v, q.basis)).sort();
  const changed = !!old && canonical(old.candidates) !== canonical(tokens);
  const remaining = old
    ? [
        ...old.remaining.filter((id) => tokens.includes(id)),
        ...tokens.filter((id) => !old.candidates.includes(id)),
      ]
    : tokens;
  return {
    key,
    changed,
    cycle: { candidates: tokens, remaining, round: old?.round ?? 1 },
  };
}
export function selectItems(
  s: State,
  q: Selection,
): { items: Item[]; complete: boolean; updated: boolean } {
  let values = candidates(s, q);
  const info = cycleInfo(s, q, values);
  const count = q.limit || values.length;
  const arrange = (a: Item[]) =>
    q.order === "random" ? shuffle(a) : ordered(s, a);
  if (q.mode === "cycle")
    return {
      items: arrange(
        values.filter((v) => info.cycle.remaining.includes(token(v, q.basis))),
      ).slice(0, count),
      complete: values.length > 0 && !info.cycle.remaining.length,
      updated: info.changed,
    };
  if (q.mode === "weak") {
    values = arrange(values.filter((v) => weak(s, v, q.basis)));
    values.sort((a, b) =>
      (latest(s, a, q.basis)?.answeredAt ?? "").localeCompare(
        latest(s, b, q.basis)?.answeredAt ?? "",
      ),
    );
    return {
      items: values.slice(0, count),
      complete: false,
      updated: info.changed,
    };
  }
  const buckets = new Map<string, Item[]>();
  for (const v of arrange(values)) {
    const key = v.primaryUnitId ?? "unclassified";
    buckets.set(key, [...(buckets.get(key) ?? []), v]);
  }
  const rank = (v: Item) =>
    !latest(s, v, q.basis)
      ? 0
      : info.cycle.remaining.includes(token(v, q.basis))
        ? 1
        : 2;
  for (const bucket of buckets.values())
    bucket.sort((a, b) => rank(a) - rank(b));
  const allocKey = (key: string) => JSON.stringify([q.subjectId, q.basis, key]);
  const keys = [...buckets.keys()].sort(
    (a, b) =>
      (s.allocations[allocKey(a)] ?? 0) - (s.allocations[allocKey(b)] ?? 0),
  );
  const result: Item[] = [];
  while (result.length < count) {
    let added = false;
    for (const key of keys) {
      const item = buckets.get(key)!.shift();
      if (item) {
        result.push(item);
        added = true;
      }
      if (result.length === count) break;
    }
    if (!added) break;
  }
  return { items: result, complete: false, updated: info.changed };
}
export function startSession(s: State, q: Selection, explicit?: Item[]): void {
  if (s.sessions.some((x) => x.status === "active"))
    throw new Error("진행 중 세션을 이어 풀거나 종료하세요.");
  const items = explicit ?? selectItems(s, q).items;
  if (!items.length) throw new Error("출제 가능한 지문이 없습니다.");
  const info = cycleInfo(s, q);
  s.cycles[info.key] = info.cycle;
  const session: Session = {
    id: crypto.randomUUID(),
    selection: structuredClone(q),
    items: structuredClone(items),
    index: 0,
    revealed: false,
    status: "active",
    cycleKey: explicit ? null : info.key,
    createdAt: new Date().toISOString(),
  };
  s.sessions.push(session);
  if (q.mode === "balanced")
    for (const v of items) {
      const key = JSON.stringify([
        q.subjectId,
        q.basis,
        v.primaryUnitId ?? "unclassified",
      ]);
      s.allocations[key] = (s.allocations[key] ?? 0) + 1;
    }
}
export function submit(
  s: State,
  id: string,
  response: Attempt["response"],
): void {
  const session = s.sessions.find((x) => x.id === id);
  if (!session || session.status !== "active" || session.revealed) return;
  const v = session.items[session.index],
    b = session.selection.basis,
    j = v.judgments[b];
  if (s.attempts.some((a) => a.sessionId === id && a.itemId === v.id)) return;
  if (!j.answer) throw new Error("판단 스냅샷에 정답이 없습니다.");
  s.attempts.push({
    attemptId: crypto.randomUUID(),
    sessionId: id,
    itemId: v.id,
    itemRevision: v.revision,
    basis: b,
    judgmentRevision: j.judgmentRevision,
    response,
    expectedAnswer: j.answer,
    result:
      response === "unknown"
        ? "unknown"
        : response === j.answer
          ? "correct"
          : "incorrect",
    answeredAt: new Date().toISOString(),
  });
  session.revealed = true;
  if (session.cycleKey) {
    const cycle = s.cycles[session.cycleKey];
    if (cycle)
      cycle.remaining = cycle.remaining.filter((t) => t !== token(v, b));
  }
}
export function next(s: State, id: string): void {
  const session = s.sessions.find((x) => x.id === id);
  if (!session || session.status !== "active" || !session.revealed) return;
  if (session.index === session.items.length - 1) session.status = "completed";
  else {
    session.index++;
    session.revealed = false;
  }
}
export function summary(attempts: Attempt[]) {
  const correct = attempts.filter((a) => a.result === "correct").length,
    incorrect = attempts.filter((a) => a.result === "incorrect").length,
    unknown = attempts.filter((a) => a.result === "unknown").length;
  return {
    answered: attempts.length,
    correct,
    incorrect,
    unknown,
    rate: attempts.length
      ? `${Math.round((correct / attempts.length) * 100)}%`
      : "—",
  };
}
/** Attribute an answer to the subject captured when it was submitted. */
export function subjectSummaries(s: State, basis: Basis) {
  const subjectsBySession = new Map(
    s.sessions.map((session) => [
      session.id,
      new Map(session.items.map((item) => [item.id, item.subjectId])),
    ]),
  );
  return Object.fromEntries(
    (["constitution", "criminal", "police"] as const).map((subjectId) => [
      subjectId,
      summary(
        s.attempts.filter(
          (attempt) =>
            attempt.basis === basis &&
            subjectsBySession.get(attempt.sessionId)?.get(attempt.itemId) ===
              subjectId,
        ),
      ),
    ]),
  );
}
export function sessionWeak(s: State, session: Session): Item[] {
  return session.items.filter(
    (v) =>
      s.marks[markKey(v.id, session.selection.basis)] ||
      s.attempts.some(
        (a) =>
          a.sessionId === session.id &&
          a.itemId === v.id &&
          a.result !== "correct",
      ),
  );
}
