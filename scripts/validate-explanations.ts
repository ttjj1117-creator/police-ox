import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_EXPLANATION_BYTES,
  validateExplanationPackage,
} from "../src/original/explanations/contract";
import { validatePackage } from "../src/original/validation";
import { stable } from "../src/original/validation";

async function main() {
  const args = process.argv.slice(2),
    file = args[0],
    questionFiles = args.flatMap((v, i) =>
      v === "--questions" && args[i + 1] ? [args[i + 1]] : [],
    );
  if (!file || !questionFiles.length)
    throw Error(
      "사용법: npm run validate:explanations -- <해설.json> --questions <원문패키지.json> [--questions <추가원문.json>]\n이 검사는 구조·참조·원문 버전 일치 검사이며 법률 검증이 아닙니다.",
    );
  const raw = await readFile(resolve(file));
  if (raw.byteLength > MAX_EXPLANATION_BYTES)
    throw Error("해설 파일은 20 MiB 이하여야 합니다.");
  const banks = [];
  for (const questionFile of questionFiles) {
    const source = JSON.parse(await readFile(resolve(questionFile), "utf8"));
    if (!["real", "demo"].includes(source.dataKind))
      throw Error("원문 파일은 원문 문제 패키지여야 합니다.");
    banks.push(await validatePackage(source, source.dataKind));
  }
  const namespace = banks[0].dataKind;
  if (banks.some((p) => p.dataKind !== namespace))
    throw Error("원문의 실제/시연 영역이 섞여 있습니다.");
  function unique<T extends object>(records: T[], key: (record: T) => string) {
    const map = new Map<string, T>();
    for (const r of records) {
      const id = key(r),
        old = map.get(id);
      if (old && stable(old) !== stable(r))
        throw Error(`원문 파일 사이의 동일 ID 충돌: ${id}`);
      map.set(id, r);
    }
    return [...map.values()];
  }
  const result = await validateExplanationPackage(
    JSON.parse(raw.toString("utf8")),
    namespace,
    unique(
      banks.flatMap((p) => p.questions),
      (q) => q.id,
    ),
    unique(
      banks.flatMap((p) => p.assets),
      (a) => a.assetId,
    ),
  );
  console.log(
    JSON.stringify(
      {
        valid: true,
        legalVerification: false,
        packageId: result.packageId,
        version: result.packageVersion,
        dataKind: result.dataKind,
        bases: result.bases.length,
        issues: result.issues.length,
        explanations: result.explanations.length,
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
