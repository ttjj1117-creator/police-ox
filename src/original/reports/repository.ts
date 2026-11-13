import type { Namespace, Question } from "../model";

export const reportKinds = {
  question: "문제·정답",
  explanation: "해설",
  both: "문제·정답과 해설",
} as const;
export type ReportKind = keyof typeof reportKinds;
export interface QuestionReport {
  questionId: string;
  subjectId: Question["subjectId"];
  source: Pick<Question["source"], "year" | "round" | "questionNumber">;
  revision: number;
  gradingRevision: number;
  kind: ReportKind;
  resolved: boolean;
  updatedAt: string;
  changeId: string;
}
type StoredReport = QuestionReport & { scope: string };

export const reportScope = (namespace: Namespace, account: string | null) =>
  JSON.stringify([namespace, namespace === "real" ? account : null]);

export function createReport(
  question: Question,
  kind: ReportKind,
): QuestionReport {
  const { id, subjectId, source, revision, gradingRevision } = question;
  return {
    questionId: id,
    subjectId,
    source: {
      year: source.year,
      round: source.round,
      questionNumber: source.questionNumber,
    },
    revision,
    gradingRevision,
    kind,
    resolved: false,
    updatedAt: new Date().toISOString(),
    changeId: crypto.randomUUID(),
  };
}

export class QuestionReportRepository {
  constructor(private readonly name = "police-original-question-reports") {}

  private open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("reports", {
          keyPath: ["scope", "questionId"],
        });
        store.createIndex("scope", "scope");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async list(scope: string): Promise<QuestionReport[]> {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("reports", "readonly");
        const read = transaction
          .objectStore("reports")
          .index("scope")
          .getAll(scope);
        transaction.oncomplete = () =>
          resolve(
            (read.result as StoredReport[]).map(
              ({ scope: _, ...report }) => report,
            ),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? Error("오류 신고 목록을 읽지 못했습니다."),
          );
      });
    } finally {
      database.close();
    }
  }

  async change(
    scope: string,
    questionId: string,
    expectedChangeId: string | undefined,
    next: QuestionReport | null,
  ): Promise<void> {
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("reports", "readwrite");
        const store = transaction.objectStore("reports");
        const key = [scope, questionId];
        const read = store.get(key);
        let changedInOtherTab = false;
        read.onsuccess = () => {
          const saved = read.result as StoredReport | undefined;
          if (saved?.changeId !== expectedChangeId) {
            changedInOtherTab = true;
            transaction.abort();
            return;
          }
          if (next) store.put({ ...next, scope } satisfies StoredReport);
          else store.delete(key);
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            changedInOtherTab
              ? Error(
                  "다른 탭에서 이 신고가 바뀌었습니다. 목록을 확인하고 다시 시도하세요.",
                )
              : (transaction.error ??
                  Error("오류 신고 변경 사항을 저장하지 못했습니다.")),
          );
      });
    } finally {
      database.close();
    }
  }
}
