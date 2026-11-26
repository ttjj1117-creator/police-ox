import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { parseFrequentIssuesPackage } from "../src/original/frequent/contract";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath)
  throw Error("연결 JSON 경로와 비공개 출력 폴더를 지정하세요.");
const input = await readFile(resolve(inputPath));
const checked = parseFrequentIssuesPackage(JSON.parse(input.toString("utf8")));
if (checked.dataKind !== "real")
  throw Error("공유 배포에는 실제 자료만 사용할 수 있습니다.");
const compressed = gzipSync(Buffer.from(JSON.stringify(checked)), { level: 9 });
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const releaseId = digest(compressed);
const output = resolve(outputPath, "frequent-issues");
const release = join(output, "releases", releaseId);
await mkdir(release, { recursive: true });
await writeFile(join(release, "connections.json.gz"), compressed);
await writeFile(
  join(output, "current.partial.json"),
  JSON.stringify(
    {
      version: 1,
      releaseId,
      connections: { bytes: compressed.length, sha256: releaseId },
    },
    null,
    2,
  ),
);
await rename(
  join(output, "current.partial.json"),
  join(output, "current.json"),
);
console.log(
  JSON.stringify({
    inputSha256: digest(input),
    releaseId,
    bytes: compressed.length,
    questionBindings: checked.questionIndex.length,
    note: "비공개 공유 저장소용 자료입니다. 공개 Git에 포함하지 마세요.",
  }),
);
