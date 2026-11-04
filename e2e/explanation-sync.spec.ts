import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { initialOriginalState, startSession, defaultSelection, answer, finish } from "../src/original/engine";
import { explanationSyncFixture } from "../tests/fixtures/explanation-sync";

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const URL = "https://sync.test";
const OWNER = `${URL}|${UID}`;

/** Independent browser IDBs share only this synthetic private service. */
class ExplanationCloud {
  objects = new Map<string, Buffer>();
  unavailable = new Set<BrowserContext>();
  async attach(context: BrowserContext) {
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new globalThis.URL(request.url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
      if (url.hostname !== "sync.test") return route.abort("blockedbyclient");
      if (this.unavailable.has(context)) return route.abort("internetdisconnected");
      const headers = {
        "access-control-allow-origin": "*", "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      const json = (data: unknown, status = 200) => route.fulfill({
        status, headers, contentType: "application/json", body: JSON.stringify(data),
      });
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const id = request.headers().authorization?.replace("Bearer access:", "") ?? "";
      if (![UID, OTHER].includes(id)) return json({ message: "unauthorized" }, 401);
      const body = () => JSON.parse(request.postData() ?? "{}");
      if (url.pathname === "/storage/v1/object/list/police-sync-private") {
        const input = body(), prefix = `${input.prefix}/`;
        if (!prefix.startsWith(`${id}/real/`)) return json({ message: "forbidden" }, 403);
        return json([...this.objects.keys()].filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)).filter((name) => !name.includes("/"))
          .sort().slice(input.offset, input.offset + input.limit).map((name) => ({ name, id: name })));
      }
      const object = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?police-sync-private\/(.+)$/);
      if (object) {
        const path = object[1];
        if (!path.startsWith(`${id}/real/`)) return json({ message: "forbidden" }, 403);
        if (request.method() === "POST") {
          if (this.objects.has(path)) return json({ message: "duplicate" }, 409);
          const bytes = request.postDataBuffer()!;
          if (bytes.length > 1048576) return json({ message: "bucket size limit" }, 413);
          this.objects.set(path, bytes);
          return json({ Key: path });
        }
        const bytes = this.objects.get(path);
        return bytes ? route.fulfill({ status: 200, headers, contentType: "application/octet-stream", body: bytes })
          : json({ message: "missing" }, 404);
      }
      if (url.pathname.endsWith("_sync_pull")) return json({
        events: [], cursor: body().p_after, bankVersion: 0, serverTime: new Date().toISOString(),
      });
      if (url.pathname === "/auth/v1/user") return json({ id });
      if (url.pathname === "/auth/v1/logout") return json({});
      return json({ message: "unknown synthetic endpoint" }, 404);
    });
  }
  manifests(id = UID) {
    return [...this.objects.keys()].filter((path) => path.startsWith(`${id}/real/explanations/manifests/`));
  }
}

async function seed(page: Page, id = UID) {
  const { source } = await explanationSyncFixture();
  const state = initialOriginalState("real");
  state.data = { questions: source.questions, assets: source.assets, packages: [source] };
  const session = startSession(state, "real", defaultSelection, "study", Date.parse("2026-11-04T00:00:00Z"), [source.questions[0]]);
  answer(state, session.id, "unknown", Date.parse("2026-11-04T00:00:01Z"));
  finish(state, session.id, Date.parse("2026-11-04T00:00:02Z"));
  await page.goto("/?view=original&mode=real");
  await page.evaluate(async ({ id, state, server }) => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("police-ox-storage", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("states");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result, t = db.transaction("states", "readwrite"), store = t.objectStore("states");
        store.put({ url: server, key: "sb_publishable_TEST_ONLY" }, "sync:public-config");
        store.put({ access_token: `access:${id}`, refresh_token: `refresh:${id}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id, email: `${id === "11111111-1111-4111-8111-111111111111" ? "owner" : "other"}@example.com` },
        }, `sync:auth:${server}`);
        store.put({ generation: 1, state }, `original:real:user:${server}|${id}`);
        t.oncomplete = () => { db.close(); resolve(); };
        t.onabort = t.onerror = () => reject(t.error);
      };
    });
  }, { id, state, server: URL });
  await page.reload();
  await expect(page.getByRole("heading", { name: "원문 기출 학습", exact: true })).toBeVisible();
  return state;
}

async function library(page: Page, owner = OWNER) {
  return page.evaluate(async (owner) => new Promise<any>((resolve, reject) => {
    const r = indexedDB.open("police-original-explanations");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("instructorCollections")) { db.close(); resolve(null); return; }
      const t = db.transaction("instructorCollections", "readonly"), value = t.objectStore("instructorCollections").get(JSON.stringify([owner, "real"]));
      t.oncomplete = () => { db.close(); resolve(value.result ?? null); };
      t.onabort = t.onerror = () => reject(t.error);
    };
  }), owner);
}

async function importInstructor(page: Page, pkg: Awaited<ReturnType<typeof explanationSyncFixture>>["instructor"]) {
  const settings = page.getByRole("button", { name: "데이터·설정", exact: true });
  const menu = page.getByRole("button", { name: "메뉴", exact: true });
  if (!(await settings.isVisible())) await menu.click();
  await settings.click();
  await page.getByLabel("강사 해설 JSON 가져오기", { exact: true }).setInputFiles({
    name: "TEST_ONLY.instructor.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(pkg)),
  });
  await page.getByRole("button", { name: "기존 해설을 교체하고 가져오기", exact: true }).click();
  await expect(page.getByText("강사 해설을 저장하고 이전 등록 해설을 교체했습니다. 문제·정답·학습 기록은 유지했습니다.", { exact: true })).toBeVisible();
}

test("PC의 해설을 새 태블릿 계정으로 공유하고 오프라인 수정은 재연결 후 전송한다", async ({ browser }) => {
  test.setTimeout(60000);
  const cloud = new ExplanationCloud();
  const pc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tablet = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const other = await browser.newContext();
  try {
    await Promise.all([cloud.attach(pc), cloud.attach(tablet), cloud.attach(other)]);
    const p = await pc.newPage(), t = await tablet.newPage(), o = await other.newPage();
    const pcBefore = await seed(p);
    const { instructor } = await explanationSyncFixture();
    await importInstructor(p, instructor);
    await expect.poll(() => cloud.manifests().length).toBe(1);
    const tabletBefore = await seed(t);
    await expect.poll(async () => (await library(t))?.packages).toEqual([instructor]);
    // Reload with the private sync service unavailable. The dev server serves
    // only the shell; production PWA tests separately verify its offline cache.
    cloud.unavailable.add(tablet);
    await t.reload();
    await expect.poll(async () => (await library(t))?.packages).toEqual([instructor]);
    await t.getByRole("button", { name: "데이터·설정", exact: true }).click();
    await expect(t.getByRole("button", { name: "강사 해설 내보내기", exact: true })).toHaveCount(1);
    const download = t.waitForEvent("download");
    await t.getByRole("button", { name: "강사 해설 내보내기", exact: true }).click();
    expect(JSON.parse(readFileSync((await (await download).path())!, "utf8"))).toEqual(instructor);
    const updated = structuredClone(instructor);
    updated.packageVersion++;
    updated.records[0].revision++;
    updated.records[0].blocks[0] = { ...updated.records[0].blocks[0], type: "text", role: "explanation", text: "TEST_ONLY 오프라인에서 저장한 새 도형 해설" };
    await pc.setOffline(true);
    await importInstructor(p, updated);
    await expect.poll(async () => (await library(p))?.packages[0]?.packageVersion).toBe(2);
    expect(cloud.manifests()).toHaveLength(1);
    await pc.setOffline(false);
    await p.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => cloud.manifests().length).toBe(2);
    cloud.unavailable.delete(tablet);
    await t.evaluate(() => window.dispatchEvent(new Event("online")));
    await t.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => (await library(t))?.packages[0]?.packageVersion).toBe(2);
    await seed(o, OTHER);
    await o.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => (await library(o, `${URL}|${OTHER}`))?.packages ?? []).toEqual([]);
    expect(cloud.manifests(OTHER)).toHaveLength(0);
    for (const [page, before] of [[p, pcBefore], [t, tabletBefore]] as const) {
      const account = await page.evaluate(async (owner) => new Promise<any>((resolve, reject) => {
        const r = indexedDB.open("police-ox-storage", 1);
        r.onsuccess = () => {
          const db = r.result, t = db.transaction("states", "readonly"), value = t.objectStore("states").get(`original:real:user:${owner}`);
          t.oncomplete = () => { db.close(); resolve(value.result.state); };
          t.onerror = () => reject(t.error);
        };
      }), OWNER);
      expect(account.data.questions).toEqual(before.data.questions);
      expect(account.attempts).toEqual(before.attempts);
      expect(account.sessions).toEqual(before.sessions);
      expect(account.sessions[0].status).toBe("completed");
      expect(account.attempts).toHaveLength(1);
    }
  } finally {
    await Promise.all([pc.close(), tablet.close(), other.close()]);
  }
});
