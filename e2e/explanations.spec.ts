import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const fixture = (name: string) => resolve("tests/fixtures/explanations", name);
async function setup(p: Page) {
  await p.goto("/?view=original&mode=demo");
  await p.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await p
    .getByLabel("문제 JSON 가져오기", { exact: true })
    .setInputFiles(fixture("questions.demo.json"));
  await p.getByRole("button", { name: "확인하고 적용", exact: true }).click();
  await expect(
    p.getByText("검증한 데이터를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await p
    .getByLabel("해설 JSON 가져오기", { exact: true })
    .setInputFiles(fixture("valid.demo.json"));
  await p
    .getByRole("button", { name: "해설 확인하고 적용", exact: true })
    .click();
  await expect(
    p.getByText("검증한 해설 자료를 저장했습니다.", { exact: true }),
  ).toBeVisible();
}
test("해설 가져오기·재가져오기·잘못된 참조 거부·내보내기와 출제 빈도 합집합을 확인한다", async ({
  page: p,
}) => {
  await setup(p);
  await p
    .getByLabel("해설 JSON 가져오기", { exact: true })
    .setInputFiles(fixture("valid.demo.json"));
  await p
    .getByRole("button", { name: "해설 확인하고 적용", exact: true })
    .click();
  await expect(
    p.getByRole("button", { name: "해설 자료 내보내기", exact: true }),
  ).toHaveCount(1);
  await p
    .getByLabel("해설 JSON 가져오기", { exact: true })
    .setInputFiles(fixture("invalid-reference.demo.json"));
  await expect(p.getByText(/잘못된 쟁점 참조/)).toBeVisible();
  await expect(
    p.getByRole("button", { name: "해설 확인하고 적용", exact: true }),
  ).toHaveCount(0);
  const download = p.waitForEvent("download");
  await p
    .getByRole("button", { name: "해설 자료 내보내기", exact: true })
    .click();
  expect(
    JSON.parse(readFileSync((await (await download).path())!, "utf8"))
      .explanations,
  ).toHaveLength(6);
  await p.getByRole("button", { name: "근거·출제 빈도", exact: true }).click();
  const row = p.getByRole("row").filter({ hasText: "중립 도형 안내 A" });
  await expect(row).toBeVisible();
  const cells = await row.getByRole("cell").allTextContents();
  expect(cells.slice(1, 5)).toEqual(["2", "2", "4", "2026년 1차"]);
  await expect(p.locator(".frequency-coverage")).toContainText(
    "검증 연결 문항 2개 (2%)",
  );
  await p.getByRole("button", { name: "쟁점별", exact: true }).click();
  const issue = p.getByRole("row").filter({ hasText: "색깔 확인" });
  expect((await issue.getByRole("cell").allTextContents()).slice(1, 4)).toEqual(
    ["1", "1", "2"],
  );
  await p.reload();
  await p.getByRole("button", { name: "근거·출제 빈도", exact: true }).click();
  await expect(p.locator(".frequency-coverage")).toContainText(
    "검증 연결 문항 2개",
  );
});
test("제출 후만 등록된 해설·발췌를 오프라인 열람하고 관련 기출 이동·필기 배치를 보존한다", async ({
  page: p,
  context,
}) => {
  await setup(p);
  await p.getByRole("button", { name: "근거·출제 빈도", exact: true }).click();
  await p
    .getByRole("row")
    .filter({ hasText: "중립 도형 안내 A" })
    .getByRole("button")
    .click();
  await p
    .getByRole("button", { name: "이 기출 풀기", exact: true })
    .first()
    .click();
  await expect(p.locator(".explanation-panel")).toHaveCount(0);
  const paper = p.locator('.ink-surface[data-ink-surface="paper"]');
  await expect(paper).toHaveAttribute("data-ink-ready", "true");
  const b = (await paper.boundingBox())!,
    e = {
      pointerId: 10,
      pointerType: "pen",
      clientX: b.x + 180,
      clientY: b.y + 25,
      buttons: 1,
      button: 0,
      pressure: 0.5,
      bubbles: true,
    };
  await paper.dispatchEvent("pointerdown", e);
  await paper.dispatchEvent("pointerup", {
    ...e,
    clientX: b.x + 250,
    buttons: 0,
  });
  await expect(paper.locator("g[data-ink-stroke]")).toHaveCount(1);
  await p.getByRole("button", { name: "2번 선택", exact: true }).click();
  await p.getByRole("button", { name: "답 제출", exact: true }).click();
  const before = await paper.boundingBox(),
    path = await paper.locator("g path").getAttribute("d");
  const network: string[] = [];
  p.on("request", (r) => network.push(r.url()));
  await context.setOffline(true);
  await p.locator(".explanation-panel > summary").click();
  await expect(
    p
      .getByText(
        "도형의 이름·색깔을 읽는 중립 시연 설명입니다. 실제 기출 해설이나 법률 판단이 아닙니다.",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(
    p.locator(".explanation-panel blockquote").first(),
  ).toContainText("시연 도형");
  await expect(
    p.locator(".explanation-entry").first().locator(".explanation-basis"),
  ).toHaveCount(1);
  await expect(paper.locator("g path")).toHaveAttribute("d", path!);
  const after = await paper.boundingBox();
  expect(after!.width).toBe(before!.width);
  expect(after!.height).toBe(before!.height);
  expect(
    network.filter((u) =>
      /openai|chatgpt|supabase|explanations.*json/i.test(u),
    ),
  ).toEqual([]);
  await context.setOffline(false);
  await p.getByRole("button", { name: "학습 종료", exact: true }).click();
  await p.getByRole("button", { name: "학습 종료 확정", exact: true }).click();
  await expect(
    p.getByRole("heading", { name: "학습 결과", exact: true }),
  ).toBeVisible();
});
test("모의고사 중 해설·근거 분석을 숨기고 종료 후 같은 스냅샷의 해설을 제공한다", async ({
  page: p,
}) => {
  await setup(p);
  await p.getByRole("button", { name: "모의고사", exact: true }).click();
  await p.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(p.locator(".explanation-panel")).toHaveCount(0);
  await p.getByRole("button", { name: "메뉴", exact: true }).click();
  await p.getByRole("button", { name: "학습 홈", exact: true }).click();
  await p.getByRole("button", { name: "근거·출제 빈도", exact: true }).click();
  await expect(
    p.getByText(
      "진행 중인 모의고사의 근거·해설은 제출 뒤 확인할 수 있습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(p.locator(".frequency-table")).toHaveCount(0);
  await p
    .getByRole("button", { name: "진행 중 시험 이어 풀기", exact: true })
    .click();
  await p.getByRole("button", { name: "시험 제출", exact: true }).click();
  await p.getByRole("button", { name: "시험 제출 확정", exact: true }).click();
  await expect(
    p.getByRole("heading", { name: "학습 결과", exact: true }),
  ).toBeVisible();
  await expect(p.locator(".explanation-panel")).toHaveCount(100);
  const item = p
    .locator(".original-result-list > details")
    .filter({
      has: p.getByText(
        "기능 확인용 예시 1 · 실제 기출이나 법률 문제가 아닙니다.",
        { exact: false },
      ),
    })
    .first();
  await item.locator(":scope > summary").click();
  await item.locator(".explanation-panel > summary").click();
  await expect(
    item.locator('[data-explanation-status="verified"]'),
  ).toHaveCount(3);
});
test("해설 없는 실제 영역은 비어 있는 상태를 지원하고 시연 해설을 섞지 않는다", async ({
  page: p,
}) => {
  await setup(p);
  await p.getByLabel("저장 영역", { exact: true }).selectOption("real");
  await p.getByRole("button", { name: "근거·출제 빈도", exact: true }).click();
  await expect(p.locator(".frequency-coverage")).toContainText(
    "집계 대상 원본 0문항",
  );
  await p.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await expect(
    p.getByText(
      "등록된 해설 자료가 없습니다. 해설 없이도 기존 문제 풀이·채점은 사용할 수 있습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    p.getByRole("button", { name: "해설 자료 내보내기", exact: true }),
  ).toHaveCount(0);
});

async function storedWithoutExplanations(p: Page, namespace: string) {
  return p.evaluate(
    (ns) =>
      new Promise<any>((resolveValue, reject) => {
        const r = indexedDB.open("police-ox-storage", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const get = db
            .transaction("states")
            .objectStore("states")
            .get(`original:${ns}`);
          get.onsuccess = () => {
            resolveValue(get.result.state);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
    namespace,
  );
}

for (const namespace of ["demo", "real"] as const) {
  test(`${namespace}: 해설 미등록에서도 가져오기·오답·필기·재실행·종료·다시 풀기가 정상이다`, async ({
    page: p,
  }) => {
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.goto(`/?view=original&mode=${namespace}`);
    await p.getByRole("button", { name: "데이터·설정", exact: true }).click();
    const data = JSON.parse(
      readFileSync(fixture("questions.demo.json"), "utf8"),
    );
    data.questions = data.questions.slice(0, 1);
    if (namespace === "real") {
      data.dataKind = "real";
      data.packageId = "TEST_ONLY_no_explanations";
      const q = data.questions[0];
      q.id = "const_2026_1_1";
      q.source = {
        ...q.source,
        examCode: "po",
        examName: "TEST ONLY 중립 검증 — 실제 기출 아님",
        questionPdf: { fileName: "TEST_ONLY.pdf", pages: [1] },
        answerPdf: {
          fileName: "TEST_ONLY_answer.pdf",
          pages: [1],
          subjectColumn: "헌법",
        },
      };
      q.officialAnswer.status = "final";
    }
    await p.getByLabel("문제 JSON 가져오기", { exact: true }).setInputFiles({
      name: "TEST_ONLY_no_explanations.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(data)),
    });
    await p.getByRole("button", { name: "확인하고 적용", exact: true }).click();
    await expect(
      p.getByText("검증한 데이터를 저장했습니다.", { exact: true }),
    ).toBeVisible();
    await expect(
      p.getByRole("button", { name: "해설 자료 내보내기", exact: true }),
    ).toHaveCount(0);
    await p
      .getByRole("button", { name: "근거·출제 빈도", exact: true })
      .click();
    await expect(p.getByText(/분석 자료 미등록/)).toBeVisible();
    await expect(p.locator(".frequency-coverage")).toContainText(
      "검증 연결 문항 0개 (0%)",
    );
    await p.getByRole("button", { name: "일반 학습", exact: true }).click();
    await p.getByRole("button", { name: "시작하기", exact: true }).click();
    const paper = p.locator('[data-ink-surface="paper"]');
    await expect(paper).toHaveAttribute("data-ink-ready", "true");
    const box = (await paper.boundingBox())!;
    const pen = {
      pointerId: 51,
      pointerType: "pen",
      clientX: box.x + 180,
      clientY: box.y + 25,
      buttons: 1,
      button: 0,
      pressure: 0.5,
      bubbles: true,
    };
    await paper.dispatchEvent("pointerdown", pen);
    await paper.dispatchEvent("pointerup", {
      ...pen,
      clientX: box.x + 260,
      buttons: 0,
    });
    await expect(paper.locator("g[data-ink-stroke]")).toHaveCount(1);
    const path = await paper.locator("g path").getAttribute("d");
    await p.getByRole("button", { name: "1번 선택", exact: true }).click();
    await p.getByRole("button", { name: "답 제출", exact: true }).click();
    await expect(p.locator(".explanation-panel > summary")).toContainText(
      "해설 자료 미등록",
    );
    await p.locator(".explanation-panel > summary").click();
    await expect(p.locator(".explanation-panel")).toContainText(
      "이 문항에 등록된 해설이 없습니다.",
    );
    await expect
      .poll(
        async () =>
          (await storedWithoutExplanations(p, namespace)).attempts.length,
      )
      .toBe(1);
    const before = await storedWithoutExplanations(p, namespace);
    expect(before.attempts[0].result).toBe("incorrect");
    await p.reload();
    await expect(paper).toHaveAttribute("data-ink-ready", "true");
    await expect(paper.locator("g path")).toHaveAttribute("d", path!);
    expect((await storedWithoutExplanations(p, namespace)).attempts).toEqual(
      before.attempts,
    );
    await expect(
      p.getByRole("button", { name: "연필", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await p.getByRole("button", { name: "학습 종료", exact: true }).click();
    await expect(
      p.getByRole("button", { name: "취소 · 계속 풀기", exact: true }),
    ).toBeFocused();
    await p
      .getByRole("button", { name: "취소 · 계속 풀기", exact: true })
      .click();
    expect(
      (await storedWithoutExplanations(p, namespace)).sessions[0].status,
    ).toBe("active");
    await p.getByRole("button", { name: "학습 종료", exact: true }).click();
    await p
      .getByRole("button", { name: "학습 종료 확정", exact: true })
      .click();
    await expect(
      p.getByRole("heading", { name: "학습 결과", exact: true }),
    ).toBeVisible();
    await p
      .getByRole("button", { name: "이번 오답 다시 풀기 (1)", exact: true })
      .click();
    await expect(
      p.getByRole("button", { name: "2번 선택", exact: true }),
    ).toBeEnabled();
    await p.getByRole("button", { name: "2번 선택", exact: true }).click();
    await p.getByRole("button", { name: "답 제출", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await storedWithoutExplanations(p, namespace)).attempts.length,
      )
      .toBe(2);
    const after = await storedWithoutExplanations(p, namespace);
    expect(after.attempts[0]).toEqual(before.attempts[0]);
    expect(after.attempts[1].result).toBe("correct");
    expect(errors).toEqual([]);
    expect(await p.locator("body").innerText()).not.toMatch(
      /NaN|Infinity|undefined/,
    );
  });
}

test("손상된 선택 해설 저장소는 미등록과 구분하고 문제 풀이와 원본 자료를 보존한다", async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.goto("/?view=original&mode=demo");
  const damaged = {
    generation: 7,
    packages: [{ format: "TEST_ONLY_CORRUPT" }],
  };
  await p.evaluate(
    (value) =>
      new Promise<void>((resolveValue, reject) => {
        const r = indexedDB.open("police-original-explanations", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("collections");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            t = db.transaction("collections", "readwrite");
          t.objectStore("collections").put(
            value,
            JSON.stringify(["local", "demo"]),
          );
          t.oncomplete = () => {
            db.close();
            resolveValue();
          };
          t.onabort = () => reject(t.error);
        };
      }),
    damaged,
  );
  await p.reload();
  await p.getByRole("button", { name: "근거·출제 빈도", exact: true }).click();
  await expect(p.getByRole("alert")).toContainText(
    "해설 자료를 불러오지 못했습니다.",
  );
  await expect(p.getByText(/분석 자료 미등록/)).toHaveCount(0);
  await expect(p.locator(".frequency-coverage")).toHaveCount(0);
  await p
    .getByRole("button", { name: "해설 다시 불러오기", exact: true })
    .click();
  await expect(p.getByRole("alert")).toBeVisible();
  await p.getByRole("button", { name: "일반 학습", exact: true }).click();
  await p.getByRole("button", { name: "시작하기", exact: true }).click();
  await p.getByRole("button", { name: "모르겠음 제출", exact: true }).click();
  await p.locator(".explanation-panel > summary").click();
  await expect(
    p.locator(".explanation-panel").getByRole("alert"),
  ).toContainText("해설 자료를 불러오지 못했습니다.");
  await expect(p.locator(".explanation-panel")).not.toContainText(
    "이 문항에 등록된 해설이 없습니다.",
  );
  await expect
    .poll(
      async () => (await storedWithoutExplanations(p, "demo")).attempts.length,
    )
    .toBe(1);
  await p.getByRole("button", { name: "학습 종료", exact: true }).click();
  await p.getByRole("button", { name: "학습 종료 확정", exact: true }).click();
  await expect(
    p.getByRole("heading", { name: "학습 결과", exact: true }),
  ).toBeVisible();
  const retained = await p.evaluate(
    () =>
      new Promise<any>((resolveValue, reject) => {
        const r = indexedDB.open("police-original-explanations", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            g = db
              .transaction("collections")
              .objectStore("collections")
              .get(JSON.stringify(["local", "demo"]));
          g.onsuccess = () => {
            resolveValue(g.result);
            db.close();
          };
          g.onerror = () => reject(g.error);
        };
      }),
  );
  expect(retained).toEqual(damaged);
});
