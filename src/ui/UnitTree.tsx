import { useState } from "react";
import { Dataset } from "../domain/schema";

type Node = Dataset["taxonomies"][number];

export function leafIds(nodes: Node[], id: string): string[] {
  const children = nodes.filter((node) => node.parentId === id);
  return children.length
    ? children.flatMap((child) => leafIds(nodes, child.id))
    : [id];
}

export function UnitTree({
  nodes,
  selected,
  onChange,
  counts,
}: {
  nodes: Node[];
  selected: string[];
  onChange: (ids: string[]) => void;
  counts: (id: string) => string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selectedLeaves = new Set(selected.flatMap((id) => leafIds(nodes, id)));
  const renderLevel = (
    parentId: string | null,
    depth: number,
  ): React.ReactNode => (
    <ul className="unit-tree-level">
      {nodes
        .filter((node) => node.parentId === parentId)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((node) => {
          const leaves = leafIds(nodes, node.id);
          const checked = leaves.every((id) => selectedLeaves.has(id));
          const partial =
            !checked && leaves.some((id) => selectedLeaves.has(id));
          const hasChildren = nodes.some((child) => child.parentId === node.id);
          const open = expanded.has(node.id);
          return (
            <li key={node.id}>
              <div
                className={`unit-tree-row${checked || partial ? " has-selection" : ""}`}
                style={{ marginInlineStart: Math.min(depth, 3) * 12 }}
              >
                <label className="unit-tree-check">
                  <input
                    type="checkbox"
                    aria-label={`${node.label} 선택`}
                    checked={checked}
                    ref={(element) => {
                      if (element) element.indeterminate = partial;
                    }}
                    onChange={() => {
                      const next = new Set(selectedLeaves);
                      leaves.forEach((id) =>
                        checked ? next.delete(id) : next.add(id),
                      );
                      onChange([...next]);
                    }}
                  />
                </label>
                <div className="unit-tree-content">
                  {hasChildren ? (
                    <button
                      className="unit-tree-toggle"
                      aria-expanded={open}
                      aria-label={`${node.label} ${open ? "접기" : "펼치기"}`}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          open ? next.delete(node.id) : next.add(node.id);
                          return next;
                        })
                      }
                    >
                      <span>{node.label}</span>
                      <span aria-hidden="true">{open ? "⌄" : "›"}</span>
                    </button>
                  ) : (
                    <span className="unit-tree-title">{node.label}</span>
                  )}
                  {partial && (
                    <small className="unit-tree-partial">일부 선택</small>
                  )}
                  {checked && hasChildren && (
                    <small className="unit-tree-partial">
                      하위 단원 전체 선택
                    </small>
                  )}
                  <small>{counts(node.id)}</small>
                  {node.book?.page && <small>기본서 {node.book.page}쪽</small>}
                  {node.id === "criminal-law" && !hasChildren && !node.book && (
                    <small>기본서 목차 등록 전</small>
                  )}
                </div>
              </div>
              {hasChildren && open && renderLevel(node.id, depth + 1)}
            </li>
          );
        })}
    </ul>
  );
  return (
    <div className="unit-tree" aria-label="단원별 선택">
      {renderLevel(null, 0)}
    </div>
  );
}
