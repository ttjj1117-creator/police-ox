import type { SyncEvent } from "./types";
type Pending = { outbox: SyncEvent[]; failures: Record<string, string> };
const sameCas = (a: SyncEvent, b: SyncEvent) =>
  a.kind === "bank"
    ? b.kind === "bank"
    : a.kind === "mark" &&
      b.kind === "mark" &&
      a.payload.questionId === b.payload.questionId;

/** Predicted future versions may not bypass a failed predecessor. */
export function nextSendable(meta: Pending): SyncEvent | undefined {
  return meta.outbox.find(
    (event, index) =>
      !meta.failures[event.eventId] &&
      !meta.outbox
        .slice(0, index)
        .some(
          (previous) =>
            !!meta.failures[previous.eventId] &&
            (previous.kind === "bank" || sameCas(previous, event)),
        ),
  );
}

/** Rebase/drop changes the version chain. Each later CAS intent needs review. */
export function holdSuccessors(meta: Pending, eventId: string, reason: string) {
  const index = meta.outbox.findIndex((event) => event.eventId === eventId);
  if (index < 0) return;
  const previous = meta.outbox[index];
  for (const event of meta.outbox.slice(index + 1))
    if (sameCas(previous, event)) meta.failures[event.eventId] ??= reason;
}
