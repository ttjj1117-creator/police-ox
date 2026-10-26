import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { demoData } from "../src/original/demo";
import {
  questionFingerprint,
  targetText,
  validateExplanationPackage,
  type ExplanationPackage,
  type TargetSelector,
} from "../src/original/explanations/contract";

async function main() {
  const dir = resolve(process.argv[2] ?? "tests/fixtures/explanations");
  await mkdir(dir, { recursive: true });
  const data = demoData(),
    q = data.questions.filter((q) => q.subjectId === "constitution");
  q[1].revision = 2;
  q[1].source.year = 2025;
  q[1].source.round = "2";
  const check = {
    status: "verified" as const,
    checkedAt: "2026-10-26T00:00:00.000Z",
    checkedBy: "demo-test-only",
    note: "비법률 자동화 시연 확인 기록. 법률 검증 자료가 아닙니다.",
  };
  const bases = ["A", "B"].map((n) => ({
    id: `demo-basis-${n}`,
    revision: 1,
    type: "demo" as const,
    title: `중립 도형 안내 ${n}`,
    identity: {
      authority: "비법률 시연 자료",
      number: `DEMO-SHAPES-${n}`,
      date: "2026-10-26",
    },
    sourceUrl: null,
    originalText: "파란 네모와 빨간 원의 이름을 확인하는 중립 시연 자료입니다.",
    archivedAt: "2026-10-26T00:00:00.000Z",
    temporalBasis: "current" as const,
    asOfDate: "2026-10-26",
    verification: check,
  }));
  const issues = [
    { id: "demo-issue-A1", basisId: bases[0].id, title: "모양 확인" },
    { id: "demo-issue-A2", basisId: bases[0].id, title: "색깔 확인" },
    { id: "demo-issue-B1", basisId: bases[1].id, title: "표시 순서" },
  ].map((i) => ({
    ...i,
    revision: 1,
    excerpt: "시연 도형의 색깔과 모양을 차례로 살펴봅니다.",
    locator: "중립 시연 안내 첫 문단",
    verification: check,
  }));
  const specs: {
    q: number;
    selector: TargetSelector;
    refs: { basisId: string; issueIds: string[] }[];
    status?: "draft" | "hold";
  }[] = [
    {
      q: 0,
      selector: { kind: "choice", number: 1 },
      refs: [
        { basisId: bases[0].id, issueIds: [issues[0].id, issues[0].id] },
        { basisId: bases[0].id, issueIds: [issues[0].id] },
      ],
    },
    {
      q: 0,
      selector: {
        kind: "entry",
        area: "body",
        choiceNumber: null,
        blockIndex: 1,
        entryIndex: 0,
        label: "㉠",
      },
      refs: [{ basisId: bases[0].id, issueIds: [issues[0].id, issues[1].id] }],
    },
    {
      q: 0,
      selector: {
        kind: "entry",
        area: "body",
        choiceNumber: null,
        blockIndex: 1,
        entryIndex: 1,
        label: "㉡",
      },
      refs: [{ basisId: bases[0].id, issueIds: [issues[1].id] }],
    },
    {
      q: 1,
      selector: { kind: "choice", number: 1 },
      refs: [
        { basisId: bases[0].id, issueIds: [issues[0].id] },
        { basisId: bases[1].id, issueIds: [issues[2].id] },
      ],
    },
    {
      q: 2,
      selector: { kind: "choice", number: 1 },
      refs: [{ basisId: bases[0].id, issueIds: [issues[0].id] }],
      status: "draft",
    },
    {
      q: 3,
      selector: { kind: "choice", number: 1 },
      refs: [{ basisId: bases[0].id, issueIds: [issues[0].id] }],
      status: "hold",
    },
  ];
  const explanations = await Promise.all(
    specs.map(async (s, n) => ({
      id: `demo-explanation-${n + 1}`,
      revision: 1,
      questionId: q[s.q].id,
      subjectId: q[s.q].subjectId,
      questionRevision: q[s.q].revision,
      gradingRevision: q[s.q].gradingRevision,
      questionFingerprint: await questionFingerprint(q[s.q], data.assets),
      selector: s.selector,
      expectedText: targetText(q[s.q], s.selector),
      explanation:
        "도형의 이름·색깔을 읽는 중립 시연 설명입니다. 실제 기출 해설이나 법률 판단이 아닙니다.",
      references: s.refs,
      verification: s.status
        ? {
            status: s.status,
            checkedAt: null,
            checkedBy: null,
            note: "시연 미검증 상태",
          }
        : check,
    })),
  );
  const pkg: ExplanationPackage = {
    format: "police-original-explanations",
    schemaVersion: "1.0.0",
    packageId: "demo-explanations-v1",
    packageVersion: 1,
    exportedAt: "2026-10-26T00:00:00.000Z",
    dataKind: "demo",
    scope: {
      subjectIds: ["constitution"],
      questionIds: [...new Set(explanations.map((e) => e.questionId))],
    },
    producer: "demo-fixture-generator",
    notes: ["비법률 테스트 전용. 실제 판례·법률 검증 데이터가 아닙니다."],
    bases,
    issues,
    explanations,
  };
  await validateExplanationPackage(pkg, "demo", data.questions, data.assets);
  const questionPackage = {
    ...data.packages[0],
    packageId: "demo-explanation-questions",
    questions: data.questions,
  };
  const invalid = structuredClone(pkg);
  invalid.explanations[0].references[0].issueIds = ["demo-missing-issue"];
  const stale = structuredClone(pkg);
  stale.explanations[0].questionFingerprint = "0".repeat(64);
  for (const [name, value] of Object.entries({
    "questions.demo.json": questionPackage,
    "valid.demo.json": pkg,
    "invalid-reference.demo.json": invalid,
    "stale-version.demo.json": stale,
  }))
    await writeFile(join(dir, name), JSON.stringify(value, null, 2) + "\n");
  console.log("비법률 시연 fixture 4개 생성: " + dir);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
