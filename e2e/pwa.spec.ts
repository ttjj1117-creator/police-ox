import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";

const origin = "http://127.0.0.1:5184";
const base = origin + "/police-ox/";
const root = process.cwd();
const output = resolve(root, ".pwa-test-dist");
let server: Server;
let workerVersion = 0;
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

test.beforeAll(async () => {
  const build = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "build",
      "--outDir",
      output,
      "--base",
      "/police-ox/",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, VITE_BASE_PATH: "/police-ox/" },
    },
  );
  if (build.status !== 0)
    throw new Error(
      `Isolated PWA build failed:\n${build.stdout}\n${build.stderr}`,
    );
  server = createServer((request, response) => {
    const url = new URL(request.url!, origin);
    if (!url.pathname.startsWith("/police-ox/")) {
      response.writeHead(404).end();
      return;
    }
    const name =
      decodeURIComponent(url.pathname.slice("/police-ox/".length)) ||
      "index.html";
    const path = resolve(output, name);
    if (!path.startsWith(output + "/") && !path.startsWith(output + "\\")) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
      response.setHeader(
        "Content-Type",
        mime[extname(name)] || "application/octet-stream",
      );
      response.setHeader("Cache-Control", "no-store");
      response.end(
        name === "sw.js"
          ? readFileSync(path, "utf8") +
              `\n// test deployment ${workerVersion}\n`
          : readFileSync(path),
      );
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveReady) =>
    server.listen(5184, "127.0.0.1", resolveReady),
  );
});
test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolveClosed, reject) =>
      server.close((error) => (error ? reject(error) : resolveClosed())),
    );
});

async function bank(page: Page) {
  return page.evaluate(
    () =>
      new Promise<any>((resolveValue, reject) => {
        const request = indexedDB.open("police-ox-storage");
        request.onsuccess = () => {
          const db = request.result;
          const get = db
            .transaction("states", "readonly")
            .objectStore("states")
            .get("original:demo");
          get.onsuccess = () => {
            resolveValue(get.result?.state);
            db.close();
          };
          get.onerror = () => {
            reject(get.error);
            db.close();
          };
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

test("PWA Pages 하위 경로의 manifest·아이콘·오프라인 재실행과 개인 응답 캐시 제외", async ({
  page,
  context,
}) => {
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "원문 기출 학습", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "기존 OX 학습실 ↗", exact: true }),
  ).toHaveAttribute("href", "/police-ox/?view=ox&mode=real");
  const manifestUrl = await page
    .locator('link[rel="manifest"]')
    .getAttribute("href");
  expect(manifestUrl).toBe("/police-ox/manifest.webmanifest");
  const manifestResponse = await context.request.get(origin + manifestUrl);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(new URL(manifest.start_url, base + "manifest.webmanifest").href).toBe(
    base + "?view=original&mode=real",
  );
  expect(manifest.scope).toBe("./");
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons)
    expect((await context.request.get(new URL(icon.src, base).href)).ok()).toBe(
      true,
    );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await page.evaluate(async () => {
    await fetch("/police-ox/private-backup.json").catch(() => {});
    await fetch("/police-ox/assets/private-auth.json", {
      headers: { Authorization: "Bearer TEST_ONLY" },
    }).catch(() => {});
  });
  const keys = await page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map(
            (request) => request.url,
          ),
        ),
      )
    ).flat(),
  );
  expect(keys.some((key) => /private|auth|supabase|backup/.test(key))).toBe(
    false,
  );
  expect(keys.every((key) => key.startsWith(origin + "/police-ox/"))).toBe(
    true,
  );
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "원문 기출 학습", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "오프라인입니다." }).first(),
  ).toBeVisible();
  await context.setOffline(false);
});

test("PWA 대기 업데이트는 진행 중 모의고사·답안·deadline을 보존하고 종료 후 명시적으로 적용", async ({
  page,
  context,
}) => {
  workerVersion = 0;
  await page.goto(base + "?view=original&mode=demo");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.getByLabel("저장 영역", { exact: true }).selectOption("demo");
  await page.getByRole("button", { name: "모의고사", exact: true }).click();
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await page.getByRole("button", { name: "1번 선택", exact: true }).click();
  await expect
    .poll(
      async () => Object.values((await bank(page)).sessions[0].responses)[0],
    )
    .toBe(1);
  const before = (await bank(page)).sessions[0];
  workerVersion++;
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  const apply = page.getByRole("button", {
    name: "앱 업데이트 적용",
    exact: true,
  });
  await expect(apply).toBeVisible();
  await apply.click();
  await expect(
    page.getByText(
      "진행 중인 풀이를 완료하거나 종료한 뒤 업데이트할 수 있습니다. 답안과 타이머는 그대로 유지됩니다.",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await bank(page)).sessions[0].id).toBe(before.id);
  expect((await bank(page)).sessions[0].deadlineAt).toBe(before.deadlineAt);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "1번 선택", exact: true }),
  ).toBeVisible();
  const offline = (await bank(page)).sessions[0];
  expect(offline.id).toBe(before.id);
  expect(offline.deadlineAt).toBe(before.deadlineAt);
  expect(offline.responses).toEqual(before.responses);
  await context.setOffline(false);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "시험 제출", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(시험 제출|학습 종료) 확정$/ })
    .click();
  await expect
    .poll(async () => (await bank(page)).sessions[0].status)
    .toBe("completed");
  const completed = await bank(page);
  await expect(apply).toBeVisible();
  const reloaded = page.waitForEvent(
    "framenavigated",
    (frame) => frame === page.mainFrame(),
  );
  await apply.click();
  await reloaded;
  await expect(
    page.getByRole("heading", { name: "원문 기출 학습", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        navigator.serviceWorker.getRegistration().then((reg) => !reg?.waiting),
      ),
    )
    .toBe(true);
  await expect
    .poll(async () => (await bank(page)).attempts.length)
    .toBe(completed.attempts.length);
  expect((await bank(page)).sessions[0].id).toBe(before.id);
});
