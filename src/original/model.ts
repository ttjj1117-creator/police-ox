/** Public exchange contract 1.0.0. OX models deliberately remain separate. */
export type Namespace = "real" | "demo";
export type Subject = "constitution" | "criminal" | "police" | "criminology" | "civil_general";
export type Block =
  | { type: "text"; text: string }
  | { type: "statements"; entries: { label: string; text: string }[] }
  | { type: "image"; assetId: string; alt: string };
export interface Asset { assetId: string; mimeType: "image/png" | "image/jpeg"; sha256: string; base64: string }
export interface PdfReference { fileName: string; pages: number[] }
export interface Classification {
  studyUnitCode: string | null;
  relatedStudyUnitCodes: string[];
  studyStatus: "pending" | "confirmed";
  bookUnitIds: string[];
  blueprintAreaCode: string | null;
  blueprintStatus: "pending" | "confirmed";
}
export interface Question {
  id: string;
  revision: number;
  gradingRevision: number;
  subjectId: Subject;
  source: {
    examCode: "po" | "lieut" | "demo";
    year: number;
    round: string;
    examName: string;
    questionNumber: number;
    questionPdf: PdfReference | null;
    answerPdf: (PdfReference & { subjectColumn: string }) | null;
  };
  body: Block[];
  choices: { number: number; blocks: Block[] }[];
  officialAnswer: {
    status: "final" | "provisional" | "missing" | "demo";
    kind: "single" | "multiple" | "all_correct" | "excluded" | "unresolved";
    acceptedChoices: number[];
  };
  classification: Classification | null;
  qa: { textStatus: "pending" | "checked" | "hold"; answerStatus: "pending" | "checked" | "hold"; notes: string[] };
  lifecycle: "active" | "retired";
}
export interface OriginalPackage {
  format: "police-original-questions";
  schemaVersion: "1.0.0";
  packageId: string;
  packageVersion: number;
  exportedAt: string;
  dataKind: Namespace;
  stage: "extracted" | "classified";
  unitRegistryVersion: "1.0.0";
  questions: Question[];
  assets: Asset[];
}
export interface OriginalData { questions: Question[]; assets: Asset[]; packages: OriginalPackage[] }
