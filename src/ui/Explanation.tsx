import { Fragment } from "react";
import type { ExplanationHighlight } from "../domain/schema";

export function hasAdditionalReason(reason: string, shown: string[]) {
  const normalize = (s: string) => s.replace(/\s+/g, "").trim();
  const normalized = normalize(reason);
  return !!normalized && !shown.some(s => normalize(s) === normalized)
    && normalize(shown.join("")) !== normalized;
}


/** 데이터 작성자가 선정한 구절만 표시한다. 법률 문구를 추측하거나 HTML을 실행하지 않는다. */
export function ExplanationText({ text, highlights = [], field, correctionIndex }: {
  text: string;
  highlights?: ExplanationHighlight[];
  field: ExplanationHighlight["field"];
  correctionIndex?: number;
}) {
  const spans = highlights.filter(h => h.field === field && h.correctionIndex === correctionIndex)
    .map(h => ({ ...h, start: text.indexOf(h.text), end: text.indexOf(h.text) + h.text.length }))
    .filter(h => h.start >= 0 && text.lastIndexOf(h.text) === h.start)
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  const parts = spans.map((h, index) => {
    if (h.start < cursor) return null;
    const before = text.slice(cursor, h.start);
    cursor = h.end;
    return <Fragment key={index}>{before}<mark className={`explanation-highlight ${h.kind}`} data-highlight-kind={h.kind}>{text.slice(h.start, h.end)}</mark></Fragment>;
  });
  return <>{parts}{text.slice(cursor)}</>;
}
