import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import type { OriginalPackage } from "../src/original/model";
import {
  explanationIndex,
  mergeExplanationPackages,
  parseExplanationPackage,
  questionFingerprint,
  targetText,
  validateExplanationPackage,
  type ExplanationPackage,
} from "../src/original/explanations/contract";
import {
  frequencyAnalysis,
  resolveExplanations,
  emptyFrequencyFilter,
} from "../src/original/explanations/analysis";
import { ExplanationRepository } from "../src/original/explanations/library";
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve("tests/fixtures/explanations", name), "utf8"),
  );
let source: OriginalPackage, pkg: ExplanationPackage;
beforeEach(() => {
  source = fixture("questions.demo.json");
  pkg = fixture("valid.demo.json");
});
const validate = () =>
  validateExplanationPackage(pkg, "demo", source.questions, source.assets);
describe("explanation data and source binding", () => {
  it("accepts neutral choice/individual statement/multi-basis data without changing source or verification", async () => {
    const before = JSON.stringify(source);
    expect(await validate()).toEqual(pkg);
    expect(JSON.stringify(source)).toBe(before);
    expect(pkg.explanations.at(-1)?.verification.status).toBe("hold");
    expect(targetText(source.questions[0], pkg.explanations[1].selector)).toBe(
      pkg.explanations[1].expectedText,
    );
  });
  it.each(["bases", "issues", "explanations"] as const)(
    "rejects duplicate IDs in %s",
    (name) => {
      (pkg[name] as any[]).push(structuredClone(pkg[name][0]));
      expect(() => parseExplanationPackage(pkg)).toThrow("중복 ID");
    },
  );
  it("validates choice number, block kind, entry offset and label rather than array position", () => {
    const q = source.questions[0],
      choice = q.choices[0];
    q.choices.reverse();
    expect(targetText(q, { kind: "choice", number: choice.number })).toBe(
      choice.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
    );
    expect(() =>
      targetText(q, {
        kind: "entry",
        area: "body",
        choiceNumber: null,
        blockIndex: 1,
        entryIndex: 0,
        label: "㉡",
      }),
    ).toThrow("label");
    expect(() =>
      targetText(q, {
        kind: "block",
        area: "body",
        choiceNumber: null,
        blockIndex: 1,
      }),
    ).toThrow("text");
    expect(() =>
      targetText(q, {
        kind: "block",
        area: "choice",
        choiceNumber: null,
        blockIndex: 0,
      }),
    ).toThrow("choiceNumber");
  });
  it("rejects broken question, basis, issue and cross-basis references atomically", async () => {
    for (const mutate of [
      (p: ExplanationPackage) => {
        p.explanations[0].questionId = "missing";
        p.scope.questionIds.push("missing");
      },
      (p: ExplanationPackage) => {
        p.explanations[0].references[0].basisId = "missing";
      },
      (p: ExplanationPackage) => {
        p.explanations[0].references[0].issueIds = ["missing"];
      },
      (p: ExplanationPackage) => {
        p.explanations[0].references[0].issueIds = ["demo-issue-B1"];
      },
    ]) {
      const copy = structuredClone(pkg);
      mutate(copy);
      await expect(
        validateExplanationPackage(
          copy,
          "demo",
          source.questions,
          source.assets,
        ),
      ).rejects.toThrow();
    }
  });
  it("rejects subject, namespace, source text and content signature mismatches", async () => {
    await expect(
      validateExplanationPackage(pkg, "real", source.questions, source.assets),
    ).rejects.toThrow("영역");
    pkg.explanations[0].expectedText += " changed";
    await expect(validate()).rejects.toThrow("문자열");
    pkg = fixture("stale-version.demo.json");
    await expect(validate()).rejects.toThrow("지문값");
    pkg = fixture("valid.demo.json");
    pkg.explanations[0].subjectId = "criminal";
    pkg.scope.subjectIds.push("criminal");
    await expect(validate()).rejects.toThrow("과목");
  });
  it("rejects unsafe URLs, invalid calendar dates and unrecorded verified status", () => {
    for (const change of [
      (p: ExplanationPackage) => {
        p.bases[0].sourceUrl = "javascript:alert(1)";
      },
      (p: ExplanationPackage) => {
        p.bases[0].asOfDate = "2026-02-30";
      },
      (p: ExplanationPackage) => {
        p.explanations[0].verification.checkedAt = null;
      },
      (p: ExplanationPackage) => {
        p.explanations[0].verification.note = "";
      },
    ]) {
      const copy = structuredClone(pkg);
      change(copy);
      expect(() => parseExplanationPackage(copy)).toThrow();
    }
  });
  it("requires verified reference records without promoting drafts", async () => {
    pkg.bases[0].verification.status = "draft";
    await expect(validate()).rejects.toThrow("검증 기록");
    pkg = fixture("valid.demo.json");
    pkg.explanations[0].verification.status = "draft";
    const validated = await validate();
    expect(validated.explanations[0].verification.status).toBe("draft");
  });
  it("classification-only revision changes stay matched; source or grading changes become stale", async () => {
    const q = structuredClone(source.questions[0]),
      hash = await questionFingerprint(q, source.assets);
    q.revision++;
    q.classification!.studyUnitCode = null;
    q.qa.notes.push("분류만 갱신");
    expect(await questionFingerprint(q, source.assets)).toBe(hash);
    expect(
      (await resolveExplanations(q, [pkg], source.assets)).every(
        (e) => e.status === "verified",
      ),
    ).toBe(true);
    q.body[0] = { type: "text", text: "변경된 중립 문장" };
    expect(
      (await resolveExplanations(q, [pkg], source.assets)).every(
        (e) => e.status === "stale",
      ),
    ).toBe(true);
    const g = structuredClone(source.questions[0]);
    g.gradingRevision++;
    expect(
      (await resolveExplanations(g, [pkg], source.assets)).every(
        (e) => e.status === "stale",
      ),
    ).toBe(true);
  });
  it("same package import is idempotent; replacement requires both package/entity versions", () => {
    expect(mergeExplanationPackages([pkg], pkg)).toHaveLength(1);
    const changed = structuredClone(pkg);
    changed.explanations[0].explanation = "변경된 중립 설명";
    expect(() => mergeExplanationPackages([pkg], changed)).toThrow(
      "패키지 버전",
    );
    changed.packageVersion++;
    expect(() => mergeExplanationPackages([pkg], changed)).toThrow("revision");
    changed.explanations[0].revision++;
    expect(mergeExplanationPackages([pkg], changed)[0]).toEqual(changed);
  });
  it("reports distinct IDs with identical authority/number/date and never auto-merges", () => {
    pkg.bases.push({ ...structuredClone(pkg.bases[0]), id: "duplicate-basis" });
    expect(() => explanationIndex([pkg])).toThrow("동일 식별정보");
  });
  it("rejects overlapping whole-choice and inner-block targets rather than double counting", async () => {
    const e = structuredClone(pkg.explanations[0]);
    e.id = "demo-overlap-target";
    e.selector = {
      kind: "block",
      area: "choice",
      choiceNumber: 1,
      blockIndex: 0,
    };
    pkg.explanations.push(e);
    await expect(validate()).rejects.toThrow("겹쳐");
  });
});
describe("frequency is a source/target union, not learning repetition", () => {
  it("deduplicates repeated links, multiple issues and overlapping packages", async () => {
    const duplicate = { ...structuredClone(pkg), packageId: "demo-overlap" };
    const r = await frequencyAnalysis(
      source.questions,
      source.assets,
      [pkg, duplicate],
      "demo",
    );
    const basis = r.rows.find(
      (r) => r.kind === "basis" && r.id === "demo-basis-A",
    )!;
    expect([
      basis.targets,
      basis.questions,
      basis.rounds,
      basis.latest,
    ]).toEqual([4, 2, 2, "2026년 1차"]);
    const issue = r.rows.find((r) => r.id === "demo-issue-A2")!;
    expect([issue.targets, issue.questions]).toEqual([2, 1]);
    expect(r.covered).toBe(2);
    expect(r.pending).toBe(2);
    expect(
      (await frequencyAnalysis(source.questions, source.assets, [pkg], "demo"))
        .rows,
    ).toEqual(r.rows);
  });
  it("deduplicates and reports identical original sources registered under other IDs", async () => {
    const q = {
      ...structuredClone(source.questions[0]),
      id: "demo_duplicate_internal_id",
    };
    const copy = structuredClone(pkg);
    for (const e of pkg.explanations.filter(
      (e) => e.questionId === source.questions[0].id,
    ))
      copy.explanations.push({
        ...structuredClone(e),
        id: e.id + "-duplicate",
        questionId: q.id,
      });
    copy.scope.questionIds.push(q.id);
    const r = await frequencyAnalysis(
      [...source.questions, q],
      source.assets,
      [copy],
      "demo",
    );
    expect(r.duplicates[0].conflict).toBe(false);
    expect(r.rows.find((r) => r.id === "demo-basis-A")?.targets).toBe(4);
    expect(r.total).toBe(100);
  });
  it("excludes conflicting source duplicates and stale/deleted/retired/unverified records", async () => {
    const q = {
      ...structuredClone(source.questions[0]),
      id: "demo_duplicate_internal_id",
      body: [{ type: "text" as const, text: "다른 내용" }],
    };
    let r = await frequencyAnalysis(
      [...source.questions, q],
      source.assets,
      [pkg],
      "demo",
    );
    expect(r.ambiguous).toBe(1);
    expect(r.rows.find((r) => r.id === "demo-basis-A")?.questions).toBe(1);
    r = await frequencyAnalysis(
      source.questions,
      source.assets,
      [pkg],
      "demo",
      [source.questions[0].id],
    );
    expect(r.rows.find((r) => r.id === "demo-basis-A")?.targets).toBe(1);
    source.questions[1].lifecycle = "retired";
    r = await frequencyAnalysis(
      source.questions,
      source.assets,
      [pkg],
      "demo",
      [source.questions[0].id],
    );
    expect(r.rows).toHaveLength(0);
  });
  it("separates real/demo and scope filters; empty libraries are valid", async () => {
    expect(
      (await frequencyAnalysis(source.questions, source.assets, [pkg], "real"))
        .total,
    ).toBe(0);
    const r = await frequencyAnalysis(
      source.questions,
      source.assets,
      [pkg],
      "demo",
      [],
      { ...emptyFrequencyFilter, year: "2025" },
    );
    expect(r.covered).toBe(1);
    expect(r.rows.find((r) => r.id === "demo-basis-A")?.rounds).toBe(1);
    expect(
      (await frequencyAnalysis(source.questions, source.assets, [], "demo"))
        .rows,
    ).toEqual([]);
  });
});
describe("independent local explanation store", () => {
  it("isolates owner/namespace, preserves source, restores offline and rejects invalid replacement without partial writes", async () => {
    const factory = new IDBFactory(),
      repo = new ExplanationRepository(factory, "test-explanations"),
      before = JSON.stringify(source);
    await repo.import("owner-a", "demo", pkg, source.questions, source.assets);
    await repo.import("owner-a", "demo", pkg, source.questions, source.assets);
    expect((await repo.read("owner-a", "demo")).packages).toHaveLength(1);
    expect((await repo.read("owner-b", "demo")).packages).toEqual([]);
    expect((await repo.read("owner-a", "real")).packages).toEqual([]);
    const invalid = fixture("invalid-reference.demo.json");
    await expect(
      repo.import("owner-a", "demo", invalid, source.questions, source.assets),
    ).rejects.toThrow();
    expect(
      (
        await new ExplanationRepository(factory, "test-explanations").read(
          "owner-a",
          "demo",
        )
      ).packages,
    ).toEqual([pkg]);
    expect(JSON.stringify(source)).toBe(before);
    const updated = structuredClone(pkg);
    updated.packageVersion++;
    updated.explanations[0].revision++;
    updated.explanations[0].explanation = "갱신한 중립 시연 설명";
    await repo.import(
      "owner-a",
      "demo",
      updated,
      source.questions,
      source.assets,
    );
    await expect(
      repo.import("owner-a", "demo", pkg, source.questions, source.assets),
    ).rejects.toThrow("버전");
    expect((await repo.read("owner-a", "demo")).packages).toEqual([updated]);
  });
});
