import { test, expect, type Page } from "@playwright/test";
import { initialState } from "../src/fixtures/data";
import { defaultSelection, type State, type Namespace } from "../src/domain/schema";
import { startSession, submit, next, markKey } from "../src/domain/engine";
import { backup, validateBackup } from "../src/data/transfer";

function fixture(active = false) {
  const real = initialState(true);
  real.dataset.datasetId = "police-personal";
  real.dataset.taxonomies.push(...initialState().dataset.taxonomies);
  real.dataset.items = real.dataset.items.slice(0, 4);
  real.dataset.items.forEach((item, i) => {
    item.source.year = i === 1 ? 2025 : 2026;
    item.source.round = i === 2 ? "1차" : "2차";
  });
  real.dataset.items[3].subjectId = "police";
  real.dataset.items[3].primaryUnitId = null;
  real.dataset.coverage = real.dataset.items.map((item, i) => ({
    id: `c-${i}`, subjectId: item.subjectId, year: item.source.year,
    round: item.source.round, status: "complete", classificationComplete: true,
  }));
  real.settings.fontScale = 2;
  startSession(real, { ...defaultSelection, mode: "balanced" }, real.dataset.items.slice(0, 2));
  const session = real.sessions[0];
  if (!active) {
    for (let i = 0; i < 2; i++) { submit(real, session.id, "unknown"); next(real, session.id); }
  }
  real.marks[markKey(real.dataset.items[0].id, "current")] = true;
  real.marks[markKey(real.dataset.items[1].id, "current")] = true;
  return { real, demo: initialState(true) };
}

// Each test owns a fresh Playwright context. Only synthetic states are seeded.
async function seed(page: Page, states: { real: State; demo: State }) {
  await page.goto("/?mode=real");
  await expect(page.getByRole("button", { name: "데이터·설정", exact: true })).toBeVisible();
  await page.evaluate(async states => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("police-ox-storage", 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("states", "readwrite");
        tx.objectStore("states").put({ generation: 10, state: states.real }, "real");
        tx.objectStore("states").put({ generation: 20, state: states.demo }, "demo");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, states);
  await page.reload();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
}
async function read(page: Page, namespace: Namespace): Promise<State> {
  return page.evaluate(namespace => new Promise<State>((resolve, reject) => {
    const request = indexedDB.open("police-ox-storage", 1);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("states", "readonly").objectStore("states").get(namespace);
      get.onsuccess = () => { db.close(); resolve(get.result.state); };
      get.onerror = () => reject(get.error);
    };
  }), namespace);
}

test("등록된 문제 목록은 coverage 없이 실제 지문을 집계하고 자연 순서로 표시한다", async ({ page }) => {
  const states = { real: initialState(), demo: initialState(true) };
  const template = initialState(true).dataset.items[0];
  const rows = [
    [2025, "2차", "constitution"],
    [2026, "10차", "constitution"],
    [2026, "2차", "police"],
    [2026, "2차", "criminal"],
    [2026, "2차", "constitution"],
    [2026, "2차", "constitution"],
    [2026, "1차", "constitution"],
  ] as const;
  states.real.dataset.items = rows.map(([year, round, subjectId], i) => ({
    ...structuredClone(template), id: `registered-${i}`, subjectId,
    source: { ...template.source, year, round },
    areaId: null, primaryUnitId: null, relatedUnitIds: [],
  }));
  states.real.dataset.coverage = [];
  await seed(page, states);
  const panel = page.getByRole("region", { name: "등록된 문제 데이터", exact: true });
  await expect(panel.locator("p")).toHaveText([
    "2026 · 1차 · 헌법 · 지문 1개",
    "2026 · 2차 · 헌법 · 지문 2개",
    "2026 · 2차 · 형사법 · 지문 1개",
    "2026 · 2차 · 경찰학 · 지문 1개",
    "2026 · 10차 · 헌법 · 지문 1개",
    "2025 · 2차 · 헌법 · 지문 1개",
  ]);
  expect((await read(page, "real")).dataset).toEqual(states.real.dataset);
  states.real.dataset.items = [];
  await seed(page, states);
  await expect(panel).toContainText("등록된 문제 데이터 없음");
});

test("미리보기 후 선택 범위만 삭제하고 다른 학습 기록을 보존한다", async ({ page }) => {
  const states = fixture(); await seed(page, states);
  const panel = page.getByRole("region", { name: "문제 데이터 삭제", exact: true });
  await panel.getByLabel("삭제 과목").selectOption("constitution");
  await panel.getByLabel("삭제 연도").selectOption("2026");
  await panel.getByLabel("삭제 회차").selectOption("2차");
  await panel.getByRole("button", { name: "삭제 대상 확인" }).click();
  await expect(panel.getByText("삭제 예정 문제: 1개", { exact: true })).toBeVisible();
  await expect(panel.getByText("응답(attempts): 1개", { exact: true })).toBeVisible();
  expect(await read(page, "real")).toEqual(states.real);
  await panel.getByRole("button", { name: "삭제 취소" }).click();
  await expect(panel.getByRole("button", { name: "문제 1개 삭제", exact: true })).toHaveCount(0);
  expect(await read(page, "real")).toEqual(states.real);
  await panel.getByRole("button", { name: "삭제 대상 확인" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: "test-results/remove-items-preview.png" });
  await panel.getByRole("button", { name: "문제 1개 삭제", exact: true }).click();
  await expect(page.getByText("문제 1개와 관련 학습 기록을 삭제했습니다.")).toBeVisible();
  const after = await read(page, "real");
  expect(after.dataset.items).toEqual(states.real.dataset.items.slice(1));
  expect(after.attempts).toEqual(states.real.attempts.slice(1));
  expect(after.sessions[0].items).toEqual(states.real.sessions[0].items.slice(1));
  expect(after.dataset.taxonomies).toEqual(states.real.dataset.taxonomies);
  expect(after.settings).toEqual(states.real.settings);
  expect(after.dataset.coverage).toEqual(states.real.dataset.coverage.slice(1));
  expect(() => validateBackup(backup(after, "real"), "real")).not.toThrow();
  expect(await read(page, "demo")).toEqual(states.demo);
  await page.reload();
  expect(await read(page, "real")).toEqual(after);
});

test("필터 변경 시 확인을 다시 요구하고 전체 삭제 후 목차·설정과 다른 영역을 보존한다", async ({ page }) => {
  const states = fixture(); await seed(page, states);
  const panel = page.getByRole("region", { name: "문제 데이터 삭제", exact: true });
  await panel.getByRole("button", { name: "삭제 대상 확인" }).click();
  await expect(panel.getByRole("button", { name: "문제 4개 삭제", exact: true })).toBeVisible();
  await panel.getByLabel("삭제 과목").selectOption("police");
  await expect(panel.getByRole("region", { name: "문제 삭제 미리보기" })).toHaveCount(0);
  await panel.getByLabel("삭제 연도").selectOption("2025");
  await panel.getByRole("button", { name: "삭제 대상 확인" }).click();
  await expect(panel.getByRole("button", { name: "문제 0개 삭제", exact: true })).toBeDisabled();
  await panel.getByLabel("삭제 과목").selectOption("");
  await panel.getByLabel("삭제 연도").selectOption("");
  await panel.getByRole("button", { name: "삭제 대상 확인" }).click();
  await panel.getByRole("button", { name: "문제 4개 삭제", exact: true }).click();
  await expect(page.getByText("문제 4개와 관련 학습 기록을 삭제했습니다.")).toBeVisible();
  const after = await read(page, "real");
  expect(after.dataset.items).toEqual([]); expect(after.attempts).toEqual([]);
  expect(after.sessions).toEqual([]); expect(after.marks).toEqual({});
  expect(after.cycles).toEqual({}); expect(after.allocations).toEqual({});
  expect(after.dataset.taxonomies).toEqual(states.real.dataset.taxonomies);
  expect(after.dataset.studyGroups).toEqual(states.real.dataset.studyGroups);
  expect(after.settings).toEqual(states.real.settings);
  expect(await read(page, "demo")).toEqual(states.demo);
});

test("진행 중 세션이면 삭제 미리보기를 차단한다", async ({ page }) => {
  const states = fixture(true); await seed(page, states);
  const panel = page.getByRole("region", { name: "문제 데이터 삭제", exact: true });
  await expect(panel.getByText("진행 중 세션을 종료한 뒤 삭제하세요.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "삭제 대상 확인" })).toBeDisabled();
  expect(await read(page, "real")).toEqual(states.real);
});

test("namespace 전환 시 미리보기를 버리고 demo 삭제가 real에 영향을 주지 않는다", async ({ page }) => {
  const states = fixture(); await seed(page, states);
  await page.getByRole("button", { name: "삭제 대상 확인" }).click();
  await page.getByLabel("저장 영역").selectOption("demo");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await expect(page.getByRole("region", { name: "문제 삭제 미리보기" })).toHaveCount(0);
  await page.getByRole("button", { name: "삭제 대상 확인" }).click();
  await page.getByRole("button", { name: "문제 7개 삭제", exact: true }).click();
  await expect(page.getByText("문제 7개와 관련 학습 기록을 삭제했습니다.")).toBeVisible();
  expect((await read(page, "demo")).dataset.items).toEqual([]);
  expect(await read(page, "real")).toEqual(states.real);
});
