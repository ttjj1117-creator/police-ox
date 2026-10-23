import { describe, expect, it, vi } from "vitest";
import { demoData, emptyData } from "../src/original/demo";
import { areas, exportOriginalPackages, isEligible, mappingReport, previewMerge, units, validatePackage } from "../src/original/validation";
import type { Asset, OriginalPackage, Question } from "../src/original/model";

function realPackage(): OriginalPackage {
  const p = structuredClone(demoData().packages[0]);
  p.packageId = "po_2026_2_const";
  p.dataKind = "real";
  p.questions = p.questions.filter((q) => q.subjectId === "constitution").slice(0, 2);
  for (const q of p.questions) {
    q.id = `const_2026_2_${q.source.questionNumber}`;
    q.source = { ...q.source, examCode: "po", round: "2", examName: "시험지 대조용 테스트 픽스처", questionPdf: { fileName: "test-question.pdf", pages: [1] }, answerPdf: { fileName: "test-answer.pdf", pages: [1], subjectColumn: "헌법" } };
    q.officialAnswer.status = "final";
  }
  return p;
}
async function pngAsset(): Promise<Asset> {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQsUn5DwAC0AG0vqck9wAAAABJRU5ErkJggg==";
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((n) => n.toString(16).padStart(2, "0")).join("");
  return { assetId: "test_png", mimeType: "image/png", base64, sha256: hash };
}
describe("original contract registry and exact structural validation", () => {
  it("registers 80 study groups plus two placeholders without replacing the 685 book nodes", () => {
    expect(units).toHaveLength(82);
    expect(mappingReport).toMatchObject({ bookNodeCount: 685, unitCount: 80, pendingAreaCount: 2, referenceCount: 145, pending: [] });
    expect(areas.map((a) => a.targetQuestions).reduce((n, v) => n + v, 0)).toBe(100);
  });
  it("accepts empty original package, demo only in its own namespace and never fabricates OX judgments", async () => {
    const p = { ...realPackage(), questions: [] };
    expect((await previewMerge(emptyData(), p, "real")).added).toBe(0);
    const demo = demoData().packages[0];
    expect((await validatePackage(demo, "demo")).questions).toHaveLength(100);
    await expect(validatePackage(demo, "real")).rejects.toThrow("dataKind");
    expect(demo.questions[0]).not.toHaveProperty("judgments");
  });
  it.each([
    ["format", (p: any) => { p.format = "unknown"; }],
    ["schemaVersion", (p: any) => { p.schemaVersion = 1; }],
    ["extra fields", (p: any) => { p.questions[0].rawQuestionText = "not allowed"; }],
    ["three choices", (p: any) => { p.questions[0].choices.pop(); }],
    ["duplicate choices", (p: any) => { p.questions[0].choices[2].number = 2; }],
    ["choice order", (p: any) => { p.questions[0].choices.reverse(); }],
    ["single empty", (p: any) => { p.questions[0].officialAnswer.acceptedChoices = []; }],
    ["single two", (p: any) => { p.questions[0].officialAnswer.acceptedChoices = [1, 2]; }],
    ["multiple one", (p: any) => { p.questions[0].officialAnswer.kind = "multiple"; }],
    ["choice out of range", (p: any) => { p.questions[0].officialAnswer.acceptedChoices = [5]; }],
    ["duplicate accepted", (p: any) => { p.questions[0].officialAnswer = { status: "final", kind: "multiple", acceptedChoices: [1, 1] }; }],
    ["unsorted accepted", (p: any) => { p.questions[0].officialAnswer = { status: "final", kind: "multiple", acceptedChoices: [3, 1] }; }],
    ["special accepted", (p: any) => { p.questions[0].officialAnswer.kind = "excluded"; }],
    ["invalid timestamp", (p: any) => { p.exportedAt = "2026-02-30T12:00:00Z"; }],
    ["timezone absent", (p: any) => { p.exportedAt = "2026-10-21T12:00:00"; }],
    ["hour 24", (p: any) => { p.exportedAt = "2026-10-21T24:00:00Z"; }],
    ["minute 60", (p: any) => { p.exportedAt = "2026-10-21T12:60:00Z"; }],
    ["second 60", (p: any) => { p.exportedAt = "2026-10-21T12:00:60Z"; }],
    ["offset hour 24", (p: any) => { p.exportedAt = "2026-10-21T12:00:00+24:00"; }],
    ["offset minute 60", (p: any) => { p.exportedAt = "2026-10-21T12:00:00+09:60"; }],
    ["fractional revision", (p: any) => { p.questions[0].revision = 1.1; }],
  ])("rejects %s", async (_label, mutate) => {
    const p = realPackage(); mutate(p);
    await expect(validatePackage(p, "real")).rejects.toThrow();
  });
});
describe("original semantic validation", () => {
  it.each([
    ["calculated ID", (q: Question) => { q.source.questionNumber = 8; }],
    ["grading exceeds revision", (q: Question) => { q.gradingRevision = 2; }],
    ["wrong study subject", (q: Question) => { q.classification!.studyUnitCode = "POL-01"; }],
    ["wrong blueprint subject", (q: Question) => { q.classification!.blueprintAreaCode = "CRIM-INV"; }],
    ["unknown code", (q: Question) => { q.classification!.studyUnitCode = "CONST-999"; }],
    ["unknown book", (q: Question) => { q.classification!.bookUnitIds = ["missing-uuid"]; }],
    ["study confirmed null", (q: Question) => { q.classification!.studyUnitCode = null; }],
    ["blueprint confirmed null", (q: Question) => { q.classification!.blueprintAreaCode = null; }],
    ["primary as related", (q: Question) => { q.classification!.relatedStudyUnitCodes = [q.classification!.studyUnitCode!]; }],
    ["wrong final answer column", (q: Question) => { q.source.answerPdf!.subjectColumn = "형사법"; }],
    ["no answer evidence", (q: Question) => { q.source.answerPdf = null; }],
    ["no text evidence", (q: Question) => { q.source.questionPdf = null; }],
    ["blank exam name", (q: Question) => { q.source.examName = " \t "; }],
    ["blank question filename", (q: Question) => { q.source.questionPdf!.fileName = "   "; }],
    ["blank answer filename", (q: Question) => { q.source.answerPdf!.fileName = "   "; }],
    ["blank answer subject column", (q: Question) => { q.source.answerPdf!.subjectColumn = "   "; }],
    ["provisional checked", (q: Question) => { q.officialAnswer.status = "provisional"; }],
    ["demo in real", (q: Question) => { q.source.examCode = "demo"; q.id = "demo_const_1"; }],
    ["missing asset", (q: Question) => { q.body.push({ type: "image", assetId: "missing", alt: "원본 그림" }); }],
  ])("rejects %s with error path", async (_label, mutate) => {
    const p = realPackage(); mutate(p.questions[0]);
    await expect(validatePackage(p, "real")).rejects.toThrow(/questions\./);
  });
  it("accepts valid offset timestamps and preserves source text without trimming", async () => {
    const p = realPackage(); p.exportedAt = "2024-02-29T23:59:59.123456+09:00";
    p.questions[0].source.questionPdf!.fileName = " question.pdf ";
    p.questions[0].source.examName = " test exam ";
    const validated = await validatePackage(p, "real");
    expect(validated.exportedAt).toBe(p.exportedAt);
    expect(validated.questions[0].source).toEqual(p.questions[0].source);
  });
  it("allows pending/extracted and special dispositions for storage but keeps them out of actual practice", async () => {
    const p = realPackage();
    p.stage = "extracted";
    p.questions.forEach((q) => { q.classification = null; });
    expect(isEligible((await validatePackage(p, "real")).questions[0], "real")).toBe(true);
    p.questions[0].qa.answerStatus = "pending";
    p.questions[0].officialAnswer.status = "missing";
    expect(isEligible((await validatePackage(p, "real")).questions[0], "real")).toBe(false);
    p.questions[1].officialAnswer = { status: "final", kind: "all_correct", acceptedChoices: [] };
    expect(isEligible((await validatePackage(p, "real")).questions[1], "real")).toBe(false);
    p.questions[0].classification = realPackage().questions[0].classification;
    await expect(validatePackage(p, "real")).rejects.toThrow("extracted");
  });
  it("applies all conditional answer-kind Schema branches without altering their accepted choices", async () => {
    for (const [kind, acceptedChoices] of [["single", [2]], ["multiple", [1, 2, 3, 4]], ["all_correct", []], ["excluded", []], ["unresolved", []]] as const) {
      const p = realPackage();
      p.questions[0].officialAnswer = { status: "final", kind, acceptedChoices: [...acceptedChoices] };
      if (kind === "unresolved") p.questions[0].qa.answerStatus = "pending";
      expect((await validatePackage(p, "real")).questions[0].officialAnswer).toEqual(p.questions[0].officialAnswer);
    }
  });
  it("verifies embedded raster MIME, hash, duplication and references", async () => {
    const p = realPackage(); const asset = await pngAsset();
    p.assets = [structuredClone(asset)]; p.questions[0].body.push({ type: "image", assetId: asset.assetId, alt: "테스트 그림" });
    await expect(validatePackage(p, "real")).resolves.toBeDefined();
    p.assets[0].sha256 = "0".repeat(64);
    await expect(validatePackage(p, "real")).rejects.toThrow("SHA-256");
    p.assets = [{ ...asset, mimeType: "image/jpeg" }];
    await expect(validatePackage(p, "real")).rejects.toThrow("MIME");
    p.assets = [asset, asset];
    await expect(validatePackage(p, "real")).rejects.toThrow("중복 assetId");
  });
  it("checks browser raster decoding and releases decoded images", async () => {
    const p = realPackage(); p.assets = [await pngAsset()];
    const close = vi.fn();
    const decode = vi.fn().mockResolvedValue({ close });
    vi.stubGlobal("createImageBitmap", decode);
    try {
      await expect(validatePackage(p, "real")).resolves.toBeDefined();
      expect(close).toHaveBeenCalledOnce();
      decode.mockRejectedValueOnce(new Error("undecodable raster"));
      await expect(validatePackage(p, "real")).rejects.toThrow("assets.0: 그림 파일을 읽을 수 없습니다");
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects over-20-MiB input before applying anything", async () => {
    const p = realPackage(); p.questions[0].qa.notes = ["x".repeat(20 * 1024 * 1024)];
    await expect(validatePackage(p, "real")).rejects.toThrow("20 MiB");
  });
  it("validates a larger aggregate backup while retaining the import-file cap", async () => {
    const p = realPackage(); p.questions[0].qa.notes = ["x".repeat(20 * 1024 * 1024)];
    expect((await validatePackage(p, "real", { allowLargeCollection: true })).questions).toHaveLength(2);
    p.questions[0].choices.reverse();
    await expect(validatePackage(p, "real", { allowLargeCollection: true })).rejects.toThrow("choices");
  });
});
describe("original transactional merge planning", () => {
  it("is idempotent, ignores export timestamp for package conflicts and preserves omitted IDs", async () => {
    const p = realPackage(); const first = await previewMerge(emptyData(), p, "real");
    expect(first).toMatchObject({ added: 2, unchanged: 0 });
    p.exportedAt = "2026-10-21T01:00:00Z";
    expect(await previewMerge(first.data, p, "real")).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    p.packageVersion++; p.questions.pop();
    expect((await previewMerge(first.data, p, "real")).data.questions).toHaveLength(2);
    expect(first.data.questions).toHaveLength(2);
  });
  it("merges another package by question ID, rejects same revision edits and version rollback", async () => {
    const p = realPackage(); const data = (await previewMerge(emptyData(), p, "real")).data;
    p.packageId = "another_package"; p.questions[0].qa.notes = ["changed"];
    await expect(previewMerge(data, p, "real")).rejects.toThrow("revision");
    p.questions[0].revision = 2;
    expect(await previewMerge(data, p, "real")).toMatchObject({ updated: 1, unchanged: 1 });
    const p2 = realPackage(); p2.packageVersion = 2;
    const data2 = (await previewMerge(data, p2, "real")).data;
    await expect(previewMerge(data2, realPackage(), "real")).rejects.toThrow("packageVersion");
  });
  it("requires grading revision on content/answer changes but permits classification-only revisions", async () => {
    const p = realPackage(); const data = (await previewMerge(emptyData(), p, "real")).data;
    p.packageVersion++; p.questions[0].revision++;
    p.questions[0].classification!.studyUnitCode = "CONST-02";
    const classified = await previewMerge(data, p, "real");
    expect(classified.data.questions[0].gradingRevision).toBe(1);
    p.questions[0].body = [{ type: "text", text: "본문 수정" }];
    await expect(previewMerge(data, p, "real")).rejects.toThrow("gradingRevision");
    p.questions[0].gradingRevision++;
    expect((await previewMerge(data, p, "real")).updated).toBe(1);
  });
  it("rejects all of a partially invalid package and does not mutate the old aggregate", async () => {
    const p = realPackage(); const data = (await previewMerge(emptyData(), p, "real")).data;
    const before = JSON.stringify(data); p.packageVersion++; p.questions[1].id = "const_2026_2_9";
    await expect(previewMerge(data, p, "real")).rejects.toThrow(".id");
    expect(JSON.stringify(data)).toBe(before);
    p.questions[1].id = p.questions[0].id;
    await expect(validatePackage(p, "real")).rejects.toThrow("중복");
  });
});
describe("current problem-only exports", () => {
  it("exports current revisions from overlapping source packages and reimports without downgrade", async () => {
    const first = realPackage(); first.packageId = "source_a";
    let data = (await previewMerge(emptyData(), first, "real")).data;
    const second = structuredClone(first); second.packageId = "source_b";
    second.questions[0].revision = 2; second.questions[0].qa.notes = ["revision two"];
    data = (await previewMerge(data, second, "real")).data;
    first.packageVersion = 2; first.questions[0].revision = 3; first.questions[0].qa.notes = ["revision three"];
    data = (await previewMerge(data, first, "real")).data;
    const before = JSON.stringify(data);
    const exported = exportOriginalPackages(data, "real");
    let restored = emptyData();
    for (const pkg of exported) restored = (await previewMerge(restored, pkg, "real")).data;
    expect(restored.questions).toEqual(data.questions);
    expect(restored.questions[0].revision).toBe(3);
    expect(JSON.stringify(data)).toBe(before);
    expect(exported[0].packageId).not.toBe(exportOriginalPackages(data, "real")[0].packageId);
  });
  it("splits larger aggregates into self-contained importable files <=20MiB", async () => {
    const p = realPackage();
    p.questions.forEach((q) => { q.qa.notes = ["x".repeat(11 * 1024 * 1024)]; });
    const data = { questions: p.questions, assets: [], packages: [] };
    const exported = exportOriginalPackages(data, "real");
    expect(exported).toHaveLength(2);
    let restored = emptyData();
    for (const pkg of exported) {
      expect(new TextEncoder().encode(JSON.stringify(pkg)).byteLength).toBeLessThanOrEqual(20 * 1024 * 1024);
      restored = (await previewMerge(restored, pkg, "real")).data;
    }
    expect(restored.questions).toEqual(p.questions);
  });
  it("keeps referenced and unused assets and exports an empty contract when no data exists", async () => {
    const p = realPackage(); const asset = await pngAsset();
    p.assets = [asset, { ...asset, assetId: "unused_png" }];
    p.questions[0].body.push({ type: "image", assetId: asset.assetId, alt: "그림" });
    const exported = exportOriginalPackages({ questions: p.questions, assets: p.assets, packages: [] }, "real");
    expect((await validatePackage(exported[0], "real")).assets).toHaveLength(2);
    expect(exportOriginalPackages(emptyData(), "real")).toHaveLength(1);
    expect((await validatePackage(exportOriginalPackages(emptyData(), "real")[0], "real")).questions).toEqual([]);
  });
});
