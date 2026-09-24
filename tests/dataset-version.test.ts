import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { initialState } from "../src/fixtures/data";
import { canonical, defaultSelection } from "../src/domain/schema";
import { startSession, submit } from "../src/domain/engine";
import { backup, mergeDataset, validateBackup } from "../src/data/transfer";
import { installBookTaxonomies } from "../src/data/book-taxonomies";
import { removeItems } from "../src/data/remove-items";
import { Repository } from "../src/data/repository";
import { finalizeItems } from "../scripts/finalize-items";

function pair() {
  const existing = initialState(true).dataset;
  existing.datasetVersion = 5;
  const incoming = structuredClone(existing);
  incoming.datasetVersion = 1;
  incoming.items = [structuredClone(existing.items[0])];
  return { existing, incoming };
}

it("전역 버전 5에 버전 1 부분 Dataset을 추가하고 기존 지문과 반복 병합 결과를 보존한다", () => {
  const { existing, incoming } = pair();
  incoming.items[0].id = "new-item";
  const before = canonical(existing);
  const first = mergeDataset(existing, incoming);
  expect(first).toMatchObject({ added: 1, updated: 0, unchanged: 0 });
  expect(first.dataset.items.slice(0, existing.items.length)).toEqual(existing.items);
  expect(first.dataset.datasetVersion).toBe(5);
  expect(canonical(existing)).toBe(before);
  const again = mergeDataset(first.dataset, incoming);
  expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
  expect(again.dataset).toEqual(first.dataset);
});

it.each(["낮은 revision", "같은 revision의 다른 내용"])("%s 충돌은 전역 버전과 무관하게 거부한다", mode => {
  const { existing, incoming } = pair();
  if (mode === "낮은 revision") existing.items[0].revision = 2;
  else incoming.items[0].displayText += " 변경";
  expect(() => mergeDataset(existing, incoming)).toThrow(/revision 충돌/);
});

it.each(["exam", "current"] as const)("%s 판단 변경·판단 버전 하락은 계속 거부한다", basis => {
  const { existing, incoming } = pair();
  incoming.items[0].revision = 2;
  incoming.items[0].judgments[basis].shortReason += " 변경";
  expect(() => mergeDataset(existing, incoming)).toThrow(/judgmentRevision/);
  incoming.items[0].judgments[basis].judgmentRevision = 2;
  expect(mergeDataset(existing, incoming).updated).toBe(1);
  existing.items[0].judgments[basis].judgmentRevision = 3;
  expect(() => mergeDataset(existing, incoming)).toThrow(/judgmentRevision/);
});

it.each(["낮은 taxonomyVersion", "같은 버전의 다른 목차"])("%s는 계속 거부한다", mode => {
  const { existing, incoming } = pair();
  if (mode === "낮은 taxonomyVersion") existing.taxonomies[0].taxonomyVersion = 2;
  else incoming.taxonomies[0].label += " 변경";
  expect(() => mergeDataset(existing, incoming)).toThrow(/taxonomyVersion/);
});

it("기존 지문이 있는 다른 datasetId와의 병합은 여전히 실패한다", () => {
  const { existing, incoming } = pair(); incoming.datasetId = "other";
  expect(() => mergeDataset(existing, incoming)).toThrow(/datasetId 불일치/);
});

it("목차 설치·반복 설치가 정보성 버전을 증가시키지 않는다", () => {
  const s = initialState(); s.dataset.datasetVersion = 5;
  s.dataset.taxonomies = s.dataset.taxonomies.filter(n => n.origin === "custom");
  expect(installBookTaxonomies(s)).toBe(true);
  expect(s.dataset.datasetVersion).toBe(5);
  expect(installBookTaxonomies(s)).toBe(false);
  expect(s.dataset.datasetVersion).toBe(5);
});

it("기준 파일 없는 finalizer 버전 1도 더 높은 실제 Dataset에 병합할 수 있다", () => {
  const s = initialState(); s.dataset.datasetVersion = 5;
  const item = initialState(true).dataset.items[0];
  item.primaryUnitId = null;
  const result = finalizeItems([item], { exportedAt: "2026-09-23T00:00:00.000Z" });
  expect(result.dataset.datasetVersion).toBe(1);
  expect(mergeDataset(s.dataset, result.dataset).added).toBe(1);
});

it("저장된 높은 버전에 부분 반입·백업·삭제 후 재반입을 해도 기록과 격리를 보존한다", async () => {
  const repo = new Repository(crypto.randomUUID());
  const real = initialState(true); real.dataset.datasetId = "police-personal";
  real.dataset.datasetVersion = 5;
  startSession(real, defaultSelection); submit(real, real.sessions[0].id, "unknown");
  real.sessions[0].status = "ended";
  const originalAttempts = structuredClone(real.attempts);
  const originalSessions = structuredClone(real.sessions);
  const incoming = structuredClone(real.dataset);
  incoming.datasetVersion = 1; incoming.items = [structuredClone(real.dataset.items[0])];
  incoming.items[0].id = "new-item";
  const demo = initialState(true);
  await repo.save("real", real, 0); await repo.save("demo", demo, 0);
  let saved = await repo.load("real");
  saved.state.dataset = mergeDataset(saved.state.dataset, incoming).dataset;
  saved = await repo.save("real", saved.state, saved.generation);
  expect(saved.state.attempts).toEqual(originalAttempts);
  expect(saved.state.sessions).toEqual(originalSessions);
  expect(() => validateBackup(backup(saved.state, "real"), "real")).not.toThrow();
  const cleared = removeItems(saved.state, new Set(saved.state.dataset.items.map(i => i.id))).state;
  expect(cleared.dataset.datasetVersion).toBe(5);
  expect(mergeDataset(cleared.dataset, incoming).added).toBe(1);
  expect((await repo.load("demo")).state).toEqual(demo);
  await repo.close();
});
