import { describe, expect, it } from "vitest";
import { segmentReadingFlow } from "../src/original/reading-flow";

const breaks = (text: string) =>
  segmentReadingFlow(text).filter((part) => part.kind !== "text");

describe("reversible display-only reading flow", () => {
  it("lets physical single line feeds flow without deleting any source characters", () => {
    const source =
      "화면의 읽기 영역을 넓게 사용하면서\n같은 문장을 자연스러운 폭으로 이어 읽습니다.\n글자와 문장 순서는 그대로 유지합니다.";
    const parts = segmentReadingFlow(source);
    expect(parts.map((part) => part.text).join("")).toBe(source);
    expect(breaks(source).map((part) => part.kind)).toEqual([
      "soft-break",
      "soft-break",
    ]);
  });

  it("retains CRLF, LF, CR and explicit blank paragraphs exactly", () => {
    const source =
      "첫 문장의 물리적 줄\r\n계속되는 설명\r\n \t\r\n다음 문단\r다시 이어지는 줄\n";
    expect(
      segmentReadingFlow(source)
        .map((part) => part.text)
        .join(""),
    ).toBe(source);
    expect(breaks("첫 문단\n\n둘째 문단").map((part) => part.kind)).toEqual([
      "hard-break",
      "hard-break",
    ]);
    expect(breaks("첫 줄\r다음 줄")[0]).toEqual({
      kind: "soft-break",
      text: "\r",
    });
  });

  it.each([
    "ㄱ. 항목",
    "ㄴ)항목",
    "가. 항목",
    "㉠ 항목",
    "㉡항목",
    "① 항목",
    "⑵ 항목",
    "1. 항목",
    "2)항목",
    "3.설명",
    "• 항목",
    "- 항목",
    "※ 안내",
  ])("keeps the boundary before an explicit item: %s", (marker) => {
    expect(breaks(`앞 설명\n${marker}`)[0].kind).toBe("hard-break");
  });

  it("does not confuse decimal numbers or normal words with list markers", () => {
    expect(breaks("앞 설명\n3.14 정도의 예시 값입니다.")[0].kind).toBe(
      "soft-break",
    );
    expect(breaks("앞 설명\n가독성을 위한 일반 문장입니다.")[0].kind).toBe(
      "soft-break",
    );
  });

  it("flows a wrapped list item until the next explicit item", () => {
    expect(
      breaks(
        "ㄱ. 한 항목의 긴 문장이\n다음 물리적 줄까지 이어집니다.\nㄴ. 다음 항목입니다.",
      ).map((part) => part.kind),
    ).toEqual(["soft-break", "hard-break"]);
  });

  it("keeps standalone note and heading boundaries on both sides", () => {
    for (const heading of [
      "(화면 확인용 안내)",
      "(안내 (추가 설명) 포함)",
      "[보기]",
      "〈자료〉",
      "제1조(화면 안내)",
      "보기",
    ]) {
      const source = `앞 설명\n${heading}\n다음 설명`;
      expect(breaks(source).map((part) => part.kind)).toEqual([
        "hard-break",
        "hard-break",
      ]);
      expect(
        segmentReadingFlow(source)
          .map((part) => part.text)
          .join(""),
      ).toBe(source);
    }
  });

  it("does not freeze a physically wrapped parenthetical continuation", () => {
    expect(breaks("(화면의 줄바꿈을\n이어 읽는 예시입니다.)")[0].kind).toBe(
      "soft-break",
    );
    expect(breaks("부연 설명 (안내)\n다음 물리적 줄입니다.")[0].kind).toBe(
      "soft-break",
    );
  });

  it("keeps article and numbered item starts apart", () => {
    expect(
      breaks("앞 설명\n제12조의2(표면 안내)\n제2항 안내\n1) 첫 항목").every(
        (part) => part.kind === "hard-break",
      ),
    ).toBe(true);
  });

  it("retains column rows and their exact spacing", () => {
    const source = "앞 설명\n구분\t첫 열\t둘째 열\n| 항목 | 값 |\n뒤 설명";
    const segments = segmentReadingFlow(source);
    expect(breaks(source).every((part) => part.kind === "hard-break")).toBe(
      true,
    );
    expect(
      segments
        .filter((part) => part.preserveWhitespace)
        .map((part) => part.text),
    ).toEqual(["구분\t첫 열\t둘째 열", "| 항목 | 값 |"]);
    expect(segments.map((part) => part.text).join("")).toBe(source);
  });

  it("handles empty text and leading/trailing blank lines without inventing content", () => {
    for (const source of [
      "",
      "\n",
      "\n\n",
      "\n앞 설명\n",
      "안내  두 칸\n계속  두 칸",
      "한 줄만 표시합니다.",
    ]) {
      expect(
        segmentReadingFlow(source)
          .map((part) => part.text)
          .join(""),
      ).toBe(source);
    }
    expect(segmentReadingFlow("")).toEqual([]);
  });
});
