import { expect, test, type CDPSession, type Locator } from "@playwright/test";
import type { OriginalState } from "../src/original/engine";

const navLabel = { name: "신고 문항", exact: true };

async function tipTap(cdp: CDPSession, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await control.boundingBox())!;
  const point = { x: x + width / 2, y: y + height / 2 };
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await cdp.send("Input.dispatchMouseEvent", {
      ...point,
      type,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
      pointerType: "pen",
      force: type === "mousePressed" ? 0.5 : 0,
    });
  }
}

test("save, filter and review a flagged question without touching study records", async ({
  page,
}) => {
  const storedStudy = () =>
    page.evaluate(
      () =>
        new Promise<{ generation: number; state: OriginalState }>(
          (resolve, reject) => {
            const opening = indexedDB.open("police-ox-storage", 1);
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
              const db = opening.result;
              const read = db
                .transaction("states")
                .objectStore("states")
                .get("original:demo");
              read.onsuccess = () => {
                db.close();
                resolve(read.result);
              };
              read.onerror = () => {
                db.close();
                reject(read.error);
              };
            };
          },
        ),
    );
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  const report = page.getByRole("button", { name: "오류 신고", exact: true });
  const bookmark = page.getByRole("button", { name: "다시 보기", exact: true });
  await expect(report).toBeEnabled();
  expect((await report.boundingBox())!.x).toBeLessThan(
    (await bookmark.boundingBox())!.x,
  );
  const initialStudy = await storedStudy();
  await report.click();
  const dialog = page.getByRole("dialog", { name: "오류 신고" });
  await expect(
    dialog.getByRole("button", { name: "신고 저장" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(report).toBeFocused();
  await report.click();
  const questionCategory = dialog.getByRole("checkbox", { name: "문제·정답" });
  const explanationCategory = dialog.getByRole("checkbox", { name: "해설" });
  await questionCategory.click();
  await explanationCategory.focus();
  await page.keyboard.press("Space");
  await expect(questionCategory).toBeChecked();
  await expect(explanationCategory).toBeChecked();
  await page.keyboard.press("2");
  await dialog.getByRole("button", { name: "신고 저장" }).click();
  await expect(report).toHaveAttribute("data-reported", "true");
  await expect(
    page.getByRole("button", { name: "답 제출", exact: true }),
  ).toBeDisabled();
  await expect(bookmark).toHaveAttribute("aria-pressed", "false");
  expect(await storedStudy()).toEqual(initialStudy);
  await page.reload();
  await expect(report).toHaveAttribute("data-reported", "true");
  await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await page
    .getByRole("navigation", { name: "풀이 메뉴" })
    .getByRole("button", navLabel)
    .click();
  await expect(page.getByRole("heading", navLabel)).toBeVisible();
  await page.getByLabel("오류 유형").selectOption("question");
  await expect(page.getByText("문제·정답과 해설 · 검토 대기")).toBeVisible();
  await page.getByLabel("오류 유형").selectOption("explanation");
  await page.getByRole("button", { name: "문항 보기", exact: true }).click();
  await expect(page.getByText(/시연 정답 \d번/)).toBeVisible();
  await expect(page.getByText(/지문별 해설/)).toBeVisible();
  await page.getByRole("button", { name: "검토 완료로", exact: true }).click();
  await expect(
    page.getByText("선택한 조건의 신고 문항이 없습니다."),
  ).toBeVisible();
  await page.getByLabel("검토 상태").selectOption("resolved");
  await expect(page.getByText("문제·정답과 해설 · 검토 완료")).toBeVisible();
  await page.getByRole("button", { name: "신고 삭제", exact: true }).click();
  await expect(page.getByText(/저장한 신고 문항이 없습니다/)).toBeVisible();
  expect(await storedStudy()).toEqual(initialStudy);
});

test("reported questions hide the answers while a mock exam is active", async ({
  page,
}) => {
  await page.goto("/?view=original&mode=demo");
  await page.getByRole("button", { name: "모의고사", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  const report = page.getByRole("button", { name: "오류 신고", exact: true });
  await expect(report).toBeEnabled();
  await tipTap(cdp, report);
  const dialog = page.getByRole("dialog", { name: "오류 신고" });
  await expect(dialog).toBeVisible();
  const explanationCategory = dialog.getByRole("checkbox", { name: "해설" });
  await tipTap(cdp, explanationCategory);
  await expect(explanationCategory).toBeChecked();
  await tipTap(cdp, dialog.getByRole("button", { name: "신고 저장" }));
  await expect(report).toHaveAttribute("data-reported", "true");
  await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await page
    .getByRole("navigation", { name: "풀이 메뉴" })
    .getByRole("button", navLabel)
    .click();
  await expect(page.getByRole("button", { name: "문항 보기" })).toBeDisabled();
  await expect(
    page.getByText("모의고사 제출 후 문항과 해설을 열 수 있습니다."),
  ).toBeVisible();
});
