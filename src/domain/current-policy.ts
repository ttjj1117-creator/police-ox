import { canonical, State } from "./schema";
import { demoDataset } from "../fixtures/data";

/** Preserve historical attempts, but never resume historical-basis learning. */
export function useCurrentLearning(s: State, demo: boolean): boolean {
  let changed = false;
  for (const session of s.sessions) {
    if (session.status === "active" && session.selection.basis !== "current") {
      session.status = "ended";
      changed = true;
    }
  }
  // Upgrade only exact built-in, non-legal examples. Never infer a real judgment.
  if (demo && s.dataset.datasetId === "function-demo") {
    for (const example of demoDataset().items) {
      const legacy = structuredClone(example);
      legacy.judgments.current = {
        ...legacy.judgments.current,
        answer: null,
        status: "draft",
        verifiedAt: null,
        asOfDate: null,
      };
      const index = s.dataset.items.findIndex(
        (item) => canonical(item) === canonical(legacy),
      );
      if (index >= 0) {
        example.revision = 2;
        example.judgments.current.judgmentRevision = 2;
        s.dataset.items[index] = example;
        changed = true;
      }
    }
  }
  return changed;
}
