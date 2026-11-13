import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const maxPlainBytes = 128 * 1024 * 1024;
const maxCompressedBytes = 50_000_000;
const maxManifestBytes = 4 * 1024;
const privateOutput = fileURLToPath(new URL("./private-release/", import.meta.url));
const appModules = "src/original";
const inputFormats = {
  question: "police-original-questions",
  legacy: "police-original-explanations",
  instructor: "police-instructor-explanations-intermediate",
};
const privateFields = new Set([
  "attempts", "marks", "sessions", "settings", "removedQuestionIds",
  "generations", "learningHistory", "accessToken", "refreshToken",
  "userId", "accountId", "email", "password",
]);

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function rejectPrivateFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) rejectPrivateFields(child);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (privateFields.has(key)) throw Error("계정 또는 학습 기록 필드가 들어 있습니다.");
      rejectPrivateFields(child);
    }
  }
}

async function loadPackages(files: string[], kind: keyof typeof inputFormats) {
  const ids = new Set<string>();
  const packages = [];
  for (const [index, file] of files.entries()) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > maxPlainBytes) throw Error();
      const bytes = await readFile(file);
      if (bytes.length > maxPlainBytes) throw Error();
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (data?.format !== inputFormats[kind] || data.dataKind !== "real" ||
          typeof data.packageId !== "string" || ids.has(data.packageId)) {
        throw Error();
      }
      rejectPrivateFields(data);
      ids.add(data.packageId);
      packages.push(data);
    } catch {
      // Parser failures can include payload details. Only identify the input slot.
      throw Error(`${kind} 파일 ${index + 1}: 중복 없이 실제 자료의 개별 JSON 내보내기 파일을 지정하세요.`);
    }
  }
  return packages;
}

function encode(value: unknown) {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  if (plain.length > maxPlainBytes) throw Error("압축 전 자료가 128 MiB를 초과합니다.");
  const gzip = gzipSync(plain);
  if (gzip.length > maxCompressedBytes) throw Error("압축한 자료가 50 MB를 초과합니다.");
  return { gzip, plainBytes: plain.length, descriptor: { bytes: gzip.length, sha256: digest(gzip) } };
}

async function writeImmutable(file: string, value: Buffer) {
  try {
    const existing = await readFile(file);
    if (!existing.equals(value)) throw Error("같은 배포 ID의 기존 파일이 다릅니다.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeAtomically(file, value);
  }
}

async function writeAtomically(file: string, value: Buffer) {
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, value, { flag: "wx" });
    await rename(temporaryFile, file);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

function loadAppValidators(root: string) {
  // The browser modules use extensionless TypeScript and JSON imports. Use the
  // app's TypeScript compiler in process so the packaging run needs no build.
  const require = createRequire(join(root, "package.json"));
  const compiler = require("typescript");
  const previous = require.extensions[".ts"];
  require.extensions[".ts"] = (module, fileName) => {
    const source = readFileSync(fileName, "utf8");
    const { outputText } = compiler.transpileModule(source, {
      compilerOptions: {
        target: compiler.ScriptTarget.ES2022,
        module: compiler.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      fileName,
    });
    (module as NodeModule & { _compile(source: string, path: string): void })._compile(outputText, fileName);
  };
  const fromApp = (file: string) => require(join(root, appModules, file));
  try {
    return {
      ...fromApp("validation.ts"),
      ...fromApp("explanations/sync.ts"),
      ...fromApp("instructor/contract.ts"),
      ...fromApp("explanations/contract.ts"),
      ...fromApp("explanations/analysis.ts"),
    };
  } finally {
    if (previous) require.extensions[".ts"] = previous;
    else delete require.extensions[".ts"];
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    "app-root": { type: "string" },
    question: { type: "string", multiple: true, default: [] },
    instructor: { type: "string", multiple: true, default: [] },
    legacy: { type: "string", multiple: true, default: [] },
    help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("node package-shared-library.mts [--app-root <앱 소스 경로>] --question <문제 JSON> [--instructor <강사 해설 JSON>] [--legacy <이전 형식 해설 JSON>]");
    console.log("Node.js 22.18+ 및 앱에 설치된 개발 의존성이 필요합니다. 앱 루트에서 실행하면 --app-root를 생략할 수 있습니다.");
    console.log("자료가 여러 개면 같은 옵션을 반복합니다. 결과는 스크립트 옆 private-release에 생성됩니다.");
    return;
  }
  const root = resolve(values["app-root"] ?? process.cwd());
  if (values.question.length === 0) throw Error("--question을 한 번 이상 지정하세요.");

  const { validatePackage, isEligible, stable, parseExplanationBundle,
    resolveInstructorRecords, explanationIndex, resolveExplanations } = loadAppValidators(root);
  const [rawQuestions, rawInstructor, rawLegacy] = await Promise.all([
    loadPackages(values.question, "question"),
    loadPackages(values.instructor, "instructor"),
    loadPackages(values.legacy, "legacy"),
  ]);

  const packages = [];
  const questionIds = new Set<string>();
  const assetsById = new Map<string, { assetId: string }>();
  for (const [index, raw] of rawQuestions.entries()) {
    const pkg = await validatePackage(raw, "real", { allowLargeCollection: true }).catch(() => {
      throw Error(`문제 파일 ${index + 1}: 앱 자료 검증을 통과하지 못했습니다.`);
    });
    for (const question of pkg.questions) {
      if (questionIds.has(question.id)) throw Error("여러 문제 파일에 같은 문항이 있습니다.");
      questionIds.add(question.id);
    }
    for (const asset of pkg.assets) {
      const prior = assetsById.get(asset.assetId);
      if (prior && stable(prior) !== stable(asset)) throw Error("같은 그림 ID의 자료가 다릅니다.");
      assetsById.set(asset.assetId, asset);
    }
    packages.push(pkg);
  }
  if (questionIds.size === 0) throw Error("공유할 문제 문항이 없습니다.");

  const bundle = await parseExplanationBundle({ legacy: rawLegacy, instructor: rawInstructor }).catch(() => {
    throw Error("해설 자료가 앱 검증을 통과하지 못했습니다.");
  });
  const questions = packages.flatMap((pkg) => pkg.questions);
  const assets = [...assetsById.values()];
  const legacyIndex = explanationIndex(bundle.legacy);
  let matchedInstructorRecords = 0;
  let matchedInstructorQuestions = 0;
  let matchedLegacyRecords = 0;
  for (const question of questions) {
    if (bundle.instructor.length) {
      const records = await resolveInstructorRecords(question, bundle.instructor, assets);
      const matches = records.filter((item: { status: string }) => item.status !== "stale").length;
      matchedInstructorRecords += matches;
      if (matches) matchedInstructorQuestions++;
    }
    if (bundle.legacy.length) {
      const records = await resolveExplanations(question, bundle.legacy, assets, legacyIndex);
      matchedLegacyRecords += records.filter((item: { status: string }) => item.status !== "stale").length;
    }
  }

  const questionFile = encode({ packages });
  const explanationFile = encode(bundle);
  const releaseId = digest(`${questionFile.descriptor.sha256}:${explanationFile.descriptor.sha256}`);
  const manifest = {
    version: 1,
    releaseId,
    questions: questionFile.descriptor,
    explanations: explanationFile.descriptor,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n");
  if (manifestBytes.length > maxManifestBytes) throw Error("배포 정보가 4 KiB를 초과합니다.");

  const releaseDir = join(privateOutput, "releases", releaseId);
  await mkdir(releaseDir, { recursive: true });
  await writeImmutable(join(releaseDir, "questions.json.gz"), questionFile.gzip);
  await writeImmutable(join(releaseDir, "explanations.json.gz"), explanationFile.gzip);
  await writeAtomically(join(privateOutput, "current.json"), manifestBytes);

  console.log(JSON.stringify({
    releaseId,
    questionPackages: packages.length,
    questions: questionIds.size,
    eligibleQuestions: questions.filter((question) => isEligible(question, "real")).length,
    questionAssets: assetsById.size,
    instructorPackages: bundle.instructor.length,
    instructorRecords: bundle.instructor.reduce((count: number, pkg: { records: unknown[] }) => count + pkg.records.length, 0),
    instructorAssets: bundle.instructor.reduce((count: number, pkg: { assets: unknown[] }) => count + pkg.assets.length, 0),
    instructorDocuments: bundle.instructor.reduce((count: number, pkg: { documents: unknown[] }) => count + pkg.documents.length, 0),
    matchedInstructorRecords,
    matchedInstructorQuestions,
    legacyPackages: bundle.legacy.length,
    legacyRecords: legacyIndex.explanations.length,
    matchedLegacyRecords,
    questionPlainBytes: questionFile.plainBytes,
    explanationPlainBytes: explanationFile.plainBytes,
    questionGzipBytes: questionFile.descriptor.bytes,
    explanationGzipBytes: explanationFile.descriptor.bytes,
    manifestBytes: manifestBytes.length,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "공유 자료 묶음을 만들 수 없습니다.");
  process.exitCode = 1;
});
