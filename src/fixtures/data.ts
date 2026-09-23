import { Dataset, State, Judgment } from "../domain/schema";
import { bookTaxonomies } from "../data/book-taxonomies";
export const subjects = {
  constitution: "헌법",
  criminal: "형사법",
  police: "경찰학",
};
export function emptyDataset(): Dataset {
  const taxonomies: Dataset["taxonomies"] = [];
  const add = (
    id: string,
    label: string,
    parentId: string | null,
    order: number,
  ) =>
    taxonomies.push({
      id,
      label,
      parentId,
      order,
      subjectId: "criminal",
      origin: "custom",
      taxonomyVersion: 1,
    });
  taxonomies.push(...structuredClone(bookTaxonomies));
  add("criminal-procedure", "형사소송법 · 임시 체계", null, 1);
  ["수사", "증거"].forEach((label, i) =>
    add(`procedure-${i}`, label, "criminal-procedure", i),
  );
  [
    [
      "수사의 기본 원칙·조건",
      "수사의 개시·고소·고발",
      "임의수사",
      "체포·구속",
      "압수·수색·검증",
      "수사상 권리 보장·변호인의 조력",
      "수사의 종결·불복",
    ],
    [
      "증거의 기본 원칙·증명의 대상",
      "위법수집증거배제법칙",
      "자백배제법칙",
      "전문법칙·전문법칙의 예외",
      "증거동의",
      "증명력·자유심증주의",
      "자백의 보강법칙",
      "탄핵증거",
    ],
  ].forEach((list, i) =>
    list.forEach((label, j) =>
      add(`procedure-${i}-${j}`, label, `procedure-${i}`, j),
    ),
  );
  return {
    schemaVersion: 1,
    datasetId: "police-personal",
    datasetVersion: 1,
    exportedAt: new Date().toISOString(),
    taxonomies,
    studyGroups: [],
    coverage: [],
    items: [],
  };
}
export function initialState(demo = false): State {
  return {
    dataset: demo ? demoDataset() : emptyDataset(),
    attempts: [],
    marks: {},
    sessions: [],
    cycles: {},
    allocations: {},
    settings: { fontScale: 1 },
  };
}
export function demoDataset(): Dataset {
  const d = emptyDataset();
  d.datasetId = "function-demo";
  d.taxonomies = [
    {
      id: "demo-root",
      parentId: null,
      label: "가상 예시",
      subjectId: "constitution",
      order: 0,
      origin: "custom",
      taxonomyVersion: 1,
    },
    ...["숫자", "도형", "색상"].map((label, i) => ({
      id: `demo-${i}`,
      parentId: "demo-root",
      label,
      subjectId: "constitution" as const,
      order: i,
      origin: "custom" as const,
      taxonomyVersion: 1,
    })),
  ];
  const examples = [
    ["1 더하기 1은 2이다.", "O", "1 + 1 = 2"],
    ["삼각형에는 변이 네 개 있다.", "X", "삼각형에는 변이 세 개 있다."],
    [
      "이 예시에서 파란 공은 파란색이다.",
      "O",
      "파란 공이라고 정한 가상 예시의 조건",
    ],
    ["3은 2보다 작다.", "X", "3은 2보다 크다."],
    ["정사각형에는 변이 네 개 있다.", "O", "정사각형의 네 변"],
    [
      "이 예시에서 빨간 상자는 파란색이다.",
      "X",
      "이 예시에서 빨간 상자는 빨간색이다.",
    ],
    ["2 더하기 3은 5이다.", "O", "2 + 3 = 5"],
  ];
  d.items = examples.map(([displayText, answer, keyPoint], i) => {
    const j: Judgment = {
      answer: answer as "O" | "X",
      status: "verified",
      judgmentRevision: 1,
      verifiedAt: "2026-09-19T00:00:00.000Z",
      asOfDate: "2026-09-19",
      shortReason: "법률과 무관한 기능 확인용 가상 문장입니다.",
      keyPoint: answer === "O" ? keyPoint : "",
      corrections:
        answer === "X" ? [{ wrong: displayText, correct: keyPoint }] : [],
      evidence: [
        {
          type: "other",
          title: "기능 확인용 예시의 정의",
          caseTextCompared: false,
        },
      ],
    };
    return {
      id: `demo-item-${i}`,
      revision: 1,
      originalQuestionId: `demo-original-${i}`,
      source: {
        year: 2026,
        round: "시연",
        examName: "기능 확인용 예시",
        track: "",
        subject: "가상 예시",
        questionNumber: i + 1,
        option: "",
        fileRef: "",
        page: null,
      },
      subjectId: "constitution",
      areaId: null,
      primaryUnitId: `demo-${i % 3}`,
      relatedUnitIds: [],
      tags: ["예시"],
      originalText: displayText,
      displayText,
      contextText: "실제 시험 또는 법률 지문이 아닙니다.",
      transformation: "original",
      transformationReason: "",
      trapTypes: [],
      originalVerified: true,
      judgments: {
        exam: j,
        current: {
          ...j,
        },
      },
      lifecycle: "active",
    };
  });
  d.studyGroups = [
    {
      id: "demo-group",
      title: "가상 예시 전체",
      subjectId: "constitution",
      unitIds: ["demo-root"],
      includeDescendants: true,
      optionalAnyTags: [],
      order: 0,
    },
  ];
  return d;
}
