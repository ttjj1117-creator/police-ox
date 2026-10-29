import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import type { OriginalPackage } from "../src/original/model";
import {
  questionFingerprint,
  targetText,
} from "../src/original/explanations/contract";
import {
  mergeInstructorPackages,
  parseInstructorPackage,
  resolveInstructorRecords,
  summarizeInstructorPackage,
  validateInstructorPackage,
  type InstructorPackage,
} from "../src/original/instructor/contract";
import { InstructorRepository } from "../src/original/instructor/library";

let source: OriginalPackage, pkg: InstructorPackage;
beforeEach(async () => {
  source = JSON.parse(
    readFileSync(
      resolve("tests/fixtures/explanations/questions.demo.json"),
      "utf8",
    ),
  );
  const q = source.questions[0],
    now = "2026-10-29T10:00:00Z";
  const loc = {
    page: 1,
    printedPage: "1",
    bbox: [10, 10, 100, 100] as [number, number, number, number],
    coordinateSystem: "pdf-points-top-left" as const,
  };
  pkg = {
    format: "police-instructor-explanations-intermediate",
    schemaVersion: "1.0.0",
    packageId: "instructor-demo",
    packageVersion: 1,
    exportedAt: now,
    dataKind: "demo",
    questionPackages: [],
    documents: [
      {
        documentId: "document",
        originalFileName: "demo.pdf",
        sha256: "a".repeat(64),
        byteSize: 123,
        pageCount: 2,
        relativePath: "demo.pdf",
        duplicatePaths: [],
        title: "시연 강사 원문",
        academy: null,
        instructor: "시연 강사",
        edition: null,
        authoredDate: null,
        sourceUrl: null,
        rightsNotice: null,
        exam: {
          examCode: "demo",
          subjectId: q.subjectId,
          year: q.source.year,
          round: q.source.round,
          booklet: null,
        },
        metadataEvidence: [],
        status: "checked",
        sourceType: "instructor",
      },
    ],
    records: [
      {
        id: "record",
        revision: 1,
        documentId: "document",
        questionId: q.id,
        subjectId: q.subjectId,
        questionRevision: q.revision,
        gradingRevision: q.gradingRevision,
        questionFingerprint: await questionFingerprint(q, source.assets),
        sourceKey: {
          examCode: q.source.examCode,
          year: q.source.year,
          round: q.source.round,
          questionNumber: q.source.questionNumber,
          booklet: null,
        },
        scope: {
          kind: "targets",
          targets: [
            {
              selector: { kind: "choice", number: 1 },
              expectedText: targetText(q, { kind: "choice", number: 1 }),
            },
          ],
        },
        blocks: [
          {
            type: "text",
            role: "explanation",
            text: "① (O) 제공된 원문 설명 <script>literal text</script>",
            locations: [loc],
          },
        ],
        locations: [loc],
        sourceSymbols: {
          answer: {
            rawText: "원문 정답",
            numbers: q.officialAnswer.acceptedChoices,
          },
          judgments: [],
        },
        officialAnswer: structuredClone(q.officialAnswer),
        extraction: {
          status: "checked",
          method: "source text",
          checkedAt: now,
          tool: "fixture",
          reasons: [],
        },
        matching: {
          status: "checked",
          method: "actual source comparison",
          checkedAt: now,
          evidence: {},
          reasons: [],
        },
        legalVerification: {
          status: "not_reviewed",
          reviewedAt: null,
          lawAsOf: null,
        },
        sourceQuestionText: null,
        notes: [],
      },
    ],
    assets: [],
    citationMentions: [],
    coverage: [],
    holds: [],
    reviews: [],
    compatibility: {},
    statistics: {},
  };
});
const validate = (p: unknown = pkg) =>
  validateInstructorPackage(p, "demo", source.questions, source.assets);

async function open(
  factory: IDBFactory,
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void,
) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name, version);
    r.onupgradeneeded = () => upgrade?.(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function put(
  db: IDBDatabase,
  store: string,
  key: string,
  value: unknown,
) {
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).put(value, key);
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error);
  });
}
async function get(db: IDBDatabase, store: string, key: string) {
  return new Promise<any>((resolve, reject) => {
    const t = db.transaction(store, "readonly"),
      r = t.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

describe("instructor source contract and binding", () => {
  it("retains source-only text and not_reviewed while preserving source questions exactly", async () => {
    const before = JSON.stringify(source);
    expect(await validate()).toEqual(pkg);
    expect(JSON.stringify(source)).toBe(before);
    expect(
      (
        await resolveInstructorRecords(
          source.questions[0],
          [pkg],
          source.assets,
        )
      )[0].status,
    ).toBe("checked");
    expect(summarizeInstructorPackage(pkg)).toMatchObject({
      questions: 1,
      checkedQuestions: 1,
      heldQuestions: 0,
    });
    expect(pkg.records[0].legalVerification.status).toBe("not_reviewed");
  });
  it("requires the unchanged revision, grading version, actual text, source key and fingerprint", async () => {
    for (const change of [
      (p: InstructorPackage) => p.records[0].questionRevision++,
      (p: InstructorPackage) => p.records[0].gradingRevision++,
      (p: InstructorPackage) =>
        (p.records[0].scope.targets[0].expectedText += " altered"),
      (p: InstructorPackage) =>
        (p.records[0].questionFingerprint = "f".repeat(64)),
      (p: InstructorPackage) => p.records[0].sourceKey.questionNumber++,
    ]) {
      const bad = structuredClone(pkg);
      change(bad);
      await expect(validate(bad)).rejects.toThrow();
    }
  });
  it("rejects wrong namespace, duplicate IDs, missing source, out-of-range page and unsupported legal status", async () => {
    await expect(
      validateInstructorPackage(pkg, "real", source.questions, source.assets),
    ).rejects.toThrow("영역");
    const duplicate = structuredClone(pkg);
    duplicate.records.push(structuredClone(duplicate.records[0]));
    expect(() => parseInstructorPackage(duplicate)).toThrow("중복 ID");
    const missing = structuredClone(pkg);
    missing.records[0].documentId = "missing";
    expect(() => parseInstructorPackage(missing)).toThrow("출처");
    const page = structuredClone(pkg);
    page.records[0].locations[0].page = 3;
    expect(() => parseInstructorPackage(page)).toThrow("페이지");
    const legal = structuredClone(pkg) as any;
    legal.records[0].legalVerification.status = "verified";
    expect(() => parseInstructorPackage(legal)).toThrow();
  });
  it("keeps explicit hold/pending separate and turns later question changes into stale", async () => {
    pkg.records[0].matching.status = "hold";
    pkg.records[0].matching.reasons = ["source answer dispute"];
    expect(
      (
        await resolveInstructorRecords(
          source.questions[0],
          [pkg],
          source.assets,
        )
      )[0],
    ).toMatchObject({ status: "hold", reason: "source answer dispute" });
    pkg.records[0].matching.status = "pending";
    expect(
      (
        await resolveInstructorRecords(
          source.questions[0],
          [pkg],
          source.assets,
        )
      )[0].status,
    ).toBe("pending");
    source.questions[0].revision++;
    expect(
      (
        await resolveInstructorRecords(
          source.questions[0],
          [pkg],
          source.assets,
        )
      )[0].status,
    ).toBe("stale");
  });
  it("checks embedded image bytes, type and digest before accepting any references", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const sha256 = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    pkg.assets.push({
      assetId: "table",
      mimeType: "image/png",
      sha256,
      relativePath: "assets/table.png",
      byteSize: bytes.length,
      documentId: "document",
      questionId: source.questions[0].id,
      location: pkg.records[0].locations[0],
      alt: "source table",
      base64: btoa(String.fromCharCode(...bytes)),
    });
    pkg.records[0].blocks.push({
      type: "image",
      role: "source_layout",
      assetId: "table",
      alt: "source table",
      locations: pkg.records[0].locations,
    });
    await expect(validate()).resolves.toBeDefined();
    pkg.assets[0].sha256 = "f".repeat(64);
    await expect(validate()).rejects.toThrow("해시");
    pkg.assets[0].mimeType = "image/jpeg";
    await expect(validate()).rejects.toThrow("형식");
    (pkg.assets[0] as any).base64 = "data:image/svg+xml;base64,abc";
    expect(() => parseInstructorPackage(pkg)).toThrow();
  });
  it("does not reorder packages on repeated import and rejects downgrade/same-revision edits", () => {
    const other = structuredClone(pkg);
    other.packageId = "other";
    const original = [pkg, other];
    expect(mergeInstructorPackages(original, structuredClone(pkg))).toBe(
      original,
    );
    const bad = structuredClone(pkg);
    bad.records[0].blocks[0] = {
      ...bad.records[0].blocks[0],
      text: "changed",
    } as any;
    expect(() => mergeInstructorPackages([pkg], bad)).toThrow("버전");
    bad.packageVersion++;
    expect(() => mergeInstructorPackages([pkg], bad)).toThrow("revision");
    bad.records[0].revision++;
    expect(mergeInstructorPackages([pkg], bad)[0]).toEqual(bad);
    const down = structuredClone(bad);
    down.packageVersion--;
    expect(() => mergeInstructorPackages([bad], down)).toThrow("버전");
  });
});

describe("atomic scoped explanation replacement", () => {
  it("migrates v1 without clearing original/history/ink or other owner and namespace data", async () => {
    const factory = new IDBFactory(),
      name = crypto.randomUUID();
    const before = await open(factory, name, 1, (db) =>
      ["collections", "attempts", "ink"].forEach((s) =>
        db.createObjectStore(s),
      ),
    );
    const scope = JSON.stringify(["me", "demo"]),
      other = JSON.stringify(["other", "demo"]),
      real = JSON.stringify(["me", "real"]);
    await put(before, "collections", scope, {
      generation: 4,
      packages: ["old explanation source"],
    });
    await put(before, "collections", other, {
      generation: 2,
      packages: ["other source"],
    });
    await put(before, "collections", real, {
      generation: 7,
      packages: ["real source"],
    });
    await put(before, "attempts", "original", {
      questions: source.questions,
      attempts: [{ answer: 2, result: "correct" }],
    });
    await put(before, "ink", "original", { strokes: [[1, 2, 3]] });
    before.close();
    const repo = new InstructorRepository(factory, name);
    const result = await repo.import(
      "me",
      "demo",
      pkg,
      source.questions,
      source.assets,
    );
    expect(result).toMatchObject({ generation: 1, packages: [pkg] });
    const after = await open(factory, name);
    expect(await get(after, "collections", scope)).toEqual({
      generation: 5,
      packages: [],
    });
    expect(await get(after, "collections", other)).toEqual({
      generation: 2,
      packages: ["other source"],
    });
    expect(await get(after, "collections", real)).toEqual({
      generation: 7,
      packages: ["real source"],
    });
    expect(await get(after, "attempts", "original")).toEqual({
      questions: source.questions,
      attempts: [{ answer: 2, result: "correct" }],
    });
    expect(await get(after, "ink", "original")).toEqual({
      strokes: [[1, 2, 3]],
    });
    expect(
      await repo.import(
        "me",
        "demo",
        structuredClone(pkg),
        source.questions,
        source.assets,
      ),
    ).toEqual(result);
    expect(await get(after, "collections", scope)).toEqual({
      generation: 5,
      packages: [],
    });
    after.close();
    await repo.close();
  });
  it("does not clear old data or create a new generation when source validation fails", async () => {
    const factory = new IDBFactory(),
      name = crypto.randomUUID();
    const db = await open(factory, name, 2, (d) =>
      ["collections", "instructorCollections"].forEach((s) =>
        d.createObjectStore(s),
      ),
    );
    const key = JSON.stringify(["me", "demo"]),
      old = { generation: 9, packages: ["keep"] };
    await put(db, "collections", key, old);
    const repo = new InstructorRepository(factory, name),
      bad = structuredClone(pkg);
    bad.records[0].questionFingerprint = "0".repeat(64);
    await expect(
      repo.import("me", "demo", bad, source.questions, source.assets),
    ).rejects.toThrow("내용");
    expect(await get(db, "collections", key)).toEqual(old);
    expect(await get(db, "instructorCollections", key)).toBeUndefined();
    await repo.import("me", "demo", pkg, source.questions, source.assets);
    const committed = await get(db, "instructorCollections", key);
    bad.records[0].questionFingerprint = pkg.records[0].questionFingerprint;
    bad.records[0].blocks[0] = {
      ...bad.records[0].blocks[0],
      text: "same-version changed",
    } as any;
    await expect(
      repo.import("me", "demo", bad, source.questions, source.assets),
    ).rejects.toThrow("버전");
    expect(await get(db, "instructorCollections", key)).toEqual(committed);
    db.close();
    await repo.close();
  });
  it("aborts both writes if another tab changes legacy data after preview snapshot", async () => {
    const factory = new IDBFactory(),
      name = crypto.randomUUID(),
      first = new InstructorRepository(factory, name),
      second = new InstructorRepository(factory, name);
    let release!: () => void, captured!: () => void;
    const paused = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        captured = resolve;
      });
    const snapshot = (first as any).snapshot.bind(first);
    (first as any).snapshot = async (...args: unknown[]) => {
      const value = await snapshot(...args);
      captured();
      await paused;
      return value;
    };
    const pending = first.import(
      "me",
      "demo",
      pkg,
      source.questions,
      source.assets,
    );
    await ready;
    const secondPackage = structuredClone(pkg);
    secondPackage.packageId = "second-tab";
    await second.import(
      "me",
      "demo",
      secondPackage,
      source.questions,
      source.assets,
    );
    release();
    await expect(pending).rejects.toThrow("다른 창");
    const result = await second.read("me", "demo");
    expect(result.packages.map((p) => p.packageId)).toEqual(["second-tab"]);
    await first.close();
    await second.close();
  });
});
