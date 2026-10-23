import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { judgmentSchema, parseDataset } from "../src/domain/schema";
import { ExplanationText } from "../src/ui/Explanation";
import { initialState } from "../src/fixtures/data";
import { mergeDataset } from "../src/data/transfer";
import { candidates } from "../src/domain/engine";
import { defaultSelection } from "../src/domain/schema";

// Public CI uses neutral synthetic text; no actual exam/conversion output is needed.
function highlightDataset() {
  const data = initialState(true).dataset;
  const template = structuredClone(data.items[0]);
  data.items = Array.from({ length: 80 }, (_, index) => {
    const item = structuredClone(template);
    item.id = `TEST_ONLY_highlight_${index}`;
    item.originalQuestionId = item.id;
    item.originalText = item.displayText = "작은 네모는 큰 네모이다.";
    item.revision = 2;
    const exam = item.judgments.exam;
    Object.assign(exam, {
      answer: "X",
      judgmentRevision: 2,
      shortReason: "큰 네모는 가상 조건을 만족합니다.",
      keyPoint: "",
      corrections: [{ wrong: "작은 네모", correct: "큰 네모" }],
      highlights: [
        { field: "shortReason", text: "큰 네모", kind: "topic" },
        {
          field: "correctionWrong",
          correctionIndex: 0,
          text: "작은",
          kind: "changed",
        },
        {
          field: "correctionWrong",
          correctionIndex: 0,
          text: "네모",
          kind: "topic",
        },
      ],
    });
    item.judgments.current =
      index < 11
        ? structuredClone(exam)
        : {
            answer: null,
            status: "draft",
            judgmentRevision: 2,
            verifiedAt: null,
            asOfDate: null,
            shortReason: "",
            keyPoint: "",
            corrections: [],
            evidence: [],
          };
    return item;
  });
  return parseDataset(data);
}
describe("해설 강조", () => {
  const dataset = highlightDataset();
  const sample = dataset.items[0];
  it("기존 형식·강조 형식 병합, 재가져오기 및 판단 상태를 보존하고 낮은 정보성 전역 버전도 허용한다", () => {
    const old = structuredClone(dataset);
    old.datasetVersion = 2;
    for (const item of old.items) {
      item.revision = 1;
      for (const j of Object.values(item.judgments)) {
        delete j.highlights;
        j.judgmentRevision = 1;
      }
    }
    expect(parseDataset(old).items).toHaveLength(80);
    const merged = mergeDataset(old, dataset);
    expect(merged.updated).toBe(80);
    expect(merged.dataset.datasetVersion).toBe(2);
    expect(mergeDataset(merged.dataset, dataset).unchanged).toBe(80);
    const state = initialState();
    state.dataset = merged.dataset;
    expect(candidates(state, defaultSelection)).toHaveLength(11);
    expect(
      dataset.items.filter((i) => i.judgments.current.status === "draft"),
    ).toHaveLength(69);
    expect(merged.dataset.items[0].judgments.exam.highlights).toEqual(
      sample.judgments.exam.highlights,
    );
  });
  it("잘못된 구절·정정 번호·겹치는 강조를 거부한다", () => {
    for (const h of [
      { field: "shortReason", text: "없는 구절", kind: "topic" },
      { field: "correctionWrong", text: "작은", kind: "changed" },
      {
        field: "correctionWrong",
        correctionIndex: 99,
        text: "작은",
        kind: "changed",
      },
      {
        field: "shortReason",
        correctionIndex: 0,
        text: "큰 네모",
        kind: "changed",
      },
    ])
      expect(
        judgmentSchema.safeParse({ ...sample.judgments.exam, highlights: [h] })
          .success,
      ).toBe(false);
    const h = { field: "shortReason", text: "큰 네모", kind: "changed" };
    expect(
      judgmentSchema.safeParse({ ...sample.judgments.exam, highlights: [h, h] })
        .success,
    ).toBe(false);
  });
  it("선정된 구절만 강조하고 HTML은 텍스트로 출력한다", () => {
    const j = sample.judgments.current;
    const html = renderToStaticMarkup(
      createElement(ExplanationText, {
        text: j.corrections[0].wrong,
        highlights: j.highlights,
        field: "correctionWrong",
        correctionIndex: 0,
      }),
    );
    expect((html.match(/<mark /g) ?? []).length).toBe(2);
    expect(html).toContain(">작은</mark>");
    expect(html).not.toContain(">큰</mark>");
    const literal = "<img src=x onerror=alert(1)>";
    const escaped = renderToStaticMarkup(
      createElement(ExplanationText, {
        text: literal,
        field: "shortReason",
        highlights: [{ field: "shortReason", text: literal, kind: "topic" }],
      }),
    );
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
  });
});
