import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import {
  answer,
  defaultSelection,
  finish,
  initialOriginalState,
  startSession,
  type OriginalState,
} from "../src/original/engine";
import { explanationSyncFixture } from "../tests/fixtures/explanation-sync";

const server = "https://shared-e2e.example.invalid";
const learnerId = "11111111-1111-4111-8111-111111111111";
const previousId = "22222222-2222-4222-8222-222222222222";
const email = "shared-learner@example.com";
const token = "01234567";
const access = "test-only-shared-access";
const releasePath = "/storage/v1/object/authenticated/police-ox-shared";
const stateKey = (id: string) => `original:real:user:${server}|${id}`;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function storedState(page: Page, id: string) {
  return page.evaluate(
    (key) =>
      new Promise<OriginalState | undefined>((resolve, reject) => {
        const opening = indexedDB.open("police-ox-storage", 1);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const transaction = db.transaction("states");
          const result = transaction.objectStore("states").get(key);
          transaction.oncomplete = () => {
            db.close();
            resolve(result.result?.state);
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      }),
    stateKey(id),
  );
}

test("mock OTP seeds a new account's original bank and displays its shared instructor explanation", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.VITE_SHARED_LIBRARY_ENABLED !== "true",
    "Requires VITE_SHARED_LIBRARY_ENABLED=true on the isolated app server.",
  );
  const { source, instructor } = await explanationSyncFixture();
  const question = source.questions[0];
  const questionBytes = gzipSync(JSON.stringify({ packages: [source] }));
  const explanationBytes = gzipSync(
    JSON.stringify({ legacy: [], instructor: [instructor] }),
  );
  const manifest = {
    version: 1,
    releaseId: sha(`${sha(questionBytes)}:${sha(explanationBytes)}`),
    questions: { bytes: questionBytes.length, sha256: sha(questionBytes) },
    explanations: {
      bytes: explanationBytes.length,
      sha256: sha(explanationBytes),
    },
  };
  const downloads: string[] = [];
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (["localhost", "127.0.0.1"].includes(url.hostname))
      return url.pathname === "/TEST_ONLY_shared-seed"
        ? route.fulfill({ contentType: "text/html", body: "<!doctype html>" })
        : route.continue();
    if (url.origin !== server) return route.abort("blockedbyclient");
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const json = (body: unknown, status = 200) =>
      route.fulfill({ json: body, status, headers });
    if (url.pathname === "/auth/v1/otp") {
      expect(request.postDataJSON()).toEqual({ email, create_user: true });
      return json({});
    }
    if (url.pathname === "/auth/v1/verify") {
      expect(request.postDataJSON()).toEqual({ email, token, type: "email" });
      return json({
        access_token: access,
        refresh_token: "test-only-shared-refresh",
        expires_in: 3600,
        user: { id: learnerId, email },
      });
    }
    if (request.headers().authorization !== `Bearer ${access}`)
      return json({ message: "Authentication required by fixture" }, 401);
    if (/\/police_(?:ox_)?sync_pull$/.test(url.pathname))
      return json({
        events: [],
        cursor: 0,
        bankVersion: 0,
        serverTime: new Date().toISOString(),
      });
    if (url.pathname === "/storage/v1/object/list/police-sync-private")
      return json([]);
    if (url.pathname === `${releasePath}/current.json`) return json(manifest);
    for (const [name, body] of [
      ["questions", questionBytes],
      ["explanations", explanationBytes],
    ] as const) {
      if (
        url.pathname !==
        `${releasePath}/releases/${manifest.releaseId}/${name}.json.gz`
      )
        continue;
      downloads.push(name);
      return route.fulfill({
        headers,
        contentType: "application/octet-stream",
        body,
      });
    }
    unexpected.push(url.pathname);
    return json({ message: "Unexpected synthetic endpoint" }, 404);
  });

  const previous = initialOriginalState("real");
  previous.data = {
    questions: source.questions,
    assets: source.assets,
    packages: [source],
  };
  const start = Date.parse("2026-11-04T00:00:00Z");
  const session = startSession(
    previous,
    "real",
    defaultSelection,
    "study",
    start,
    [question],
  );
  answer(previous, session.id, "unknown", start + 1000);
  finish(previous, session.id, start + 2000);
  previous.marks[question.id] = true;
  await page.goto("/TEST_ONLY_shared-seed");
  await page.evaluate(
    async ({ previous, key, server }) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("police-ox-storage", 1);
        opening.onupgradeneeded = () =>
          opening.result.createObjectStore("states");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const transaction = db.transaction("states", "readwrite");
          const store = transaction.objectStore("states");
          store.put(
            { url: server, key: "sb_publishable_TEST_ONLY" },
            "sync:public-config",
          );
          store.put({ generation: 1, state: previous }, key);
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      }),
    { previous, key: stateKey(previousId), server },
  );
  await page.goto("/?view=original&mode=real&panel=cloud");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "인증번호 받기", exact: true })
    .click();
  await page.getByLabel("이메일 인증번호", { exact: true }).fill(token);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: email, exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await storedState(page, learnerId))?.data.questions)
    .toEqual(source.questions);
  const initial = await storedState(page, learnerId);
  expect(initial?.attempts).toEqual([]);
  expect(initial?.sessions).toEqual([]);
  expect(initial?.marks).toEqual({});
  await page.getByRole("button", { name: "일반 학습", exact: true }).click();
  await page
    .getByRole("combobox", { name: "연도", exact: true })
    .selectOption(String(question.source.year));
  await page
    .getByRole("combobox", { name: "회차", exact: true })
    .selectOption(question.source.round);
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(page.locator(".original-question-meta")).toContainText(
    `원문 ${question.source.questionNumber}번`,
  );
  const explanation = page.locator(".instructor-explanation-panel");
  await expect(explanation).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `${question.officialAnswer.acceptedChoices[0]}번 선택`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "답 제출", exact: true }).click();
  await expect(
    explanation.getByText("TEST_ONLY 빨강 도형의 해설입니다."),
  ).toBeVisible();
  await expect
    .poll(async () => (await storedState(page, learnerId))?.attempts.length)
    .toBe(1);
  expect(await storedState(page, previousId)).toEqual(previous);
  expect(downloads.sort()).toEqual(["explanations", "questions"]);
  expect(unexpected).toEqual([]);
});
