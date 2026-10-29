import { memo, useMemo } from "react";
import { segmentReadingFlow } from "./reading-flow";

/** The original mode intentionally returns exactly the old single text node. */
export const ReadingFlowText = memo(function ReadingFlowText({
  text,
  enabled = true,
  flowJudgmentMarkers = false,
}: {
  text: string;
  enabled?: boolean;
  flowJudgmentMarkers?: boolean;
}) {
  const segments = useMemo(
    () => segmentReadingFlow(text, { flowJudgmentMarkers }),
    [text, flowJudgmentMarkers],
  );
  if (!enabled) return text;
  return (
    <span className="original-reading-flow" data-reading-flow="auto">
      {segments.map((segment, index) => (
        <span
          key={index}
          data-reading-segment={segment.kind}
          className={
            segment.kind === "hard-break"
              ? "original-reading-hard-break"
              : segment.preserveWhitespace
                ? "original-reading-verbatim"
                : undefined
          }
        >
          {segment.text}
        </span>
      ))}
    </span>
  );
});
