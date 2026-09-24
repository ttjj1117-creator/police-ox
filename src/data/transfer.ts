import {
  backupSchema,
  canonical,
  Dataset,
  Namespace,
  parseDataset,
  State,
} from "../domain/schema";
import { eligible } from "../domain/engine";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export function parseFile(text: string): unknown {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES)
    throw new Error("파일은 20MB 이하여야 합니다.");
  return JSON.parse(text);
}
export function mergeDataset(existing: Dataset, value: unknown) {
  const incoming = parseDataset(value);
  if (existing.items.length && incoming.datasetId !== existing.datasetId)
    throw new Error(
      "datasetId 불일치: 기존 데이터와 같은 데이터셋만 병합할 수 있습니다.",
    );
  let added = 0,
    updated = 0,
    unchanged = 0;
  const merge = <T extends { id: string }>(
    old: T[],
    fresh: T[],
    check: (a: T, b: T) => void,
  ) => {
    const map = new Map(old.map((v) => [v.id, v]));
    for (const v of fresh) {
      const before = map.get(v.id);
      if (before) check(before, v);
      map.set(v.id, v);
    }
    return [...map.values()];
  };
  const items = merge(existing.items, incoming.items, (a, b) => {
    if (
      b.revision < a.revision ||
      (b.revision === a.revision && canonical(a) !== canonical(b))
    )
      throw new Error(`items.${b.id}: revision 충돌`);
    for (const basis of ["exam", "current"] as const) {
      if (
        b.judgments[basis].judgmentRevision <
          a.judgments[basis].judgmentRevision ||
        (canonical(a.judgments[basis]) !== canonical(b.judgments[basis]) &&
          b.judgments[basis].judgmentRevision <=
            a.judgments[basis].judgmentRevision)
      )
        throw new Error(
          `items.${b.id}.judgments.${basis}: 판단 변경 시 judgmentRevision을 증가시키세요.`,
        );
    }
    if (canonical(a) === canonical(b)) unchanged++;
    else updated++;
  });
  added = incoming.items.filter(
    (v) => !existing.items.some((o) => o.id === v.id),
  ).length;
  const taxonomies = merge(existing.taxonomies, incoming.taxonomies, (a, b) => {
    if (
      b.taxonomyVersion < a.taxonomyVersion ||
      (b.taxonomyVersion === a.taxonomyVersion && canonical(a) !== canonical(b))
    )
      throw new Error(`taxonomies.${b.id}: taxonomyVersion 충돌`);
  });
  const merged = parseDataset({
    ...incoming,
    // Informational only: partial imports may come from an older export.
    datasetVersion: Math.max(existing.datasetVersion, incoming.datasetVersion),
    items,
    taxonomies,
    studyGroups: merge(existing.studyGroups, incoming.studyGroups, () => {}),
    coverage: merge(existing.coverage, incoming.coverage, () => {}),
  });
  return { dataset: merged, added, updated, unchanged };
}
export function backup(s: State, namespace: Namespace) {
  return {
    backupSchemaVersion: 1 as const,
    appVersion: "0.1.0",
    exportedAt: new Date().toISOString(),
    namespace,
    state: s,
  };
}
export function validateBackup(value: unknown, namespace: Namespace): State {
  const parsed = backupSchema.parse(value);
  if (parsed.namespace !== namespace)
    throw new Error(
      "실제/시연 백업 영역이 다릅니다. 같은 모드에서 복구하세요.",
    );
  const s = parsed.state;
  const fail = (reason: string): never => {
    throw new Error(`백업: ${reason}`);
  };
  if (s.sessions.filter((x) => x.status === "active").length > 1)
    fail("진행 중 세션이 두 개 이상입니다.");
  if (
    new Set(s.sessions.map((x) => x.id)).size !== s.sessions.length ||
    new Set(s.attempts.map((x) => x.attemptId)).size !== s.attempts.length
  )
    fail("중복 세션/응답 ID");
  const pairs = new Set<string>();
  for (const a of s.attempts) {
    const session = s.sessions.find((x) => x.id === a.sessionId),
      item = session?.items.find((v) => v.id === a.itemId);
    if (
      !session ||
      !item ||
      a.basis !== session.selection.basis ||
      a.itemRevision !== item.revision ||
      a.judgmentRevision !== item.judgments[a.basis].judgmentRevision ||
      a.expectedAnswer !== item.judgments[a.basis].answer
    )
      fail("응답 참조 또는 판단 스냅샷 불일치");
    const key = JSON.stringify([a.sessionId, a.itemId]);
    if (pairs.has(key)) fail("동일 세션에 중복 응답");
    pairs.add(key);
    const expected =
      a.response === "unknown"
        ? "unknown"
        : a.response === a.expectedAnswer
          ? "correct"
          : "incorrect";
    if (a.result !== expected) fail("응답 결과 불일치");
  }
  for (const session of s.sessions) {
    if (
      session.index >= session.items.length ||
      new Set(session.items.map((x) => x.id)).size !== session.items.length
    )
      fail("세션 위치 또는 지문 중복");
    if (!session.items.every((v) => eligible(v, session.selection.basis)))
      fail("출제 불가 스냅샷");
    if (session.cycleKey && !s.cycles[session.cycleKey]) fail("순회 참조 누락");
    session.items.forEach((v, i) => {
      const answered = pairs.has(JSON.stringify([session.id, v.id]));
      if (
        (i < session.index && !answered) ||
        (i > session.index && answered) ||
        (i === session.index && answered !== session.revealed)
      )
        fail("세션 공개 상태 불일치");
    });
    if (
      session.status === "completed" &&
      (session.index !== session.items.length - 1 || !session.revealed)
    )
      fail("완료 세션 상태 불일치");
  }
  for (const [key, c] of Object.entries(s.cycles)) {
    if (
      new Set(c.candidates).size !== c.candidates.length ||
      new Set(c.remaining).size !== c.remaining.length ||
      c.remaining.some((v) => !c.candidates.includes(v))
    )
      fail(`순회 목록 불일치: ${key}`);
  }
  for (const key of Object.keys(s.marks)) {
    let v;
    try {
      v = JSON.parse(key);
    } catch {
      fail("다시 보기 키 오류");
    }
    if (
      !Array.isArray(v) ||
      v.length !== 2 ||
      !s.dataset.items.some((x) => x.id === v[0]) ||
      !["exam", "current"].includes(v[1])
    )
      fail("다시 보기 참조 오류");
  }
  return s;
}
export function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
