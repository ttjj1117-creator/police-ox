import { readFile, writeFile, realpath, stat, rename, unlink } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ZodError } from "zod";
import { validatePackage } from "../src/original/validation";
import { validateExplanationPackage } from "../src/original/explanations/contract";
import { validateInstructorPackage } from "../src/original/instructor/contract";
import {
  getFrequentLearningTopics,
  parseFrequentIssuesPackage,
  validateFrequentIssuesPackage,
} from "../src/original/frequent/contract";

const usage = `사용법: npm run validate:frequent-issues -- --connections <connections.json> --questions <questions.json> --legacy <explanations.json> --instructor <instructor.json> [--report <report.json>]
첫 연결 파일은 위치 인자로도 지정할 수 있습니다. --questions, --legacy, --instructor는 반복할 수 있습니다. .json.gz도 읽습니다.
구조·원천·버전·대상·해설 문단을 검사합니다. 의미 검토나 법률 검증을 수행하거나 상태를 승격하지 않습니다.`;

function parseArgs(args: string[]) {
  const result: { connections: string; questions: string[]; legacy: string[]; instructor: string[]; report: string } = {
    connections: "", questions: [], legacy: [], instructor: [], report: "",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return null;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!["connections", "questions", "legacy", "instructor", "report"].includes(name)) throw Error(`알 수 없는 옵션: ${arg}\n${usage}`);
      const path = args[++i];
      if (!path || path.startsWith("--")) throw Error(`${arg}: 파일 경로가 필요합니다.\n${usage}`);
      if (name === "connections" || name === "report") {
        if (result[name]) throw Error(`${arg}: 한 번만 지정하세요.`);
        result[name] = path;
      } else result[name as "questions" | "legacy" | "instructor"].push(path);
    } else {
      if (result.connections) throw Error(`연결 파일이 둘입니다: ${arg}\n${usage}`);
      result.connections = arg;
    }
  }
  if (!result.connections || !result.questions.length || !result.legacy.length || !result.instructor.length) throw Error(usage);
  return result;
}
const inputs: { kind: string; path: string; sha256: string; bytes: number }[] = [];
async function guardReport(path: string, sources: string[]): Promise<string> {
  if (!path) return "";
  const output = resolve(path), outputStat = await stat(output).catch(() => null);
  const actual = await realpath(output).catch(async () => join(await realpath(dirname(output)), basename(output)));
  for (const source of sources) {
    const input = resolve(source), inputActual = await realpath(input).catch(() => input), inputStat = await stat(input).catch(() => null);
    if (actual.toLowerCase() === inputActual.toLowerCase() || (outputStat && inputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino))
      throw Error(`--report: 입력 원천 파일과 같은 경로를 사용할 수 없습니다: ${output}`);
  }
  return output;
}
async function writeReport(path: string, rendered: string) {
  const partial = join(dirname(path), `.${basename(path)}.${randomUUID()}.partial`);
  try {
    await writeFile(partial, rendered, { encoding: "utf8", flag: "wx" });
    await rename(partial, path);
  } finally { await unlink(partial).catch(() => undefined); }
}
async function json(path: string, kind: string): Promise<unknown> {
  const absolute = resolve(path), bytes = await readFile(absolute);
  inputs.push({ kind, path: absolute, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  try {
    return JSON.parse((path.toLowerCase().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8").replace(/^\uFEFF/, ""));
  } catch (e) { throw Error(`${kind} (${absolute}): JSON을 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`); }
}
function unique<T>(items: T[], key: (item: T) => string, kind: string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = key(item), before = map.get(id);
    if (before && JSON.stringify(before) !== JSON.stringify(item)) throw Error(`${kind}: 입력 파일 사이의 동일 ID 충돌 ${id}`);
    map.set(id, item);
  }
  return [...map.values()];
}
function errorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    const collect = (issues: ZodError["issues"]): string[] => issues.flatMap((issue) => issue.code === "invalid_union" ? issue.unionErrors.flatMap((error) => collect(error.issues)) : [`${issue.path.join(".") || "file"}: ${issue.message}`]);
    return [...new Set(collect(e.issues))].join("\n");
  }
  return e instanceof Error ? e.message : String(e);
}

async function main() {
  let report = "";
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) { console.log(usage); return; }
    report = await guardReport(args.report, [args.connections, ...args.questions, ...args.legacy, ...args.instructor]);
    const handoff = parseFrequentIssuesPackage(await json(args.connections, "connections"));
    const questionPackages = [];
    for (const file of args.questions) questionPackages.push(await validatePackage(await json(file, "questions"), handoff.dataKind));
    const questions = unique(questionPackages.flatMap((p) => p.questions), (q) => q.id, "questions");
    const assets = unique(questionPackages.flatMap((p) => p.assets), (a) => a.assetId, "assets");
    const legacyPackages = [];
    for (const file of args.legacy) legacyPackages.push(await validateExplanationPackage(await json(file, "legacy"), handoff.dataKind, questions, assets));
    const instructorPackages = [];
    for (const file of args.instructor) instructorPackages.push(await validateInstructorPackage(await json(file, "instructor"), handoff.dataKind, questions, assets));
    const result = await validateFrequentIssuesPackage(handoff, {
      namespace: handoff.dataKind, questions, assets, questionPackages, legacyPackages, instructorPackages,
    });
    const topics = getFrequentLearningTopics(result);
    const output = {
      valid: true, schemaVersion: result.schemaVersion,
      handoffRevision: result.schemaVersion === "1.1.0" ? result.handoffRevision : 0,
      dataKind: result.dataKind,
      legalVerification: false, semanticReviewPerformed: false,
      questionBindings: result.questionIndex.length,
      canonicalTopics: topics.length,
      semanticLinks: topics.flatMap((t) => t.links).filter((l) => l.evidenceLane === "semantic_reviewed").length,
      retainedLegacyLinks: result.legacyVerifiedLinks.length,
      retainedCitationOccurrences: result.sourceCitationOccurrences.length,
      inputs,
    };
    const rendered = JSON.stringify(output, null, 2) + "\n";
    if (report) await writeReport(report, rendered);
    console.log(rendered.trimEnd());
  } catch (e) {
    const error = errorMessage(e), output = { valid: false, legalVerification: false, semanticReviewPerformed: false, error, inputs };
    if (report) {
      try { await writeReport(report, JSON.stringify(output, null, 2) + "\n"); }
      catch (writeError) { console.error(`보고서 저장 실패: ${errorMessage(writeError)}`); }
    }
    console.error(error);
    process.exitCode = 1;
  }
}
void main();
