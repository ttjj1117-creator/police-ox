/** Display-only flow. The source string and every source character remain unchanged. */
export interface ReadingFlowSegment {
  kind: "text" | "soft-break" | "hard-break";
  text: string;
  preserveWhitespace?: boolean;
}

const itemStart =
  /^(?:[ㄱ-ㅎ가-힣][.)]\s*|[㉠-㉻①-⑳❶-❿⑴-⒇⒈-⒛]\s*|\d{1,3}\)\s*|\d{1,3}\.(?:\s|(?=[가-힣A-Za-z]))|[-*+]\s+|[•●○◦▪▫‣⁃·]\s*|※\s*|제\s*\d+\s*(?:조(?:의\s*\d+)?|항|호|목)(?=\s|[.(（]|$))/u;
const articleHeading =
  /^제\s*\d+\s*(?:조(?:의\s*\d+)?|항|호|목)\s*(?:\([^\r\n]*\)|（[^\r\n]*）)?$/u;
const shortHeading =
  /^(?:보기|자료|참고|유의사항|제시문|인용문|표|그림|<\s*보기\s*>|＜\s*보기\s*＞)$/u;
const opening = new Map([
  ["(", ")"],
  ["（", "）"],
  ["[", "]"],
  ["【", "】"],
  ["〈", "〉"],
  ["《", "》"],
  ["「", "」"],
  ["『", "』"],
]);
const closing = new Set(opening.values());

function standaloneEnclosure(line: string): boolean {
  const text = line.trim();
  if (!opening.has(text[0])) return false;
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    const close = opening.get(character);
    if (close) stack.push(close);
    else if (closing.has(character)) {
      if (stack.pop() !== character) return false;
      if (!stack.length && i !== text.length - 1) return false;
    }
  }
  return !stack.length;
}

function preformattedLine(line: string, flowJudgmentMarkers = false): boolean {
  // Classification only: leading source O/X bars are not table columns.
  const layout = flowJudgmentMarkers
    ? line.replace(/^\s*[①-⑳㉠-㉻ㄱ-ㅎ]\s*\|[○×OX]\|/u, "")
    : line;
  return layout.includes("\t") || (layout.match(/\|/g)?.length ?? 0) >= 2;
}

function separateLine(line: string, flowJudgmentMarkers = false): boolean {
  const text = line.trim();
  return (
    standaloneEnclosure(text) ||
    articleHeading.test(text) ||
    shortHeading.test(text) ||
    /^[-─━=]{3,}$/u.test(text) ||
    preformattedLine(line, flowJudgmentMarkers)
  );
}

/**
 * Single PDF-style line feeds flow with the available width. Explicit blank
 * paragraphs, list entries, headings, standalone notes and column rows keep
 * their boundaries. This is a reversible reading view, not a semantic rewrite.
 */
export function segmentReadingFlow(
  text: string,
  { flowJudgmentMarkers = false }: { flowJudgmentMarkers?: boolean } = {},
): ReadingFlowSegment[] {
  const lines = text.split(/(\r\n|\n|\r)/u);
  const result: ReadingFlowSegment[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    if (line)
      result.push({
        kind: "text",
        text: line,
        ...(preformattedLine(line, flowJudgmentMarkers) ? { preserveWhitespace: true } : {}),
      });
    const newline = lines[i + 1];
    if (!newline) continue;
    const next = lines[i + 2] ?? "";
    const hard =
      !line.trim() ||
      !next.trim() ||
      itemStart.test(next.trim()) ||
      separateLine(line, flowJudgmentMarkers) ||
      separateLine(next, flowJudgmentMarkers);
    result.push({ kind: hard ? "hard-break" : "soft-break", text: newline });
  }
  return result;
}
