import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePackage } from "../src/original/validation";
import {
  questionFingerprint,
  targetText,
  type TargetSelector,
} from "../src/original/explanations/contract";
import type { Block } from "../src/original/model";
async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw Error(
      "사용법: npm run export:explanation-targets -- <원문.json> <새대상파일.json>",
    );
  const raw = JSON.parse(await readFile(resolve(input), "utf8"));
  if (!["real", "demo"].includes(raw.dataKind))
    throw Error("원문 패키지가 필요합니다.");
  const p = await validatePackage(raw, raw.dataKind);
  const questions = await Promise.all(
    p.questions.map(async (q) => {
      const selectors: TargetSelector[] = q.choices.map((c) => ({
        kind: "choice",
        number: c.number,
      }));
      const regions: {
        area: "body" | "choice";
        number: number | null;
        blocks: Block[];
      }[] = [
        { area: "body", number: null, blocks: q.body },
        ...q.choices.map((c) => ({
          area: "choice" as const,
          number: c.number,
          blocks: c.blocks,
        })),
      ];
      for (const { area, number, blocks } of regions) {
        blocks.forEach((block, blockIndex) => {
          if (block.type === "text")
            selectors.push({
              kind: "block",
              area,
              choiceNumber: number,
              blockIndex,
            });
          else if (block.type === "statements")
            block.entries.forEach((entry, entryIndex) =>
              selectors.push({
                kind: "entry",
                area,
                choiceNumber: number,
                blockIndex,
                entryIndex,
                label: entry.label,
              }),
            );
        });
      }
      return {
        questionId: q.id,
        subjectId: q.subjectId,
        questionRevision: q.revision,
        gradingRevision: q.gradingRevision,
        questionFingerprint: await questionFingerprint(q, p.assets),
        targets: selectors.map((selector) => ({
          selector,
          expectedText: targetText(q, selector),
        })),
      };
    }),
  );
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        format: "police-explanation-target-candidates",
        schemaVersion: "1.0.0",
        dataKind: p.dataKind,
        notes: [
          "구조상 선택 가능한 대상 후보입니다. 해설 제작자는 판단 대상을 고르고 같은 선택지의 전체/내부 대상을 겹쳐 사용하지 마세요. 법률 검증 완료를 뜻하지 않습니다.",
        ],
        questions,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "대상 후보를 새 파일에 저장했습니다. 판단 대상 선정·법률 검증 완료를 뜻하지 않습니다.",
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
