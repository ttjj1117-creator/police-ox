import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFile } from "../src/data/transfer";
import { finalizeItems, readBaseline } from "./finalize-items";

try {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--input", "--output", "--existing"].includes(args[i]) ||
        !args[i + 1] || args[i + 1].startsWith("--") || flags.has(args[i]))
      throw new Error("사용법: npm run finalize -- --input items.json --output dataset.json [--existing dataset-or-backup.json]");
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.has("--input") || !flags.has("--output"))
    throw new Error("--input과 --output이 필요합니다.");
  const input = realpathSync(flags.get("--input")!);
  const output = resolve(flags.get("--output")!);
  // Resolve output directory aliases too; existing files are never overwritten.
  const outputIdentity = resolve(realpathSync(dirname(output)), basename(output));
  if (input.toLowerCase() === outputIdentity.toLowerCase())
    throw new Error("원본 파일을 출력 대상으로 사용할 수 없습니다.");
  const bytes = readFileSync(input);
  const existingPath = flags.get("--existing");
  const existing = existingPath ? readBaseline(parseFile(readFileSync(existingPath, "utf8"))) : undefined;
  const result = finalizeItems(parseFile(bytes.toString("utf8")), {
    exportedAt: new Date().toISOString(), existing,
  });
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const report = {
    ...result.report, input, output,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    outputSha256: createHash("sha256").update(result.json).digest("hex"),
    canonicalCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  };
  writeFileSync(output, result.json, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
