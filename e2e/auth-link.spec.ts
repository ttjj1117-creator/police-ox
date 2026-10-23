import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { initialOriginalState } from "../src/original/engine";
import { demoData } from "../src/original/demo";

// Synthetic credentials and intercepted requests only. These tests neither send
// real email nor contact the production Supabase project, even with .env.local.
const project = "https://sync.test",
  uid = "11111111-1111-4111-8111-111111111111";
const owner = `${project}|${uid}`,
  email = "callback-fixture@example.com";
const config = { url: project, key: "sb_publishable_TEST_ONLY" };
function callback(expired = false) {
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const access = `${encode({ alg: "ES256" })}.${encode({ iss: `${project}/auth/v1`, sub: uid, exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600) })}.synthetic-signature`;
  const refresh = "synthetic-browser-refresh";
  return {
    access,
    refresh,
    hash: `#${new URLSearchParams({ access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: "3600", type: "magiclink" })}`,
  };
}
function anonymousState() {
  const state = initialOriginalState("real"),
    q = structuredClone(demoData().questions[0]);
  q.id = "const_2026_1_1";
  q.source.examCode = "po";
  q.source.year = 2026;
  q.source.round = "1";
  q.source.questionNumber = 1;
  q.source.examName = "TEST_ONLY neutral reading fixture";
  q.officialAnswer.status = "final";
  q.source.questionPdf = { fileName: "TEST_ONLY_question.pdf", pages: [1] };
  q.source.answerPdf = {
    fileName: "TEST_ONLY_answer.pdf",
    pages: [1],
    subjectColumn: "헌법",
  };
  state.data.questions = [q];
  return state;
}
async function fakeNetwork(context: BrowserContext, token: string) {
  const requests = { users: 0, pulls: 0, pushes: 0, forbidden: [] as string[] };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === "http://127.0.0.1:5173") {
      if (url.pathname === "/TEST_ONLY_auth-seed")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Isolated authentication fixture</title>",
        });
      return route.continue();
    }
    if (url.origin !== project) {
      requests.forbidden.push(url.origin);
      return route.abort("blockedbyclient");
    }
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (request.headers().authorization !== `Bearer ${token}`)
      return json({ message: "unauthorized fixture request" }, 401);
    if (url.pathname === "/auth/v1/user") {
      requests.users++;
      return json({ id: uid, email });
    }
    if (url.pathname === "/rest/v1/rpc/police_sync_pull") {
      requests.pulls++;
      return json({
        events: [],
        cursor: 0,
        bankVersion: 0,
        serverTime: new Date().toISOString(),
      });
    }
    if (url.pathname === "/rest/v1/rpc/police_sync_push") requests.pushes++;
    return json({ message: "Unexpected synthetic endpoint" }, 400);
  });
  return requests;
}
async function seed(page: Page) {
  const anonymous = anonymousState();
  await page.goto("/TEST_ONLY_auth-seed");
  await page.evaluate(
    async ({ config, anonymous }) => {
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("police-ox-storage", 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains("states"))
            r.result.createObjectStore("states");
        };
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("states", "readwrite"),
            store = tx.objectStore("states");
          store.put(config, "sync:public-config");
          store.put({ generation: 1, state: anonymous }, "original:real");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = tx.onerror = () => reject(tx.error);
        };
      });
    },
    { config, anonymous },
  );
  return anonymous;
}
async function records(page: Page) {
  return page.evaluate(
    async ({ owner, project }) =>
      new Promise<any>((resolve, reject) => {
        const r = indexedDB.open("police-ox-storage", 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("states", "readonly"),
            store = tx.objectStore("states");
          const auth = store.get(`sync:auth:${project}`),
            original = store.get("original:real");
          const account = store.get(`original:real:user:${owner}`),
            meta = store.get(`sync:real:user:${owner}`);
          tx.oncomplete = () => {
            resolve({
              auth: auth.result ?? null,
              original: original.result,
              account: account.result ?? null,
              meta: meta.result ?? null,
            });
            db.close();
          };
          tx.onabort = tx.onerror = () => reject(tx.error);
        };
      }),
    { owner, project },
  );
}

test("mock-only magic link: StrictMode boot cleans URL, verifies once, and keeps anonymous records out of the account", async ({
  page,
  context,
}) => {
  const link = callback(),
    network = await fakeNetwork(context, link.access),
    anonymous = await seed(page),
    consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.goto(`/?view=original&mode=real${link.hash}`);
  await expect(
    page.getByRole("heading", { name: "계정·기기 동기화", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "동기화 상태" })
      .getByRole("heading", { name: email, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "동기화 상태" })).toContainText(
    "동기화 완료",
  );
  const url = new URL(page.url());
  expect(url.hash).toBe("");
  expect(url.searchParams.get("auth")).toBe("callback");
  expect(page.url()).not.toContain("access_token");
  expect(page.url()).not.toContain("refresh_token");
  expect(page.url()).not.toContain(link.access);
  expect(page.url()).not.toContain(link.refresh);
  expect(network.users).toBe(1);
  expect(network.pulls).toBeGreaterThan(0);
  expect(network.pushes).toBe(0);
  expect(network.forbidden).toEqual([]);
  const saved = await records(page);
  expect(saved.auth.user).toEqual({ id: uid, email });
  expect(saved.original.state).toEqual(anonymous);
  // Empty private banks are created lazily; private metadata establishes the account boundary.
  expect(saved.account?.state.data.questions ?? []).toEqual([]);
  expect(saved.account?.state.sessions ?? []).toEqual([]);
  expect(saved.meta.outbox).toEqual([]);
  expect(saved.meta.lastSuccess).toEqual(expect.any(String));
  expect(consoleMessages.join("\n")).not.toContain(link.access);
  expect(consoleMessages.join("\n")).not.toContain(link.refresh);
});

test("mock-only expired link: startup stays on the account screen, cleans the URL, and saves no credentials", async ({
  page,
  context,
}) => {
  const link = callback(true),
    network = await fakeNetwork(context, link.access),
    anonymous = await seed(page);
  await page.goto(`/?view=original&mode=real${link.hash}`);
  await expect(
    page.getByRole("heading", { name: "계정·기기 동기화", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("만료");
  await expect(
    page.getByRole("button", { name: "로그인 메일 받기", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain("access_token");
  expect(page.url()).not.toContain("refresh_token");
  const saved = await records(page);
  expect(saved.auth).toBeNull();
  expect(saved.account).toBeNull();
  expect(saved.meta).toBeNull();
  expect(saved.original.state).toEqual(anonymous);
  expect(network).toEqual({ users: 0, pulls: 0, pushes: 0, forbidden: [] });
});
