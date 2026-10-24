import type { Attempt, Basis, Item, State } from "../domain/schema";
import type { Projection } from "./types";
const hints = new WeakMap<
  State,
  Pick<Projection, "representatives" | "responseConflicts">
>();
const key = (id: string, basis: Basis) => JSON.stringify([id, basis]);
export function attachHints(state: State, projection: Projection): State {
  hints.set(state, {
    representatives: { ...projection.representatives },
    responseConflicts: structuredClone(projection.responseConflicts),
  });
  return state;
}
export function copyHints(source: State, draft: State): void {
  const value = hints.get(source);
  if (value) hints.set(draft, value);
}
export function syncConflict(
  state: State,
  itemId: string,
  basis: Basis,
): boolean {
  return !!hints
    .get(state)
    ?.responseConflicts.some((c) => c.itemId === itemId && c.basis === basis);
}
export function syncLatest(
  state: State,
  item: Item,
  basis: Basis,
): { attempt: Attempt | undefined; conflicted: boolean } | undefined {
  const value = hints.get(state);
  if (!value) return undefined;
  const conflicted = syncConflict(state, item.id, basis),
    id = value.representatives[key(item.id, basis)];
  return {
    conflicted,
    attempt: conflicted
      ? undefined
      : state.attempts.find(
          (a) =>
            a.attemptId === id &&
            a.itemId === item.id &&
            a.basis === basis &&
            a.judgmentRevision === item.judgments[basis].judgmentRevision,
        ),
  };
}
