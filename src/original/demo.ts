import type { OriginalData, OriginalPackage, Question, Subject } from "./model";
import { areas, units } from "./validation";

export function emptyData(): OriginalData { return { questions: [], assets: [], packages: [] }; }

/** Nonlegal color/shape prompts, solely to exercise the interface. */
export function demoData(): OriginalData {
  const numbers: Record<string, number> = {};
  const questions: Question[] = [];
  for (const area of areas) {
    for (let i = 0; i < area.targetQuestions; i++) {
      const subjectId = area.subjectId as Subject;
      const number = (numbers[subjectId] ?? 0) + 1;
      numbers[subjectId] = number;
      const prefix = { constitution: "const", criminal: "crim", police: "police", criminology: "crime", civil_general: "civil" }[subjectId];
      const labels = ["빨간 원", "파란 네모", "노란 별", "초록 세모"];
      const correct = number % 4 + 1;
      questions.push({
        id: `demo_${prefix}_${number}`, revision: 1, gradingRevision: 1, subjectId,
        source: { examCode: "demo", year: 2026, round: "1", examName: "기능 확인용 가상 예시", questionNumber: number, questionPdf: null, answerPdf: null },
        body: [
          { type: "text", text: `기능 확인용 예시 ${number} · 실제 기출이나 법률 문제가 아닙니다.\n다음 안내에 적힌 도형과 같은 선택지를 고르세요.` },
          { type: "statements", entries: [{ label: "㉠", text: `이번 화면의 안내 도형: ${labels[correct - 1]}` }, { label: "㉡", text: "네 선택지는 항상 원래 순서로 표시됩니다." }] },
        ],
        choices: labels.map((text, j) => ({ number: j + 1, blocks: [{ type: "text" as const, text }] })),
        officialAnswer: { status: "demo", kind: "single", acceptedChoices: [correct] },
        classification: { studyUnitCode: units.find((u) => u.subjectId === subjectId)?.code ?? null, relatedStudyUnitCodes: [], studyStatus: "confirmed", bookUnitIds: [], blueprintAreaCode: area.code, blueprintStatus: "confirmed" },
        qa: { textStatus: "checked", answerStatus: "checked", notes: ["기능 확인용 가상 문항. 원문 기출 대조나 공식 정답 검증을 의미하지 않습니다."] },
        lifecycle: "active",
      });
    }
  }
  const pkg: OriginalPackage = { format: "police-original-questions", schemaVersion: "1.0.0", packageId: "interface_demo_v1", packageVersion: 1, exportedAt: "2026-10-21T00:00:00.000Z", dataKind: "demo", stage: "classified", unitRegistryVersion: "1.0.0", questions, assets: [] };
  return { questions: structuredClone(questions), assets: [], packages: [pkg] };
}
