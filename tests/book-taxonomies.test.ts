import { expect, it } from "vitest";
import {
  bookTaxonomies,
  installBookTaxonomies,
} from "../src/data/book-taxonomies";
import { initialState } from "../src/fixtures/data";
import {
  canonical,
  parseDataset,
  defaultSelection,
} from "../src/domain/schema";
import { startSession, submit, descendants } from "../src/domain/engine";

it("세 PDF 목차는 고유 ID, 유효한 계층, 원본 쪽수를 가진다", () => {
  const s = initialState();
  expect(() => parseDataset(s.dataset)).not.toThrow();
  expect(new Set(bookTaxonomies.map((n) => n.id)).size).toBe(685);
  expect(
    bookTaxonomies.filter((n) => n.subjectId === "constitution"),
  ).toHaveLength(59);
  expect(bookTaxonomies.filter((n) => n.subjectId === "criminal")).toHaveLength(
    130,
  );
  expect(bookTaxonomies.filter((n) => n.subjectId === "police")).toHaveLength(
    496,
  );
  expect(
    bookTaxonomies.find((n) => n.label === "제2절 정당방위")?.book,
  ).toMatchObject({ page: 80, tocPage: 2, fileRef: "형법 목차.pdf" });
  expect(
    bookTaxonomies.find((n) => n.label === "제3절 재판청구권")?.book?.page,
  ).toBe(799);
  expect(bookTaxonomies.find((n) => n.label === "03 중국경찰")).toBeUndefined();
  expect(
    bookTaxonomies.find((n) => n.label === "07 중국경찰")?.book?.page,
  ).toBe(464);
  expect(descendants(s, ["criminal-law"]).size).toBe(130);
  expect(s.dataset.items).toHaveLength(0);
});

it("기존 목차·문제·응답·세션·설정은 보존하며 한번만 추가한다", () => {
  const s = initialState(true);
  startSession(s, defaultSelection);
  submit(s, s.sessions[0].id, "unknown");
  s.dataset.taxonomies.push({
    id: "criminal-law",
    parentId: null,
    label: "형법",
    order: 0,
    subjectId: "criminal",
    origin: "custom",
    taxonomyVersion: 1,
  });
  s.dataset.taxonomies.push({
    id: "criminal-procedure",
    parentId: null,
    label: "형사소송법 · 임시 체계",
    order: 1,
    subjectId: "criminal",
    origin: "custom",
    taxonomyVersion: 1,
  });
  const before = canonical({
    items: s.dataset.items,
    attempts: s.attempts,
    sessions: s.sessions,
    marks: s.marks,
    settings: s.settings,
  });
  const custom = structuredClone(
    s.dataset.taxonomies.filter((n) => n.id !== "criminal-law"),
  );
  expect(installBookTaxonomies(s)).toBe(true);
  expect(
    canonical({
      items: s.dataset.items,
      attempts: s.attempts,
      sessions: s.sessions,
      marks: s.marks,
      settings: s.settings,
    }),
  ).toBe(before);
  for (const node of custom)
    expect(s.dataset.taxonomies.find((n) => n.id === node.id)).toEqual(node);
  const version = s.dataset.datasetVersion;
  expect(installBookTaxonomies(s)).toBe(false);
  expect(s.dataset.datasetVersion).toBe(version);
  expect(() => parseDataset(s.dataset)).not.toThrow();
});
