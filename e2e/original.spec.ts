import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import examConfig from "../src/original/contracts/exam-profiles.json";

const prefix: Record<string, string> = { constitution: "const", criminal: "crim", police: "police" };
const label: Record<string, string> = { constitution: "헌법", criminal: "형사법", police: "경찰학" };
const unit: Record<string, string> = { "CONST-THEORY": "CONST-01", "CONST-RIGHTS": "CONST-04", "CRIM-GENERAL": "CRIM-G-01", "CRIM-SPECIAL": "CRIM-S-01", "CRIM-INV": "CRIM-P-INV", "CRIM-EVD": "CRIM-P-EVD", "POL-ADMIN-LAW": "POL-01", "POL-FOUNDATIONS": "POL-02", "POL-ADMIN-SCIENCE": "POL-03", "POL-ACTIVITIES": "POL-04", "POL-HISTORY": "POL-05" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQsUn5DwAC0AG0vqck9wAAAABJRU5ErkJggg==";
async function showNavigation(page: Page, label: string) {
  if (!(await page.getByRole("button", { name: label, exact: true }).isVisible()))
    await page.getByRole("button", { name: "메뉴", exact: true }).click();
}

/** Synthetic nonlegal input exists only in the browser test, never in product real fixtures. */
function samplePackage(full = false) {
  const count: Record<string, number> = {};
  const questions = examConfig.profiles[0].areas.flatMap((area) => Array.from({ length: full ? area.targetQuestions : area.subjectId === "constitution" && area.code === "CONST-THEORY" ? 2 : 0 }, () => {
    const n = count[area.subjectId] = (count[area.subjectId] ?? 0) + 1;
    return {
      id: `${prefix[area.subjectId]}_2026_2_${n}`, revision: 1, gradingRevision: 1, subjectId: area.subjectId,
      source: { examCode: "po", year: 2026, round: "2", examName: "자동화 시험 전용 가상 자료 — 실제 기출 아님", questionNumber: n, questionPdf: { fileName: "TEST_ONLY_가상시험.pdf", pages: [1] }, answerPdf: { fileName: "TEST_ONLY_가상정답.pdf", pages: [1], subjectColumn: label[area.subjectId] } },
      body: [{ type: "text", text: `자동화 시험 전용 가상 문항 ${n}. 파란 상자에 동그라미가 하나 있다. 동일한 표시를 고르세요. 실제 법률·시험 내용이 아닙니다.\n${"긴 문장의 줄바꿈과 사례·조건·기호 ㉠ ㉡, 괄호 (조건), 수치 10을 확인합니다. ".repeat(12)}` }, { type: "statements", entries: [{ label: "㉠", text: "파란 상자" }, { label: "㉡", text: "동그라미 하나" }] }, { type: "image", assetId: "test-png", alt: "테스트용 픽셀 이미지" }],
      choices: [1, 2, 3, 4].map((number) => ({ number, blocks: [{ type: "text", text: number === 1 ? '파란 상자와 동그라미 하나 <img src=x onerror="window.injected=true">' : `가상 표시 ${number}` }] })),
      officialAnswer: { status: "final", kind: "single", acceptedChoices: [1] },
      classification: { studyUnitCode: unit[area.code], relatedStudyUnitCodes: [], studyStatus: "confirmed", bookUnitIds: [], blueprintAreaCode: area.code, blueprintStatus: "confirmed" },
      qa: { textStatus: "checked", answerStatus: "checked", notes: ["TEST ONLY: 가상 자동화 검증 자료"] }, lifecycle: "active",
    };
  }));
  return { format: "police-original-questions", schemaVersion: "1.0.0", packageId: full ? "TEST_ONLY_full" : "TEST_ONLY_small", packageVersion: 1, exportedAt: "2026-10-21T00:00:00.000Z", dataKind: "real", stage: "classified", unitRegistryVersion: "1.0.0", questions, assets: [{ assetId: "test-png", mimeType: "image/png", sha256: createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"), base64: png }] };
}
async function stored(page: Page, namespace = "real") {
  return page.evaluate(async (ns) => new Promise<any>((resolve, reject) => {
    const req = indexedDB.open("police-ox-storage", 1);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction("states", "readonly"), get = tx.objectStore("states").get(`original:${ns}`);
      get.onsuccess = () => { resolve(get.result); db.close(); };
      get.onerror = () => reject(get.error);
    };
    req.onerror = () => reject(req.error);
  }), namespace);
}
async function importFile(page: Page, value: unknown) {
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByLabel("문제 JSON 가져오기", { exact: true }).setInputFiles({ name: "TEST_ONLY.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
}
async function applyImport(page: Page, value: unknown, expectedQuestions = (value as any).questions.length) {
  await importFile(page, value);
  await page.getByRole("button", { name: "확인하고 적용", exact: true }).click();
  await expect(page.getByText("검증한 데이터를 저장했습니다.", { exact: true })).toBeVisible();
  await expect.poll(async () => (await stored(page))?.state.data.questions.length).toBe(expectedQuestions);
}

test.use({ viewport: { width: 1280, height: 720 } });

test("원문 빈 상태, 시연 응답 중복 방지·새로고침·실제 영역 격리", async ({ page }) => {
  await page.goto("/?view=original&mode=real");
  await expect(page.getByRole("heading", { name: "원문 기출 학습", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "test-results/original-home-1440.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("저장 영역", { exact: true }).selectOption("demo");
  await expect(page.locator(".original-demo")).toContainText("실제 기출이 아닙니다");
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(page.getByRole("button", { name: "1번 선택", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /다시 보기$/ }).click();
  await page.getByRole("button", { name: "모르겠음 제출", exact: true }).dblclick();
  await expect.poll(async () => (await stored(page, "demo"))?.state.attempts.length).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "1번 선택", exact: true })).toBeDisabled();
  const demo = (await stored(page, "demo")).state;
  expect(demo.attempts[0].result).toBe("unknown");
  expect(Object.values(demo.marks)).toContain(true);
  await page.getByRole("button", { name: "학습 종료", exact: true }).click();
  expect((await stored(page, "demo")).state.attempts).toHaveLength(1);
  await page.getByLabel("저장 영역", { exact: true }).selectOption("real");
  expect((await stored(page, "real"))?.state.attempts ?? []).toHaveLength(0);
  await expect(page.locator(".original-demo")).toHaveCount(0);
});

test("가져오기 미리보기, 잘못된 순서 거부, 안전한 원문·그림 렌더링과 PC 화면", async ({ page }) => {
  await page.goto("/?view=original&mode=real");
  const bad = samplePackage();
  bad.questions[0].choices.reverse();
  await importFile(page, bad);
  await expect(page.getByRole("alert")).toContainText(/choices|선택지|순서/);
  expect((await stored(page))?.state.data.questions ?? []).toHaveLength(0);
  const corrupt = samplePackage();
  const truncated = Buffer.from(png, "base64").subarray(0, 24);
  corrupt.assets[0].base64 = truncated.toString("base64");
  corrupt.assets[0].sha256 = createHash("sha256").update(truncated).digest("hex");
  await importFile(page, corrupt);
  await expect(page.getByRole("alert")).toContainText(/그림|이미지|디코딩/);
  expect((await stored(page))?.state.data.questions ?? []).toHaveLength(0);
  await applyImport(page, samplePackage());
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(page.getByText("<img src=x onerror=\"window.injected=true\">", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  await expect(page.getByAltText("테스트용 픽셀 이미지", { exact: true })).toBeVisible();
  expect(await page.getByAltText("테스트용 픽셀 이미지").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/original-${viewport.width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "1번 선택", exact: true }).focus();
  await page.keyboard.press("1");
  await page.getByRole("button", { name: "답 제출", exact: true }).click();
  await expect.poll(async () => (await stored(page))?.state.attempts[0]?.result).toBe("correct");
});

test("11개 영역 편성, 답안 비공개, 실제 종료 시각·새로고침·자동 제출 한 번", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-21T01:00:00.000Z") });
  await page.goto("/?view=original&mode=real");
  await page.getByRole("button", { name: "모의고사", exact: true }).click();
  await expect(page.getByRole("button", { name: "시작하기", exact: true })).toBeDisabled();
  await applyImport(page, samplePackage(true));
  await page.getByRole("button", { name: "모의고사", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await page.getByRole("button", { name: "1번 선택", exact: true }).click();
  await expect.poll(async () => Object.keys((await stored(page)).state.sessions[0].responses).length).toBe(1);
  await page.getByRole("button", { name: "다음 문항", exact: true }).click();
  await page.getByRole("button", { name: "2번 선택", exact: true }).click();
  await expect.poll(async () => Object.keys((await stored(page)).state.sessions[0].responses).length).toBe(2);
  const before = (await stored(page)).state.sessions[0];
  expect(before.questions).toHaveLength(100);
  expect(new Set(before.questions.map((q: any) => q.id)).size).toBe(100);
  expect((await stored(page)).state.attempts).toHaveLength(0);
  await expect(page.getByText(/공식 정답|정답 ①|정답 1/)).toHaveCount(0);
  await page.clock.fastForward(10 * 60 * 1000);
  await page.reload();
  expect((await stored(page)).state.sessions[0].deadlineAt).toBe(before.deadlineAt);
  await expect(page.getByLabel("남은 시간", { exact: true })).toContainText(/90:00|89:59/);
  await page.clock.fastForward(90 * 60 * 1000);
  await expect.poll(async () => (await stored(page)).state.sessions[0].status).toBe("completed");
  const final = (await stored(page)).state;
  expect(final.attempts).toHaveLength(100);
  expect(final.attempts.filter((a: any) => a.result === "correct")).toHaveLength(1);
  expect(final.attempts.filter((a: any) => a.result === "incorrect")).toHaveLength(1);
  expect(final.attempts.filter((a: any) => a.result === "unanswered")).toHaveLength(98);
  await page.reload();
  expect((await stored(page)).state.attempts).toHaveLength(100);
  await expect(page.getByRole("button", { name: "1번 선택", exact: true })).toHaveCount(0);
});

test("원문 전체 백업은 응답·표시·세션과 OX를 함께 보존하고 미리보기 후 복구", async ({ page }) => {
  await page.goto("/?view=original&mode=real");
  await applyImport(page, samplePackage());
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await page.getByRole("button", { name: /다시 보기$/ }).click();
  await page.getByRole("button", { name: "모르겠음 제출", exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.attempts.length).toBe(1);
  await page.getByRole("button", { name: "학습 종료", exact: true }).click();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "전체 백업 내보내기", exact: true }).click();
  const download = await downloadPromise, backupPath = (await download.path())!;
  const before = (await stored(page)).state;
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await page.getByRole("button", { name: "1번 선택", exact: true }).click();
  await page.getByRole("button", { name: "답 제출", exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.attempts.length).toBe(2);
  await page.getByRole("button", { name: "학습 종료", exact: true }).click();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByLabel("전체 백업 복구", { exact: true }).setInputFiles(backupPath);
  await expect(page.getByText(/교체|복구/).first()).toBeVisible();
  await page.getByRole("button", { name: "확인하고 적용", exact: true }).click();
  await expect.poll(async () => JSON.stringify((await stored(page)).state)).toBe(JSON.stringify(before));
});

test("시험 저장 실패 후 만료·재시도는 마지막 저장 답안만 채점한다", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-21T01:00:00.000Z") });
  await page.goto("/?view=original&mode=real");
  await applyImport(page, samplePackage(true));
  await page.getByRole("button", { name: "모의고사", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await page.getByRole("button", { name: "1번 선택", exact: true }).click();
  await expect.poll(async () => Object.values((await stored(page)).state.sessions[0].responses)[0]).toBe(1);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as any).__restorePut = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      if (this.name === "states" && key === "original:real") throw new DOMException("자동화 검증용 저장 실패", "QuotaExceededError");
      return original.call(this, value, key as IDBValidKey);
    };
  });
  await page.getByRole("button", { name: "2번 선택", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("저장되지 않음");
  expect(Object.values((await stored(page)).state.sessions[0].responses)[0]).toBe(1);
  await page.clock.fastForward(100 * 60 * 1000);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await expect(page.getByRole("button", { name: "저장 재시도", exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__restorePut());
  await page.getByRole("button", { name: "저장 재시도", exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.sessions[0].status).toBe("completed");
  const attempts = (await stored(page)).state.attempts;
  expect(attempts).toHaveLength(100);
  expect(attempts.filter((a: any) => a.result === "correct")).toHaveLength(1);
  expect(attempts.filter((a: any) => a.result === "incorrect")).toHaveLength(0);
  expect(attempts.filter((a: any) => a.result === "unanswered")).toHaveLength(99);
});

test("선택 자료 삭제는 미리보기·취소·기록 보존·재가져오기·복구와 영역 분리를 지킨다", async ({ page }) => {
  await page.setViewportSize({ width: 565, height: 672 });
  await page.goto("/?view=original&mode=real");
  const pkg = samplePackage();
  await applyImport(page, pkg);
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await showNavigation(page, "데이터·설정");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `자료 선택: ${pkg.packageId}`, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "선택한 데이터 삭제", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "학습 홈", exact: true }).click();
  await page.getByRole("button", { name: /^이어 풀기/ }).click();
  await page.getByRole("button", { name: /다시 보기$/ }).click();
  await page.getByRole("button", { name: "모르겠음 제출", exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.attempts.length).toBe(1);
  await page.getByRole("button", { name: "학습 종료", exact: true }).click();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  const before = (await stored(page)).state;
  await expect(page.getByRole("heading", { name: "가져온 문제 관리", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: `자료 선택: ${pkg.packageId}`, exact: true }).check();
  await page.getByRole("button", { name: "선택한 데이터 삭제", exact: true }).click();
  await expect(page.getByRole("heading", { name: "삭제 전 확인", exact: true })).toBeVisible();
  const preview = page.getByRole("region", { name: "삭제 전 확인", exact: true });
  await expect(preview.getByText("학습 목록에서 제거", { exact: true }).locator("..")).toContainText("2문항");
  await expect(preview.getByText("과거 풀이 기록으로만 보관", { exact: true }).locator("..")).toContainText("2문항");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/original-delete-565.png", fullPage: true });
  await page.getByRole("button", { name: "삭제 취소", exact: true }).click();
  expect((await stored(page)).state).toEqual(before);
  await page.getByRole("checkbox", { name: `자료 선택: ${pkg.packageId}`, exact: true }).check();
  await page.getByRole("button", { name: "선택한 데이터 삭제", exact: true }).click();
  await page.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await expect(page.getByText("선택한 문제 데이터를 삭제했습니다.", { exact: true })).toBeVisible();
  await expect.poll(async () => (await stored(page)).state.data.packages.length).toBe(0);
  const deleted = (await stored(page)).state;
  expect(deleted.attempts).toEqual(before.attempts);
  expect(deleted.sessions).toEqual(before.sessions);
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await expect(page.getByRole("button", { name: "시작하기", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  const waitDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "전체 백업 내보내기", exact: true }).click();
  const deletedBackupPath = (await (await waitDownload).path())!;
  await applyImport(page, pkg);
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await expect(page.getByRole("button", { name: "시작하기", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByLabel("전체 백업 복구", { exact: true }).setInputFiles(deletedBackupPath);
  await page.getByRole("button", { name: "확인하고 적용", exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.data.packages.length).toBe(0);
  expect((await stored(page)).state.attempts).toEqual(before.attempts);
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await expect(page.getByRole("button", { name: "시작하기", exact: true })).toBeDisabled();
  await applyImport(page, pkg);
  await page.getByLabel("저장 영역", { exact: true }).selectOption("demo");
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `자료 선택: ${pkg.packageId}`, exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "가져온 자료 전체 선택", exact: true }).check();
  await page.getByRole("button", { name: "선택한 데이터 삭제", exact: true }).click();
  await page.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await expect.poll(async () => (await stored(page, "demo")).state.data.packages.length).toBe(0);
  expect((await stored(page, "real")).state.data.packages.map((p: any) => p.packageId)).toEqual([pkg.packageId]);
  expect((await stored(page, "real")).state.attempts).toEqual(before.attempts);
});

test("겹치는 자료 중 하나를 삭제해도 다른 자료의 공유 문항은 남는다", async ({ page }) => {
  await page.goto("/?view=original&mode=real");
  const first = samplePackage(); first.packageId = "TEST_ONLY_shared_A";
  const second = samplePackage(); second.packageId = "TEST_ONLY_shared_B";
  second.questions = [second.questions[0]];
  await applyImport(page, first);
  await applyImport(page, second, 2);
  await page.getByRole("checkbox", { name: `자료 선택: ${first.packageId}`, exact: true }).check();
  await page.getByRole("button", { name: "선택한 데이터 삭제", exact: true }).click();
  await expect(page.getByRole("region", { name: "삭제 전 확인", exact: true }).getByText("다른 자료에 포함되어 유지", { exact: true }).locator("..")).toContainText("1문항");
  await page.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.data.packages.map((p: any) => p.packageId)).toEqual([second.packageId]);
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await expect(page.getByText("1문항으로 학습합니다", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "시작하기", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await page.getByRole("checkbox", { name: `자료 선택: ${second.packageId}`, exact: true }).check();
  await page.getByRole("button", { name: "선택한 데이터 삭제", exact: true }).click();
  await page.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.data.packages.length).toBe(0);
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await expect(page.getByRole("button", { name: "시작하기", exact: true })).toBeDisabled();
});
