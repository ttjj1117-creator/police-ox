import { test, expect } from "@playwright/test";
import { demoDataset, initialState } from "../src/fixtures/data";
import { backup } from "../src/data/transfer";

test("제공 기본서의 세 과목 목차를 단계별로 펼치고 선택한다", async ({
  page,
}) => {
  await page.goto("/?mode=real");
  await page.getByRole("button", { name: "범위 선택", exact: true }).click();
  for (const entry of [
    {
      subject: "constitution",
      chain: ["제2편 기본권론", "제6장 청구권적 기본권"],
      leaf: "제3절 재판청구권",
      page: 799,
    },
    {
      subject: "criminal",
      chain: ["형법", "총론", "제2편 범죄론", "제3장 위법성론"],
      leaf: "제2절 정당방위",
      page: 80,
    },
    {
      subject: "police",
      chain: [
        "제1편 총론",
        "제4장 경찰행정법",
        "제4절 경찰작용법",
        "06 경찰관 직무집행법",
        "4. 경찰관 직무집행법의 내용",
      ],
      leaf: "(2) 불심검문(제3조)",
      page: 276,
    },
  ]) {
    await page.getByRole("combobox", { name: "과목", exact: true }).selectOption(entry.subject);
    for (const label of entry.chain)
      await page
        .getByRole("button", { name: label + " 펼치기", exact: true })
        .click();
    await page
      .getByRole("checkbox", { name: entry.leaf + " 선택", exact: true })
      .check();
    await expect(
      page.getByText(`기본서 ${entry.page}쪽`, { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/book-toc.png", fullPage: true });
});

test("이전 빈 백업 복구 후에도 새 기본서 목차가 자동 반영된다", async ({
  page,
}) => {
  const old = initialState();
  old.dataset.taxonomies = old.dataset.taxonomies.filter(
    (n) => n.origin === "custom",
  );
  old.dataset.taxonomies.push({
    id: "criminal-law",
    label: "형법",
    subjectId: "criminal",
    origin: "custom",
    taxonomyVersion: 1,
    parentId: null,
    order: 0,
  });
  await page.goto("/?mode=real");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page
    .getByLabel("전체 백업 복구", { exact: true })
    .setInputFiles({
      name: "old-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup(old, "real"))),
    });
  await page.getByRole("button", { name: "확인하고 적용" }).click();
  await expect(page.getByText("검증한 데이터를 저장했습니다.")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "범위 선택", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "제1편 헌법 총론 펼치기", exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "과목", exact: true }).selectOption("criminal");
  await expect(
    page.getByRole("button", { name: "형법 펼치기", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "형사소송법 · 임시 체계 펼치기",
      exact: true,
    }),
  ).toBeVisible();
});

test("단원은 접힌 계층으로 시작하고 전체 선택 후 세부 단원을 제외할 수 있다", async ({
  page,
}) => {
  await page.goto("/?mode=real");
  await page.getByRole("button", { name: /02.*형사법/ }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(2);
  await page
    .getByRole("checkbox", { name: "형사소송법 · 임시 체계 선택", exact: true })
    .check();
  await page
    .getByRole("button", { name: "형사소송법 · 임시 체계 펼치기", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "수사 선택", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "수사 펼치기", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "체포·구속 선택", exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "수사 선택", exact: true }),
  ).toBeChecked({ indeterminate: true });
  await expect(
    page.getByRole("checkbox", {
      name: "형사소송법 · 임시 체계 선택",
      exact: true,
    }),
  ).toBeChecked({ indeterminate: true });
  await page.getByRole("button", { name: "수사 접기", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "체포·구속 선택", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "수사 펼치기", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "체포·구속 선택", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "증거 선택", exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "임의수사 선택", exact: true }),
  ).toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/unit-tree.png", fullPage: true });
});

test("단원 전체 선택과 발췌 선택이 실제 출제 후보에 반영된다", async ({
  page,
}) => {
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "범위 선택", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "가상 예시 선택", exact: true })
    .check();
  await expect(page.getByText("조건에 맞는 검증 지문 7개")).toBeVisible();
  await page
    .getByRole("button", { name: "가상 예시 펼치기", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "숫자 선택", exact: true })
    .uncheck();
  await expect(page.getByText("조건에 맞는 검증 지문 4개")).toBeVisible();
});
test("빈 상태 → 시연 → 중복 클릭 → 새로고침 → 결과 → 실제 영역 격리", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "문제 데이터를 기다리고 있어요" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "시연 시작" }).click();
  await expect(
    page.getByText("기능 확인용 예시 · 실제 기출이 아닙니다."),
  ).toBeVisible();
  await page.getByRole("button", { name: /01.*헌법/ }).click();
  await expect(page.getByText("조건에 맞는 검증 지문 7개")).toBeVisible();
  await page.getByRole("button", { name: "학습 시작", exact: true }).click();
  await expect(page.getByRole("heading", { name: /정답/ })).toHaveCount(0);
  await expect(page.getByText("근거 펼치기")).toHaveCount(0);
  await page.getByRole("button", { name: "모르겠음", exact: true }).dblclick();
  await expect(page.getByRole("heading", { name: "정답 O" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "정답 O" })).toBeVisible();
  await page.getByRole("button", { name: "이번 세션 종료" }).click();
  await expect(page.getByText("현행 기준 · 응답 1/7개")).toBeVisible();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByLabel("저장 영역").selectOption("real");
  await expect(
    page.getByRole("heading", { name: "문제 데이터를 기다리고 있어요" }),
  ).toBeVisible();
});
test("문제 가져오기 미리보기와 HTML 일반 텍스트 렌더링", async ({ page }) => {
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  const d = demoDataset();
  d.items[0].revision = 2;
  d.items[0].displayText = '<img src=x onerror="window.injected=true">';
  await page.getByLabel("문제 JSON 가져오기", { exact: true }).setInputFiles({
    name: "safe-text.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(d)),
  });
  await expect(
    page.getByText(/지문 추가 0개 · 수정 1개 · 미변경 6개/),
  ).toBeVisible();
  await page.getByRole("button", { name: "확인하고 적용" }).click();
  await page.getByRole("button", { name: "범위 선택", exact: true }).click();
  await page.getByRole("button", { name: "학습 시작", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: d.items[0].displayText }),
  ).toBeVisible();
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  await expect(page.locator("img")).toHaveCount(0);
});
test("글자 200%에서 360px 가로 넘침 없이 학습", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "시연 시작" }).click();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByLabel("글자 크기").selectOption("2");
  await page.getByRole("button", { name: "학습 홈", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/home-200.png", fullPage: true });
  await page.getByRole("button", { name: "범위 선택", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "학습 시작", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "모르겠음", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/mobile-200.png",
    fullPage: true,
  });
});
test("백업 다운로드, 초기화, 복구 미리보기와 정확한 복원", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "시연 시작" }).click();
  await page.getByRole("button", { name: "범위 선택", exact: true }).click();
  await page.getByRole("button", { name: "학습 시작", exact: true }).click();
  await page.getByRole("button", { name: "모르겠음", exact: true }).click();
  await page.getByRole("button", { name: "이번 세션 종료" }).click();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: "전체 백업 다운로드" }).click();
  const download = await wait;
  const path = (await download.path())!;
  page.on("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "학습 기록 초기화", exact: true })
    .click();
  await expect(page.getByText("학습 기록을 초기화했습니다.")).toBeVisible();
  await page.getByLabel("전체 백업 복구", { exact: true }).setInputFiles(path);
  await expect(page.getByText(/문제 7개 · 응답 1개 · 세션 1개/)).toBeVisible();
  await page.getByRole("button", { name: "확인하고 적용" }).click();
  await expect(page.getByText("검증한 데이터를 저장했습니다.")).toBeVisible();
  await page.getByRole("button", { name: "학습 홈", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "전체 학습 통계" })
      .getByText("0%", { exact: true }),
  ).toBeVisible();
  const constitution = page.getByRole("button", { name: /01.*헌법/ });
  await expect(constitution.getByText("정답 0회 / 풀이 1회")).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: /02.*형사법/ })
      .getByText("아직 푼 기록이 없어요"),
  ).toBeVisible();
  await expect(page.getByLabel("학습 통계의 정답 기준")).toHaveCount(0);
});
