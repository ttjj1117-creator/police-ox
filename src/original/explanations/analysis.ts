import type { Asset, Namespace, Question } from "../model";
import { isEligible, stable } from "../validation";
import {
  explanationIndex,
  questionFingerprint,
  selectorKey,
  sourceKey,
  targetText,
  type ExplanationPackage,
  type Explanation,
} from "./contract";

export type ResolvedExplanation = {
  explanation: Explanation;
  status: "verified" | "draft" | "hold" | "stale";
  reason?: string;
};
export async function resolveExplanations(
  q: Question,
  packages: ExplanationPackage[],
  assets: Asset[],
  knownIndex?: ReturnType<typeof explanationIndex>,
): Promise<ResolvedExplanation[]> {
  const hash = await questionFingerprint(q, assets),
    index = knownIndex ?? explanationIndex(packages);
  return index.explanations
    .filter((e) => e.questionId === q.id)
    .map((e) => {
      try {
        if (
          e.subjectId !== q.subjectId ||
          e.gradingRevision !== q.gradingRevision ||
          e.questionFingerprint !== hash ||
          targetText(q, e.selector) !== e.expectedText
        )
          return {
            explanation: e,
            status: "stale",
            reason: "원문·채점 기준 또는 대상 위치가 달라졌습니다.",
          };
      } catch {
        return {
          explanation: e,
          status: "stale",
          reason: "현재 원문에서 대상을 확인할 수 없습니다.",
        };
      }
      const checked =
        e.verification.status === "verified" &&
        e.references.every(
          (r) =>
            index.bm.get(r.basisId)?.verification.status === "verified" &&
            r.issueIds.every(
              (id) => index.im.get(id)?.verification.status === "verified",
            ),
        );
      return {
        explanation: e,
        status: checked
          ? "verified"
          : e.verification.status === "hold"
            ? "hold"
            : "draft",
      };
    });
}
export interface FrequencyFilter {
  subjectId: string;
  examCode: string;
  year: string;
  round: string;
}
export const emptyFrequencyFilter: FrequencyFilter = {
  subjectId: "",
  examCode: "",
  year: "",
  round: "",
};
export interface FrequencyRow {
  id: string;
  title: string;
  basisId: string;
  kind: "basis" | "issue";
  targets: number;
  questions: number;
  rounds: number;
  latest: string;
  related: Question[];
}
export async function frequencyAnalysis(
  questions: Question[],
  assets: Asset[],
  packages: ExplanationPackage[],
  namespace: Namespace,
  removed: string[] = [],
  filter = emptyFrequencyFilter,
) {
  const eligible = questions.filter(
    (q) =>
      !removed.includes(q.id) &&
      isEligible(q, namespace) &&
      (!filter.subjectId || q.subjectId === filter.subjectId) &&
      (!filter.examCode || q.source.examCode === filter.examCode) &&
      (!filter.year || String(q.source.year) === filter.year) &&
      (!filter.round || q.source.round === filter.round),
  );
  const scopedPackages = packages.filter((p) => p.dataKind === namespace),
    index = explanationIndex(scopedPackages);
  const groups = new Map<string, Question[]>();
  for (const q of eligible) {
    const k = sourceKey(q);
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  const duplicates: { questionIds: string[]; conflict: boolean }[] = [],
    ambiguous = new Set<string>();
  for (const [key, qs] of groups)
    if (qs.length > 1) {
      const hashes = await Promise.all(
        qs.map((q) => questionFingerprint(q, assets)),
      );
      const conflict = new Set(hashes).size > 1;
      duplicates.push({ questionIds: qs.map((q) => q.id), conflict });
      if (conflict) ambiguous.add(key);
    }
  type Bucket = {
    targets: Set<string>;
    questions: Map<string, Question>;
    rounds: Set<string>;
  };
  const buckets = new Map<string, Bucket>();
  let pending = 0,
    stale = 0;
  const covered = new Set<string>(),
    targets = new Set<string>();
  const add = (id: string, q: Question, target: string) => {
    const b = buckets.get(id) ?? {
      targets: new Set(),
      questions: new Map(),
      rounds: new Set(),
    };
    b.targets.add(target);
    b.questions.set(sourceKey(q), q);
    b.rounds.add(stable([q.source.examCode, q.source.year, q.source.round]));
    buckets.set(id, b);
  };
  for (const q of eligible) {
    if (ambiguous.has(sourceKey(q))) continue;
    const resolved = await resolveExplanations(
      q,
      scopedPackages,
      assets,
      index,
    );
    for (const r of resolved) {
      if (r.status === "stale") {
        stale++;
        continue;
      }
      if (r.status !== "verified") {
        pending++;
        continue;
      }
      const target = stable([
        sourceKey(q),
        selectorKey(r.explanation.selector),
      ]);
      targets.add(target);
      covered.add(sourceKey(q));
      for (const ref of r.explanation.references) {
        add("basis:" + ref.basisId, q, target);
        for (const issue of new Set(ref.issueIds))
          add("issue:" + issue, q, target);
      }
    }
  }
  const rows: FrequencyRow[] = [];
  for (const [key, b] of buckets) {
    const split = key.indexOf(":"),
      kind = key.slice(0, split) as "basis" | "issue",
      id = key.slice(split + 1),
      item = kind === "basis" ? index.bm.get(id)! : index.im.get(id)!;
    const related = [...b.questions.values()].sort(
      (a, b) =>
        b.source.year - a.source.year ||
        b.source.round.localeCompare(a.source.round, "ko", { numeric: true }) ||
        a.source.questionNumber - b.source.questionNumber,
    );
    const recent = related[0];
    rows.push({
      id,
      title: item.title,
      basisId: kind === "basis" ? id : index.im.get(id)!.basisId,
      kind,
      targets: b.targets.size,
      questions: b.questions.size,
      rounds: b.rounds.size,
      latest: `${recent.source.year}년 ${recent.source.round}차`,
      related,
    });
  }
  rows.sort(
    (a, b) =>
      b.questions - a.questions ||
      b.targets - a.targets ||
      a.title.localeCompare(b.title, "ko"),
  );
  const total = groups.size - ambiguous.size;
  return {
    rows,
    total,
    covered: covered.size,
    coverage: total ? Math.round((100 * covered.size) / total) : 0,
    unlinked: Math.max(0, total - covered.size),
    targets: targets.size,
    pending,
    stale,
    duplicates,
    ambiguous: ambiguous.size,
  };
}
