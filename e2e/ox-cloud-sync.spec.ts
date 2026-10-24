import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { canonical, defaultSelection, type State } from "../src/domain/schema";
import { initialState } from "../src/fixtures/data";
import { startSession, submit, markKey } from "../src/domain/engine";
import { backup, validateBackup } from "../src/data/transfer";

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OWNER = `https://sync.test|${UID}`;

/** Fake auth/storage/RPC only: these browser tests never contact Supabase.
 * Separate contexts have independent IDB and only share this fake service. */
class FakeOxCloud {
  objects = new Map<string, Buffer>();
  spaces = new Map<
    string,
    { events: any[]; bankVersion: number; marks: Record<string, number> }
  >();
  paused = false;
  loseNextResponse = false;
  space(uid = UID, ox = true) {
    const key = `${uid}:${ox ? "ox" : "original"}`;
    if (!this.spaces.has(key))
      this.spaces.set(key, { events: [], bankVersion: 0, marks: {} });
    return this.spaces.get(key)!;
  }
  async attach(context: BrowserContext) {
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
        return route.continue();
      if (url.hostname !== "sync.test") return route.abort("blockedbyclient");
      const method = request.method();
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      const json = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          headers,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (this.paused) return route.abort("internetdisconnected");
      const body = () => JSON.parse(request.postData() ?? "{}");
      const uid =
        request.headers().authorization?.replace("Bearer access:", "") ?? "";
      if (url.pathname === "/auth/v1/otp") return json({});
      if (["/auth/v1/verify", "/auth/v1/token"].includes(url.pathname)) {
        const value = body(),
          id = String(value.email ?? value.refresh_token).includes("other")
            ? OTHER
            : UID;
        return json({
          access_token: `access:${id}`,
          refresh_token: id === OTHER ? "other-refresh" : "owner-refresh",
          expires_in: 3600,
          user: {
            id,
            email: id === OTHER ? "other@example.com" : "owner@example.com",
          },
        });
      }
      if (![UID, OTHER].includes(uid))
        return json({ message: "unauthorized" }, 401);
      if (url.pathname === "/auth/v1/logout") return json({});
      const object = url.pathname.match(
        /^\/storage\/v1\/object\/(?:authenticated\/)?(police-(?:ox-)?sync-private)\/(.+)$/,
      );
      if (object) {
        const [, bucket, path] = object,
          expected =
            bucket === "police-ox-sync-private" ? `${uid}/ox/` : `${uid}/real/`;
        if (!path.startsWith(expected))
          return json({ message: "forbidden" }, 403);
        const key = `${bucket}/${path}`;
        if (method === "POST") {
          if (this.objects.has(key)) return json({ message: "duplicate" }, 409);
          this.objects.set(key, request.postDataBuffer()!);
          return json({ Key: path });
        }
        const bytes = this.objects.get(key);
        return bytes
          ? route.fulfill({
              status: 200,
              headers,
              contentType: "application/octet-stream",
              body: bytes,
            })
          : json({ message: "missing" }, 404);
      }
      const ox = url.pathname.includes("police_ox_sync_"),
        user = this.space(uid, ox);
      if (url.pathname.endsWith("_sync_pull")) {
        const input = body(),
          events = user.events
            .filter((e) => e.seq > input.p_after)
            .slice(0, input.p_limit);
        return json({
          events,
          cursor: events.at(-1)?.seq ?? input.p_after,
          bankVersion: user.bankVersion,
          serverTime: new Date().toISOString(),
        });
      }
      if (url.pathname.endsWith("_sync_push")) {
        const event = body().p_event,
          old = user.events.find((e) => e.event.eventId === event.eventId);
        if (old)
          return canonical(old.event) === canonical(event)
            ? json({
                ...old,
                duplicate: true,
                serverTime: new Date().toISOString(),
              })
            : json({ message: "event_id_conflict" }, 409);
        const bucket = ox ? "police-ox-sync-private" : "police-sync-private";
        if (!this.objects.has(`${bucket}/${event.bodyPath}`))
          return json({ message: "missing_body" }, 400);
        if (event.kind === "bank" && event.baseVersion !== user.bankVersion)
          return json({ message: "bank_version_conflict" }, 409);
        if (
          event.kind === "mark" &&
          event.baseMarkVersion !== (user.marks[event.markQuestionId] ?? 0)
        )
          return json({ message: "mark_version_conflict" }, 409);
        if (event.kind === "bank") user.bankVersion++;
        const markVersion =
          event.kind === "mark"
            ? (user.marks[event.markQuestionId] =
                (user.marks[event.markQuestionId] ?? 0) + 1)
            : undefined;
        const received = {
          seq: user.events.length + 1,
          bankVersion: user.bankVersion,
          markVersion,
          event,
        };
        user.events.push(received);
        if (ox && this.loseNextResponse) {
          this.loseNextResponse = false;
          return route.abort("connectionreset");
        }
        return json({
          ...received,
          duplicate: false,
          serverTime: new Date().toISOString(),
        });
      }
      return json({ message: "unknown fake endpoint" }, 404);
    });
  }
}

function oldFixture() {
  const state = initialState(true);
  state.dataset.datasetId = "TEST_ONLY_ox_sync";
  state.settings.fontScale = 1.5;
  startSession(state, defaultSelection);
  state.sessions[0].id = "TEST_ONLY_legacy_session";
  submit(state, state.sessions[0].id, "unknown");
  state.attempts[0].attemptId = "TEST_ONLY_legacy_attempt";
  state.sessions[0].status = "ended";
  state.marks[markKey(state.dataset.items[0].id, "current")] = true;
  return validateBackup(backup(state, "real"), "real");
}
async function readValue(page: Page, key: string) {
  return page.evaluate(
    (key) =>
      new Promise<any>((resolve, reject) => {
        const r = indexedDB.open("police-ox-storage", 1);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("states", "readonly"),
            get = tx.objectStore("states").get(key);
          tx.oncomplete = () => {
            resolve(get.result ?? null);
            db.close();
          };
          tx.onerror = () => reject(tx.error);
        };
        r.onerror = () => reject(r.error);
      }),
    key,
  );
}
const stored = (page: Page, owner = OWNER) =>
  readValue(page, `ox:real:user:${owner}`).then(
    (v) => v?.state as State | undefined,
  );
const metadata = (page: Page) => readValue(page, `ox-sync:real:user:${OWNER}`);
async function originalNav(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true }),
    menu = page.getByRole("button", { name: "메뉴", exact: true });
  await expect(button.or(menu)).toBeEnabled();
  if (!(await button.isVisible())) await menu.click();
  await button.click();
}
async function login(page: Page, email = "owner@example.com") {
  page.setDefaultTimeout(10_000);
  await page.goto("/?view=original&mode=real&panel=cloud");
  const url = page.getByLabel("Supabase 프로젝트 URL", { exact: true });
  if (!(await url.isVisible()))
    await page.getByText("동기화 서버 연결 설정", { exact: true }).click();
  await url.fill("https://sync.test");
  await page
    .getByLabel("공개용 publishable key", { exact: true })
    .fill("sb_publishable_TEST_ONLY");
  await page
    .getByRole("button", { name: "공개 연결값 저장", exact: true })
    .click();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "로그인 메일 받기", exact: true })
    .click();
  await page.getByLabel("이메일 인증번호", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "로그아웃", exact: true }),
  ).toBeVisible();
  await page.goto("/?view=ox&mode=real");
  await expect(
    page.getByRole("button", { name: "계정·기기 동기화", exact: true }),
  ).toBeEnabled();
}
async function sync(page: Page) {
  await page
    .getByRole("button", { name: "계정·기기 동기화", exact: true })
    .click();
  const button = page.getByRole("button", { name: "지금 동기화", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
}
async function importExisting(page: Page, state: State) {
  await page
    .getByRole("button", { name: "계정·기기 동기화", exact: true })
    .click();
  await page.getByLabel("기존 OX 전체 백업", { exact: true }).setInputFiles({
    name: "TEST_ONLY_ox_backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup(state, "real"))),
  });
  await expect(
    page.getByRole("region", { name: "OX 기록 연결 미리보기" }),
  ).toContainText("완료·종료 세션 1개 · 응답 1개");
  await page
    .getByRole("button", {
      name: "미리보기 확인하고 OX 계정에 연결",
      exact: true,
    })
    .click();
  await sync(page);
}

test("fake service: OX 로그인 전 자료 보존, 두 기기 병합·중복 재시도와 계정 분리", async ({
  browser,
}) => {
  test.setTimeout(100_000);
  const fake = new FakeOxCloud(),
    pc = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    tablet = await browser.newContext({
      viewport: { width: 800, height: 1280 },
      hasTouch: true,
    });
  await fake.attach(pc);
  await fake.attach(tablet);
  const a = await pc.newPage(),
    b = await tablet.newPage(),
    legacy = oldFixture();
  await a.goto("/?view=ox&mode=real");
  await a.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await a.getByLabel("전체 백업 복구", { exact: true }).setInputFiles({
    name: "TEST_ONLY_legacy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup(legacy, "real"))),
  });
  await a.getByRole("button", { name: "확인하고 적용", exact: true }).click();
  await expect(
    a.getByText("검증한 데이터를 저장했습니다.", { exact: true }),
  ).toBeVisible();
  const preserved = await readValue(a, "real");
  await login(a);
  expect(fake.space().events).toHaveLength(0);
  expect((await stored(a))?.attempts ?? []).toHaveLength(0);
  await a
    .getByRole("button", { name: "계정·기기 동기화", exact: true })
    .click();
  await a
    .getByRole("button", { name: "로그인 전 OX 기록 미리보기", exact: true })
    .click();
  await expect(
    a.getByRole("region", { name: "OX 기록 연결 미리보기" }),
  ).toContainText("지문 7개");
  fake.loseNextResponse = true;
  await a
    .getByRole("button", {
      name: "미리보기 확인하고 OX 계정에 연결",
      exact: true,
    })
    .click();
  await sync(a);
  await sync(a);
  await expect.poll(async () => (await metadata(a))?.outbox.length).toBe(0);
  await login(b);
  await sync(b);
  await expect
    .poll(async () => (await stored(b))?.dataset.items.length)
    .toBe(7);
  expect((await stored(b))?.attempts).toEqual(preserved.state.attempts);
  expect((await stored(b))?.sessions[0].id).toBe("TEST_ONLY_legacy_session");
  expect((await stored(b))?.settings.fontScale).toBe(1);
  expect(await readValue(a, "real")).toEqual(preserved);
  await importExisting(a, legacy);
  await sync(b);
  expect((await stored(b))?.attempts).toHaveLength(1);
  expect((await stored(b))?.sessions).toHaveLength(1);
  expect(new Set(fake.space().events.map((e) => e.event.eventId)).size).toBe(
    fake.space().events.length,
  );
  expect(fake.space(UID, false).events).toHaveLength(0);
  await b.goto("/?view=original&mode=real&panel=cloud");
  await b.getByRole("button", { name: "로그아웃", exact: true }).click();
  await login(b, "other@example.com");
  await sync(b);
  expect(
    (await stored(b, `https://sync.test|${OTHER}`))?.attempts ?? [],
  ).toHaveLength(0);
  expect((await stored(b))?.attempts).toHaveLength(1);
  expect(fake.space(OTHER).events).toHaveLength(0);
  await pc.close();
  await tablet.close();
});

test("fake service: OX 진행 중 응답은 로컬에 남고 오프라인 종료 기록·표시는 재실행 후 수신한다", async ({
  browser,
}) => {
  test.setTimeout(100_000);
  const fake = new FakeOxCloud(),
    pc = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    tablet = await browser.newContext({
      viewport: { width: 800, height: 1280 },
    });
  await fake.attach(pc);
  await fake.attach(tablet);
  const a = await pc.newPage(),
    b = await tablet.newPage();
  await login(a);
  await importExisting(a, oldFixture());
  await login(b);
  await sync(b);
  await a.getByRole("button", { name: "범위 선택", exact: true }).click();
  await a.getByRole("button", { name: "학습 시작", exact: true }).click();
  await a.getByRole("button", { name: "모르겠음", exact: true }).click();
  await expect.poll(async () => (await stored(a))?.attempts.length).toBe(2);
  await sync(b);
  expect((await stored(b))?.attempts).toHaveLength(1);
  await a
    .getByRole("button", { name: /다시 보기 해제|☆ 다시 보기/, exact: true })
    .click();
  fake.paused = true;
  await pc.setOffline(true);
  await a
    .getByRole("button", { name: "학습 마치고 동기화", exact: true })
    .click();
  await expect(
    a.getByRole("heading", { name: "오늘도 한 걸음 쌓았어요.", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await metadata(a))?.outbox.filter((e: any) => e.kind === "session")
          .length,
    )
    .toBe(1);
  const queued = (await metadata(a)).outbox.map((e: any) => e.eventId);
  await pc.setOffline(false);
  await a.reload();
  await expect(
    a.getByRole("button", { name: "계정·기기 동기화", exact: true }),
  ).toBeEnabled();
  expect((await metadata(a)).outbox.map((e: any) => e.eventId)).toEqual(queued);
  fake.paused = false;
  await sync(a);
  await sync(b);
  await expect.poll(async () => (await stored(b))?.attempts.length).toBe(2);
  expect(
    (await stored(b))?.sessions.filter((s) => s.status === "active"),
  ).toHaveLength(0);
  expect((await stored(b))?.sessions).toHaveLength(2);
  expect((await stored(b))?.marks).toEqual((await stored(a))?.marks);
  expect(
    (await stored(b))?.attempts.filter((v) => v.response === "unknown"),
  ).toHaveLength(2);
  expect((await metadata(a)).outbox).toHaveLength(0);
  await b.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await expect(
    b.getByRole("heading", { name: "데이터·설정", exact: true }),
  ).toBeVisible();
  await b.getByLabel("글자 크기").selectOption("2");
  await b
    .getByRole("button", { name: "계정·기기 동기화", exact: true })
    .click();
  expect(
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await b.screenshot({
    path: "test-results/ox-cloud-tablet-200.png",
    fullPage: true,
  });
  // Reset only this device's cycle, preserving closed records with local cycle refs.
  await a.getByRole("button", { name: "데이터·설정", exact: true }).click();
  a.once("dialog", (dialog) => dialog.accept());
  await a
    .getByRole("button", { name: "이 기기 순회 초기화", exact: true })
    .click();
  await expect(
    a.getByText("이 기기의 순회와 배정만 초기화했습니다.", { exact: true }),
  ).toBeVisible();
  expect((await stored(a))?.attempts).toHaveLength(2);
  await a.getByRole("button", { name: "범위 선택", exact: true }).click();
  await a.getByRole("button", { name: "학습 시작", exact: true }).click();
  await a.getByRole("button", { name: "모르겠음", exact: true }).click();
  // Deletion removes shared bank entries, while preserving historical snapshots.
  await b.getByRole("button", { name: "데이터·설정", exact: true }).click();
  await b.getByRole("button", { name: "삭제 대상 확인", exact: true }).click();
  await expect(
    b.getByRole("region", { name: "문제 삭제 미리보기", exact: true }),
  ).toContainText("과거 응답·완료 세션·문항 스냅샷은 보존합니다.");
  await b.getByRole("button", { name: "문제 7개 삭제", exact: true }).click();
  await expect
    .poll(async () => (await stored(b))?.dataset.items.length)
    .toBe(0);
  expect((await stored(b))?.attempts).toHaveLength(2);
  await sync(b);
  await sync(a);
  expect((await stored(a))?.dataset.items).toHaveLength(7);
  expect(
    (await stored(a))?.sessions.filter((s) => s.status === "active"),
  ).toHaveLength(1);
  await expect
    .poll(async () => (await metadata(a))?.projection.deferred.length)
    .toBeGreaterThan(0);
  await a.getByRole("button", { name: "학습 홈", exact: true }).click();
  await a.getByRole("button", { name: "이어 풀기", exact: true }).click();
  await a
    .getByRole("button", { name: "학습 마치고 동기화", exact: true })
    .click();
  await sync(a);
  await sync(b);
  await expect
    .poll(async () => (await stored(a))?.dataset.items.length)
    .toBe(0);
  await expect.poll(async () => (await stored(b))?.attempts.length).toBe(3);
  expect((await stored(a))?.attempts).toHaveLength(3);
  expect((await stored(a))?.sessions).toHaveLength(3);
  await importExisting(a, oldFixture());
  await sync(b);
  expect((await stored(a))?.dataset.items).toHaveLength(0);
  expect((await stored(b))?.dataset.items).toHaveLength(0);
  expect((await stored(b))?.attempts).toHaveLength(3);
  await pc.close();
  await tablet.close();
});
