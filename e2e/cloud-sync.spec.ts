import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { canonical } from "../src/domain/schema";
import {
  initialOriginalState,
  startSession,
  defaultSelection,
  answer,
  finish,
} from "../src/original/engine";
import { validateOriginalState } from "../src/original/storage";
import { expectedQuestionId, subjectLabels } from "../src/original/validation";
import { backup as oxBackup } from "../src/data/transfer";
import { initialState } from "../src/fixtures/data";
import type { WireEvent } from "../src/original/sync/types";

const UID = "11111111-1111-4111-8111-111111111111",
  OTHER = "22222222-2222-4222-8222-222222222222";
const OWNER = `https://sync.test|${UID}`;
/** A deliberately fake service. This exercises real fetch/IDB/UI boundaries,
 * not Supabase RLS or real email delivery. See supabase/rls-tests.sql for that. */
class FakeCloud {
  objects = new Map<string, Buffer>();
  users = new Map<
    string,
    { events: any[]; bankVersion: number; marks: Record<string, number> }
  >();
  loseNextPushResponse = false;
  paused = false;
  async attach(context: BrowserContext) {
    await context.route("https://sync.test/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
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
      if (
        url.pathname === "/auth/v1/verify" ||
        url.pathname === "/auth/v1/token"
      ) {
        const input = body(),
          id = String(input.email ?? input.refresh_token).includes("other")
            ? OTHER
            : UID;
        return json({
          access_token: `access:${id}`,
          refresh_token: id === OTHER ? "other-refresh" : "own-refresh",
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
      const storage = url.pathname.match(
        /^\/storage\/v1\/object\/(?:authenticated\/)?police-sync-private\/(.+)$/,
      );
      if (storage) {
        const path = storage[1];
        if (!path.startsWith(`${uid}/real/`))
          return json({ message: "forbidden" }, 403);
        if (method === "POST") {
          if (this.objects.has(path))
            return json({ message: "duplicate" }, 409);
          this.objects.set(path, request.postDataBuffer()!);
          return json({ Key: path });
        }
        const bytes = this.objects.get(path);
        return bytes
          ? route.fulfill({
              status: 200,
              headers,
              contentType: "application/octet-stream",
              body: bytes,
            })
          : json({ message: "missing" }, 404);
      }
      // The shared account panel also starts OX sync. This original-question
      // fixture has no OX events; keep its namespace empty and independent.
      if (url.pathname.endsWith("/police_ox_sync_pull"))
        return json({
          events: [],
          cursor: body().p_after,
          bankVersion: 0,
          serverTime: new Date().toISOString(),
        });
      const user = this.users.get(uid) ?? {
        events: [],
        bankVersion: 0,
        marks: {},
      };
      this.users.set(uid, user);
      if (url.pathname.endsWith("/police_sync_pull")) {
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
      if (url.pathname.endsWith("/police_sync_push")) {
        const event = body().p_event as WireEvent;
        const old = user.events.find((e) => e.event.eventId === event.eventId);
        if (old)
          return canonical(old.event) === canonical(event)
            ? json({
                ...old,
                duplicate: true,
                serverTime: new Date().toISOString(),
              })
            : json({ message: "event_id_conflict" }, 409);
        if (
          !this.objects.has(event.bodyPath) ||
          !event.bodyPath.startsWith(`${uid}/real/`)
        )
          return json({ message: "missing_body" }, 400);
        if (event.kind === "bank" && event.baseVersion !== user.bankVersion)
          return json({ message: "bank_version_conflict" }, 409);
        if (
          event.kind === "mark" &&
          event.baseMarkVersion !== (user.marks[event.markQuestionId!] ?? 0)
        )
          return json({ message: "mark_version_conflict" }, 409);
        if (event.kind === "bank") user.bankVersion++;
        const markVersion =
          event.kind === "mark"
            ? (user.marks[event.markQuestionId!] =
                (user.marks[event.markQuestionId!] ?? 0) + 1)
            : undefined;
        const received = {
          seq: user.events.length + 1,
          bankVersion: user.bankVersion,
          markVersion,
          event,
        };
        user.events.push(received);
        if (this.loseNextPushResponse) {
          this.loseNextPushResponse = false;
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
async function fixture() {
  const state = initialOriginalState("demo");
  for (const q of state.data.questions) {
    q.source.examCode = "po";
    q.id = expectedQuestionId(q);
    q.source.examName = "동기화 검증용 도형·색상 시연 자료";
    q.source.questionPdf = { fileName: "TEST_ONLY_question.pdf", pages: [1] };
    q.source.answerPdf = {
      fileName: "TEST_ONLY_answer.pdf",
      pages: [1],
      subjectColumn: subjectLabels[q.subjectId],
    };
    q.officialAnswer.status = "final";
  }
  state.data.packages[0].dataKind = "real";
  state.data.packages[0].packageId = "TEST_ONLY_sync";
  state.data.packages[0].questions = structuredClone(state.data.questions);
  const q = state.data.questions[0],
    s = startSession(
      state,
      "real",
      defaultSelection,
      "study",
      Date.parse("2026-10-21T00:00:00Z"),
      [q],
    );
  answer(state, s.id, "unknown", Date.parse("2026-10-21T00:00:01Z"));
  finish(state, s.id, Date.parse("2026-10-21T00:00:02Z"));
  return validateOriginalState(state, "real");
}
async function nav(page: Page, label: string) {
  const menu = page.getByRole("button", { name: "메뉴", exact: true }),
    target = page.getByRole("button", { name: label, exact: true });
  await expect(target.or(menu)).toBeEnabled();
  if (!(await target.isVisible())) await menu.click();
  await target.click();
}
async function login(page: Page, email = "owner@example.com") {
  page.setDefaultTimeout(10000);
  await page.goto("http://127.0.0.1:5173/?view=original&mode=real");
  await nav(page, "계정·기기 동기화");
  const projectUrl = page.getByLabel("Supabase 프로젝트 URL", { exact: true });
  if (!(await projectUrl.isVisible()))
    await page.getByText("동기화 서버 연결 설정", { exact: true }).click();
  await page
    .getByLabel("Supabase 프로젝트 URL", { exact: true })
    .fill("https://sync.test");
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
  await expect(
    page.getByLabel("이메일 인증번호", { exact: true }),
    await page.locator("main").innerText(),
  ).toBeVisible();
  await page.getByLabel("이메일 인증번호", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "원문 기출 학습", exact: true }),
  ).toBeVisible();
  await nav(page, "계정·기기 동기화");
  // Wait for both account status blocks before interacting lower in the page.
  // Otherwise the OX startup status can reflow a preview button mid-click.
  await expect(
    page.getByRole("region", { name: "OX 동기화 바로가기", exact: true }),
  ).toContainText("OX 동기화 완료");
}
async function stored(page: Page, id = OWNER) {
  return page.evaluate(
    async (owner) =>
      new Promise<any>((resolve, reject) => {
        const r = indexedDB.open("police-ox-storage", 1);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("states", "readonly"),
            get = tx.objectStore("states").get(`original:real:user:${owner}`);
          tx.oncomplete = () => {
            resolve(get.result?.state ?? null);
            db.close();
          };
          tx.onerror = () => reject(tx.error);
        };
        r.onerror = () => reject(r.error);
      }),
    id,
  );
}
async function metadata(page: Page) {
  return page.evaluate(
    async (owner) =>
      new Promise<any>((resolve) => {
        const r = indexedDB.open("police-ox-storage", 1);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("states", "readonly"),
            get = tx.objectStore("states").get(`sync:real:user:${owner}`);
          tx.oncomplete = () => {
            resolve(get.result);
            db.close();
          };
        };
      }),
    OWNER,
  );
}
async function sync(page: Page) {
  await nav(page, "계정·기기 동기화");
  await page.getByRole("button", { name: "지금 동기화", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "지금 동기화", exact: true }),
  ).toBeEnabled();
}
async function uploadBackup(page: Page, existing?: any) {
  const state = existing?.original ?? (await fixture()),
    backup = existing ?? {
      format: "police-learning-backup",
      backupVersion: 2,
      namespace: "real",
      exportedAt: new Date().toISOString(),
      original: state,
      ox: oxBackup(initialState(false), "real"),
      generations: { original: 0, ox: 0 },
    };
  await page
    .getByLabel("기존 PC 실제 학습 백업", { exact: true })
    .setInputFiles({
      name: "TEST_ONLY_sync-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
  await expect(
    page.getByRole("region", { name: "기록 연결 미리보기", exact: true }),
  ).toContainText("완료·종료 세션 1개");
  await page
    .getByRole("button", { name: "미리보기 확인하고 계정에 연결", exact: true })
    .click();
  await expect.poll(async () => (await stored(page))?.sessions.length).toBe(1);
  await sync(page);
  return backup;
}
test("fake service: 두 독립 기기의 문제은행·완료 기록과 재시도 멱등성, 계정 경계", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = new FakeCloud(),
    pc = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    tablet = await browser.newContext({
      viewport: { width: 800, height: 1280 },
      hasTouch: true,
    });
  await fake.attach(pc);
  await fake.attach(tablet);
  const a = await pc.newPage(),
    b = await tablet.newPage();
  await login(a);
  expect(fake.users.get(UID)?.events.length ?? 0).toBe(0);
  fake.loseNextPushResponse = true;
  const backup = await uploadBackup(a);
  await sync(a);
  await expect.poll(async () => (await metadata(a))?.outbox.length).toBe(0);
  await login(b);
  await sync(b);
  await expect
    .poll(async () => (await stored(b))?.data.questions.length)
    .toBe(100);
  expect((await stored(b)).attempts).toHaveLength(1);
  expect((await stored(b)).settings.fontScale).toBe(1);
  const ids = fake.users.get(UID)!.events.map((e) => e.event.eventId);
  expect(new Set(ids).size).toBe(ids.length);
  await uploadBackup(a, backup);
  await sync(a);
  await sync(b);
  expect((await stored(b)).sessions).toHaveLength(1);
  expect((await stored(b)).attempts).toHaveLength(1);
  await nav(a, "학습 현황");
  await a
    .locator('article[aria-label$=" 현황"][data-unit-code="CONST-01"]')
    .getByRole("button", { name: /복습/ })
    .click();
  await a.getByRole("button", { name: "모르겠음 제출", exact: true }).click();
  await expect.poll(async () => (await stored(a)).attempts.length).toBe(2);
  await sync(b);
  expect((await stored(b)).attempts).toHaveLength(1);
  await a
    .getByRole("button", { name: "학습 마치고 동기화", exact: true })
    .click();
  await a
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(시험 제출|학습 종료) 확정$/ })
    .click();
  await expect(
    a.getByRole("heading", { name: /학습 결과|풀이 결과/ }),
  ).toBeVisible();
  await sync(a);
  await sync(b);
  await expect.poll(async () => (await stored(b)).attempts.length).toBe(2);
  await nav(b, "계정·기기 동기화");
  await b.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(
    b.getByRole("heading", { name: "원문 기출 학습", exact: true }),
  ).toBeVisible();
  await nav(b, "계정·기기 동기화");
  await b.getByLabel("이메일", { exact: true }).fill("other@example.com");
  await b
    .getByRole("button", { name: "로그인 메일 받기", exact: true })
    .click();
  await b.getByLabel("이메일 인증번호", { exact: true }).fill("123456");
  await b.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    b.getByRole("heading", { name: "원문 기출 학습", exact: true }),
  ).toBeVisible();
  await sync(b);
  expect(fake.users.get(OTHER)?.events.length ?? 0).toBe(0);
  expect(
    (await stored(b, `https://sync.test|${OTHER}`))?.attempts ?? [],
  ).toHaveLength(0);
  expect((await stored(b))?.attempts).toHaveLength(2);
  await pc.close();
  await tablet.close();
});

test("fake service: 오프라인 완료 기록은 재실행 후 합쳐지고 불명확한 순서는 실제 응답 선택으로 수렴한다", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = new FakeCloud(),
    pc = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    tab = await browser.newContext({ viewport: { width: 800, height: 1280 } });
  await fake.attach(pc);
  await fake.attach(tab);
  const a = await pc.newPage(),
    b = await tab.newPage();
  await login(a);
  const backup = await uploadBackup(a);
  await login(b);
  await sync(b);
  for (const page of [a, b]) {
    await page.evaluate(
      async (owner) =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("police-ox-storage", 1);
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction("states", "readwrite"),
              s = tx.objectStore("states"),
              get = s.get(`sync:real:user:${owner}`);
            get.onsuccess = () => {
              const m = get.result;
              m.clock = null;
              m.revision = (m.revision ?? 0) + 1;
              s.put(m, `sync:real:user:${owner}`);
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = tx.onerror = () => reject(tx.error);
          };
        }),
      OWNER,
    );
    await nav(page, "학습 현황");
    await page
      .locator('article[aria-label$=" 현황"][data-unit-code="CONST-01"]')
      .getByRole("button", { name: /복습/ })
      .click();
  }
  fake.paused = true;
  await pc.setOffline(true);
  await tab.setOffline(true);
  const correct =
      backup.original.data.questions[0].officialAnswer.acceptedChoices[0],
    wrong = (correct % 4) + 1;
  for (const [page, value] of [
    [a, correct],
    [b, wrong],
  ] as const) {
    await page
      .getByRole("button", { name: `${value}번 선택`, exact: true })
      .click();
    await page.getByRole("button", { name: "답 제출", exact: true }).click();
    await page.getByRole("button", { name: "학습 종료", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^(시험 제출|학습 종료) 확정$/ })
      .click();
    await expect
      .poll(
        async () =>
          (await metadata(page))?.outbox.filter(
            (e: any) => e.kind === "session",
          ).length,
      )
      .toBe(1);
  }
  const before = (await metadata(a)).outbox.map((e: any) => e.eventId);
  // A new page is a new app instance, but the context's durable outbox survives.
  await pc.setOffline(false);
  await tab.setOffline(false);
  await a.reload();
  await expect(
    a.getByRole("heading", { name: "원문 기출 학습", exact: true }),
  ).toBeVisible();
  expect((await metadata(a)).outbox.map((e: any) => e.eventId)).toEqual(before);
  fake.paused = false;
  await sync(a);
  await sync(b);
  await sync(a);
  for (const page of [a, b]) {
    await expect
      .poll(
        async () => (await metadata(page)).projection.responseConflicts.length,
      )
      .toBe(1);
    expect((await stored(page)).attempts).toHaveLength(3);
    await nav(page, "학습 현황");
    await expect(
      page.locator('article[data-subject-id="constitution"]'),
    ).toContainText(/응답 순서 확인 필요\s*1/);
  }
  await nav(a, "계정·기기 동기화");
  await a.getByRole("button", { name: /정답 기록 선택/ }).click();
  await sync(a);
  await sync(b);
  await sync(a);
  for (const page of [a, b]) {
    await expect
      .poll(
        async () => (await metadata(page)).projection.responseConflicts.length,
      )
      .toBe(0);
    const state = await stored(page);
    expect(state.attempts).toHaveLength(3);
    expect(
      state.attempts
        .filter(
          (v: any) => v.questionId === backup.original.data.questions[0].id,
        )
        .at(-1).result,
    ).toBe("correct");
  }
  await pc.close();
  await tab.close();
});

test("fake service: 원격 삭제·표시 해제는 오래된 기기에서 되살아나지 않고 활성 시험을 종료한 뒤 반영한다", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fake = new FakeCloud(),
    pc = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    tab = await browser.newContext({ viewport: { width: 800, height: 1280 } });
  await fake.attach(pc);
  await fake.attach(tab);
  const a = await pc.newPage(),
    b = await tab.newPage();
  await a.clock.install({ time: new Date() });
  await login(a);
  const backup = await uploadBackup(a);
  await login(b);
  await sync(b);
  await nav(a, "모의고사");
  await a.getByRole("button", { name: "시작하기", exact: true }).click();
  const original = (await stored(a)).sessions.find(
    (s: any) => s.status === "active",
  );
  expect(original.mode).toBe("exam");
  const target = original.questions.findIndex(
    (q: any) => q.id === backup.original.data.questions[0].id,
  );
  await a.getByRole("button", { name: /^답안표 / }).click();
  await a
    .getByRole("button", { name: `${target + 1}번 문항으로 이동`, exact: true })
    .click();
  await a.getByRole("button", { name: "1번 선택", exact: true }).click();
  await pc.setOffline(true);
  await a.getByRole("button", { name: "다시 보기", exact: true }).click();
  await nav(b, "학습 현황");
  await b
    .locator('article[aria-label$=" 현황"][data-unit-code="CONST-01"]')
    .getByRole("button", { name: /복습/ })
    .click();
  await b.getByRole("button", { name: "다시 보기", exact: true }).click();
  await sync(b);
  await nav(b, "학습 홈");
  await b.getByRole("button", { name: /^이어 풀기/ }).click();
  await b.getByRole("button", { name: "다시 보기", exact: true }).click();
  await sync(b);
  await nav(b, "학습 홈");
  await b.getByRole("button", { name: /^이어 풀기/ }).click();
  await b.getByRole("button", { name: "학습 종료", exact: true }).click();
  await b
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(시험 제출|학습 종료) 확정$/ })
    .click();
  await sync(b);
  await nav(b, "데이터·설정");
  await b
    .getByRole("checkbox", { name: "자료 선택: TEST_ONLY_sync", exact: true })
    .check();
  await b
    .getByRole("button", { name: "선택한 데이터 삭제", exact: true })
    .click();
  await b.getByRole("button", { name: "삭제 확정", exact: true }).click();
  await sync(b);
  expect((await stored(b)).data.packages).toHaveLength(0);
  await pc.setOffline(false);
  await sync(a);
  const held = await stored(a);
  expect(held.data.questions).toHaveLength(100);
  expect(held.marks[backup.original.data.questions[0].id]).toBe(false);
  expect(held.sessions.find((s: any) => s.status === "active").deadlineAt).toBe(
    original.deadlineAt,
  );
  expect((await metadata(a)).projection.deferred.length).toBeGreaterThan(0);
  expect(Object.keys((await metadata(a)).failures)).toHaveLength(1);
  await a
    .getByRole("button", { name: "클라우드 표시 상태 유지", exact: true })
    .click();
  await expect
    .poll(async () => Object.keys((await metadata(a)).failures).length)
    .toBe(0);
  await nav(a, "학습 홈");
  await a.getByRole("button", { name: /^이어 풀기/ }).click();
  await a.clock.fastForward(10 * 60 * 1000);
  const remaining =
    Date.parse(original.deadlineAt) - (await a.evaluate(() => Date.now()));
  expect(remaining).toBeGreaterThan(89 * 60 * 1000);
  expect(remaining).toBeLessThanOrEqual(90 * 60 * 1000);
  await expect(
    a.getByRole("timer", { name: "남은 시간", exact: true }),
  ).toBeVisible();
  a.once("dialog", (dialog) => dialog.accept());
  await a.getByRole("button", { name: "시험 제출", exact: true }).click();
  await a
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(시험 제출|학습 종료) 확정$/ })
    .click();
  await sync(a);
  await sync(b);
  for (const page of [a, b]) {
    const state = await stored(page);
    expect(state.data.packages).toHaveLength(0);
    expect(state.sessions.find((s: any) => s.id === original.id).status).toBe(
      "completed",
    );
    expect(state.sessions.some((s: any) => s.status === "active")).toBe(false);
    expect(state.attempts).toHaveLength(101);
    expect(state.removedQuestionIds).toHaveLength(100);
  }
  expect(backup.original.data.questions).toHaveLength(100);
  await pc.close();
  await tab.close();
});
