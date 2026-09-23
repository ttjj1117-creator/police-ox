import catalog from "../fixtures/book-taxonomies.json" with { type: "json" };
import type { Dataset, State } from "../domain/schema";

/** IDs in this catalog are permanent; never derive them again from names/order. */
export const bookTaxonomies = catalog as Dataset["taxonomies"];

export function installBookTaxonomies(state: State): boolean {
  const nodes = state.dataset.taxonomies;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let changed = false;
  for (const incoming of bookTaxonomies) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      nodes.push(structuredClone(incoming));
      changed = true;
    } else if (
      existing.id === "criminal-law" &&
      existing.origin === "custom" &&
      existing.taxonomyVersion === 1 &&
      existing.label === "형법" &&
      !existing.book &&
      existing.parentId === null
    ) {
      // Enrich the original placeholder while retaining its ID and all references.
      Object.assign(existing, structuredClone(incoming));
      changed = true;
    }
  }
  // Questions, attempts, sessions, marks, settings and existing custom nodes stay intact.
  if (changed) state.dataset.datasetVersion++;
  return changed;
}
