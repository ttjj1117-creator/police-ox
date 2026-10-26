import { test, expect, type Page, type Locator } from "@playwright/test";
test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const area = (p: Page) => p.locator('.ink-surface[data-ink-surface="paper"]'),
  marks = (p: Page) => area(p).locator("g[data-ink-stroke]");
async function read(p: Page, ink = false) {
  return p.evaluate(
    (ink) =>
      new Promise<any>((resolve, reject) => {
        const r = indexedDB.open(
          ink ? "police-original-ink" : "police-ox-storage",
          1,
        );
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const d = r.result,
            g = d
              .transaction(ink ? "documents" : "states")
              .objectStore(ink ? "documents" : "states");
          const q = ink ? g.getAll() : g.get("original:demo");
          q.onsuccess = () => {
            resolve(ink ? q.result : q.result.state);
            d.close();
          };
        };
      }),
    ink,
  );
}
async function active(p: Page) {
  return (await read(p)).sessions.find((s: any) => s.status === "active");
}
async function begin(p: Page, exam = true) {
  await p.goto("/?view=original&mode=demo");
  await p
    .getByRole("button", { name: exam ? "모의고사" : "일반 학습", exact: true })
    .click();
  await p.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(area(p)).toHaveAttribute("data-ink-ready", "true");
  await expect(
    p.getByRole("button", { name: "학습 마치고 동기화", exact: true }),
  ).toHaveCount(0);
}
async function tap(button: Locator, type = "pen", distance = 0, id = 31) {
  const b = (await button.boundingBox())!,
    common = {
      pointerId: id,
      pointerType: type,
      clientX: b.x + b.width / 2,
      clientY: b.y + b.height / 2,
      buttons: 1,
      button: 0,
      bubbles: true,
      pressure: 0.5,
    };
  await button.dispatchEvent("pointerdown", common);
  if (distance)
    await button.dispatchEvent("pointermove", {
      ...common,
      clientX: common.clientX + distance,
    });
  await button.dispatchEvent("pointerup", {
    ...common,
    clientX: common.clientX + distance,
    buttons: 0,
    pressure: 0,
  });
  await button.evaluate(
    (el, event) => el.dispatchEvent(new PointerEvent("click", event)),
    {
      ...common,
      clientX: common.clientX + distance,
      buttons: 0,
      detail: 1,
      cancelable: true,
    },
  );
}
async function draw(p: Page, id = 1, end = "pointerup", check = true) {
  const a = area(p);
  await expect(a).toHaveAttribute("data-ink-ready", "true");
  const b = (await a.boundingBox())!,
    common = {
      pointerId: id,
      pointerType: "pen",
      clientX: b.x + 180,
      clientY: b.y + 30,
      button: 0,
      buttons: 1,
      bubbles: true,
      pressure: 0,
    };
  await a.dispatchEvent("pointerdown", common);
  await a.dispatchEvent("pointermove", {
    ...common,
    clientX: b.x + 250,
    clientY: b.y + 38,
  });
  await a.dispatchEvent(end, {
    ...common,
    clientX: b.x + 320,
    clientY: b.y + 40,
    buttons: 0,
  });
  if (check)
    await expect(
      p
        .locator(".ink-tools")
        .getByText("필기 이 기기에 저장됨", { exact: true }),
    ).toBeVisible();
}
async function finish(p: Page, exam = true) {
  await p
    .getByRole("button", {
      name: exam ? "시험 제출" : "학습 종료",
      exact: true,
    })
    .click();
  await p
    .getByRole("button", {
      name: exam ? "시험 제출 확정" : "학습 종료 확정",
      exact: true,
    })
    .click();
}

async function holdPen(p: Page, id: number, paper = area(p)) {
  const b = (await paper.boundingBox())!;
  const event = {
    pointerId: id,
    pointerType: "pen",
    clientX: b.x + 180,
    clientY: b.y + 30,
    buttons: 1,
    button: 0,
    pressure: 0.5,
    bubbles: true,
    cancelable: true,
  };
  await paper.dispatchEvent("pointerdown", event);
  return async (end = "pointerup") =>
    paper.dispatchEvent(end, { ...event, clientX: b.x + 230, buttons: 0 });
}
async function pointerContact(target: Locator, id: number, type = "touch") {
  const b = (await target.boundingBox())!;
  return {
    pointerId: id,
    pointerType: type,
    clientX: b.x + Math.min(20, b.width / 2),
    clientY: b.y + Math.min(20, b.height / 2),
    buttons: 1,
    button: 0,
    bubbles: true,
    cancelable: true,
  };
}
async function clickEvent(target: Locator, event: any) {
  await target.evaluate(
    (el, event) => el.dispatchEvent(new PointerEvent("click", event)),
    { ...event, buttons: 0, detail: 1 },
  );
}
async function fingerScroll(p: Page, id = 2) {
  await p.evaluate(() => scrollTo(0, 0));
  const r = (await area(p).boundingBox())!,
    cdp = await p.context().newCDPSession(p),
    x = Math.round(r.x + r.width * 0.65),
    y = Math.round(Math.min(450, r.y + 90));
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id, x, y }],
    });
    for (let n = 1; n <= 7; n++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ id, x, y: y - n * 20 }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect.poll(() => p.evaluate(() => scrollY)).toBeGreaterThan(30);
  } finally {
    await cdp.detach();
  }
}

test("연속 종이는 본문·빈 공간·선택지·번호 위를 한 획으로 지나고 연필·지우개·undo를 유지한다", async ({
  page: p,
}) => {
  await begin(p);
  await expect(
    p.getByRole("button", { name: "연필", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    p.getByRole("button", { name: "이동·읽기", exact: true }),
  ).toHaveCount(0);
  await expect(p.locator("[data-touch-unlock]")).toHaveCount(0);
  const b = (await area(p).boundingBox())!,
    n = (await p
      .getByRole("button", { name: "3번 선택", exact: true })
      .boundingBox())!,
    cdp = await p.context().newCDPSession(p),
    points = [
      { x: b.x + 200, y: b.y + 20 },
      { x: b.x + 220, y: b.y + b.height * 0.4 },
      { x: n.x + n.width / 2, y: n.y + n.height / 2 },
      { x: b.x + 300, y: b.y + b.height - 10 },
    ];
  try {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      pointerType: "pen",
      ...points[0],
      button: "left",
      buttons: 1,
      force: 0.5,
    });
    for (const pt of points.slice(1))
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        pointerType: "pen",
        ...pt,
        buttons: 1,
        force: 0.6,
      });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      pointerType: "pen",
      ...points.at(-1),
      button: "left",
      buttons: 0,
      force: 0,
    });
  } finally {
    await cdp.detach();
  }
  await expect(marks(p)).toHaveCount(1);
  expect(
    Object.values((await active(p)).responses).filter((x) => x != null),
  ).toHaveLength(0);
  const d = (await read(p, true))[0],
    stroke = Object.values<any>(d.layouts).flatMap((x) => x.strokes)[0];
  expect(stroke.surfaceId).toBe("paper");
  expect(Math.max(...stroke.points.map((x: any) => x.y))).toBeGreaterThan(
    b.height * 0.8,
  );
  await p.getByRole("button", { name: "필기 실행 취소", exact: true }).click();
  await expect(marks(p)).toHaveCount(0);
  await p.getByRole("button", { name: "필기 다시 실행", exact: true }).click();
  await tap(p.getByRole("button", { name: "지우개", exact: true }));
  await draw(p, 2);
  await expect(marks(p)).toHaveCount(0);
  await p.getByRole("button", { name: "필기 실행 취소", exact: true }).click();
  await expect(marks(p)).toHaveCount(1);
});
test("실제 펜 접촉 중 손은 번호·다음·메뉴·답안표·종료창을 실행하지 못하고 새 손 탭은 바로 복구된다", async ({
  page: p,
}) => {
  await begin(p);
  const one = p.getByRole("button", { name: "1번 선택", exact: true });
  const release = await holdPen(p, 101);
  for (const [i, name] of [
    "1번 선택",
    "다음 문항",
    "시험 제출",
    "메뉴",
    "답안표 0/100",
  ].entries())
    await tap(
      p.getByRole("button", { name, exact: true }),
      "touch",
      0,
      110 + i,
    );
  await expect(one).toHaveAttribute("aria-pressed", "false");
  expect((await active(p)).index).toBe(0);
  await expect(p.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    p.getByRole("dialog", { name: "답안표", exact: true }),
  ).toHaveCount(0);
  await release();
  await tap(one, "touch", 0, 120);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await tap(
    p.getByRole("button", { name: "다음 문항", exact: true }),
    "touch",
    0,
    121,
  );
  await expect.poll(async () => (await active(p)).index).toBe(1);
  const menu = p.getByRole("button", { name: "메뉴", exact: true });
  const stopMenu = await holdPen(p, 122);
  await tap(menu, "touch", 0, 123);
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await stopMenu();
  await tap(menu, "touch", 0, 124);
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await tap(menu, "touch", 0, 125);
  await tap(
    p.getByRole("button", { name: "답안표 1/100", exact: true }),
    "touch",
    0,
    126,
  );
  const sheet = p.getByRole("dialog", { name: "답안표", exact: true }),
    jump = sheet.getByRole("button", {
      name: "3번 문항으로 이동",
      exact: true,
    });
  await expect(sheet).toBeVisible();
  const releaseSheet = await holdPen(p, 127, sheet);
  await tap(jump, "touch", 0, 128);
  expect((await active(p)).index).toBe(1);
  await releaseSheet();
  await tap(jump, "touch", 0, 129);
  await expect.poll(async () => (await active(p)).index).toBe(2);
  await tap(
    p.getByRole("button", { name: "시험 제출", exact: true }),
    "touch",
    0,
    130,
  );
  const modal = p.getByRole("alertdialog"),
    cancel = modal.getByRole("button", {
      name: "취소 · 계속 풀기",
      exact: true,
    });
  await expect(cancel).toBeFocused();
  const releaseDialog = await holdPen(p, 131, modal);
  await tap(
    modal.getByRole("button", { name: "시험 제출 확정", exact: true }),
    "touch",
    0,
    132,
  );
  await tap(cancel, "touch", 0, 133);
  await expect(modal).toBeVisible();
  await releaseDialog();
  await tap(cancel, "touch", 0, 134);
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => (await active(p)).status).toBe("active");
});
test("첫 진입의 연필과 지우개 선택 상태 모두 손가락은 실제 스크롤하고 펜만 획·지우기를 만든다", async ({
  page: p,
}) => {
  await begin(p);
  await expect(
    p.getByRole("button", { name: "연필", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    p.getByRole("button", { name: "이동·읽기", exact: true }),
  ).toHaveCount(0);
  await expect(p.locator("[data-touch-unlock]")).toHaveCount(0);
  await p.setViewportSize({ width: 1280, height: 500 });
  await fingerScroll(p);
  await expect(marks(p)).toHaveCount(0);
  expect(
    Object.values((await active(p)).responses).filter((x) => x != null),
  ).toHaveLength(0);
  await p.evaluate(() => scrollTo(0, 0));
  await draw(p);
  await expect(marks(p)).toHaveCount(1);
  await p.getByRole("button", { name: "지우개", exact: true }).click();
  await fingerScroll(p, 3);
  await expect(marks(p)).toHaveCount(1);
  await p.evaluate(() => scrollTo(0, 0));
  await draw(p, 2);
  await expect(marks(p)).toHaveCount(0);
  await expect(
    p.getByRole("button", { name: "지우개", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("문항 간 자동 입력·취소 획·빠른 왕복·새로고침에서 필기와 답안·마감 시각을 보존한다", async ({
  page: p,
}) => {
  await begin(p);
  const s = await active(p);
  await p.getByRole("button", { name: "연필", exact: true }).click();
  await draw(p, 4, "pointercancel");
  await p.getByRole("button", { name: "1번 선택", exact: true }).click();
  await p.getByRole("button", { name: "다음 문항", exact: true }).click();
  await expect(
    p.getByRole("button", { name: "연필", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(marks(p)).toHaveCount(0);
  await draw(p, 5, "lostpointercapture");
  await p.getByRole("button", { name: "이전 문항", exact: true }).click();
  await expect(marks(p)).toHaveCount(1);
  await p.reload();
  await expect(marks(p)).toHaveCount(1);
  await expect(
    p.getByRole("button", { name: "연필", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await active(p)).deadlineAt).toBe(s.deadlineAt);
  expect(
    new Set((await read(p, true)).map((d: any) => d.identity.questionId)).size,
  ).toBe(2);
});
test("서로 다른 글씨·폭 배치와 새 세션·real 영역의 획과 undo를 섞지 않는다", async ({
  page: p,
}) => {
  await begin(p);
  await p.getByRole("button", { name: "연필", exact: true }).click();
  await draw(p);
  const path = await marks(p).locator("path").getAttribute("d");
  await p.getByRole("button", { name: "글씨 키우기", exact: true }).click();
  await expect(marks(p)).toHaveCount(0);
  await draw(p, 2);
  await p.getByRole("button", { name: "글씨 줄이기", exact: true }).click();
  await expect(marks(p).locator("path")).toHaveAttribute("d", path!);
  await p.setViewportSize({ width: 960, height: 800 });
  await expect(marks(p)).toHaveCount(0);
  await p.setViewportSize({ width: 1280, height: 800 });
  await expect(marks(p)).toHaveCount(1);
  await finish(p);
  await p.getByRole("button", { name: "모의고사", exact: true }).click();
  await p.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(marks(p)).toHaveCount(0);
  await finish(p);
  await p.getByLabel("저장 영역", { exact: true }).selectOption("real");
  await expect(p.locator(".ink-layer")).toHaveCount(0);
  expect(
    (await read(p, true)).every((d: any) => d.identity.namespace === "demo"),
  ).toBe(true);
});
test("좌측 일반 종료는 취소 기본 포커스이며 확인 전 기록 유지·중복 확정 한 번만 종료", async ({
  page: p,
}) => {
  await begin(p, false);
  await p.getByRole("button", { name: "연필", exact: true }).click();
  await draw(p);
  await p.getByRole("button", { name: "1번 선택", exact: true }).click();
  await p.getByRole("button", { name: "답 제출", exact: true }).click();
  const before = await read(p),
    exit = p.getByRole("button", { name: "학습 종료", exact: true });
  expect((await exit.boundingBox())!.x).toBeLessThan(100);
  await exit.click();
  const cancel = p.getByRole("button", {
    name: "취소 · 계속 풀기",
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await cancel.click();
  expect((await read(p)).sessions).toEqual(before.sessions);
  await expect(marks(p)).toHaveCount(1);
  await exit.click();
  await p
    .getByRole("button", { name: "학습 종료 확정", exact: true })
    .dblclick()
    .catch(() => {});
  await expect(
    p.getByRole("heading", { name: "학습 결과", exact: true }),
  ).toBeVisible();
  const after = await read(p);
  expect(after.attempts).toHaveLength(1);
  expect(after.sessions).toHaveLength(1);
  expect(after.sessions[0].status).toBe("ended");
});
test("종료 확인 중 타이머 만료는 창을 닫아 마지막 저장 답안을 한 번만 채점", async ({
  page: p,
}) => {
  await p.clock.install({ time: new Date("2026-10-26T00:00:00Z") });
  await begin(p);
  const before = await active(p);
  await p.getByRole("button", { name: "1번 선택", exact: true }).click();
  await p.getByRole("button", { name: "시험 제출", exact: true }).click();
  await p.clock.runFor(1000);
  expect((await active(p)).deadlineAt).toBe(before.deadlineAt);
  await p.clock.fastForward(100 * 60 * 1000);
  await expect(
    p.getByRole("heading", { name: "학습 결과", exact: true }),
  ).toBeVisible();
  await expect(p.getByRole("alertdialog")).toHaveCount(0);
  expect((await read(p)).attempts).toHaveLength(100);
});
test("필기 저장 실패는 거짓 완료·종료 없이 재시도하고 답안·타이머를 보존", async ({
  page: p,
}) => {
  await p.addInitScript(() => {
    (window as any).__failInk = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      if (
        this.transaction.db.name === "police-original-ink" &&
        (window as any).__failInk
      )
        throw new DOMException("test quota", "QuotaExceededError");
      return k === undefined ? put.call(this, v) : put.call(this, v, k);
    };
  });
  await begin(p);
  const before = await active(p);
  await p.getByRole("button", { name: "연필", exact: true }).click();
  await draw(p, 1, "pointerup", false);
  await expect(p.locator(".ink-tools").getByRole("alert")).toContainText(
    "저장하지 못했습니다",
  );
  await p.getByRole("button", { name: "1번 선택", exact: true }).click();
  await p.getByRole("button", { name: "시험 제출", exact: true }).click();
  await p.getByRole("button", { name: "시험 제출 확정", exact: true }).click();
  await expect(p.getByRole("alertdialog")).toBeVisible();
  expect((await active(p)).deadlineAt).toBe(before.deadlineAt);
  await p.evaluate(() => {
    (window as any).__failInk = false;
  });
  await p
    .getByRole("alertdialog")
    .getByRole("button", { name: "필기 저장 다시 시도", exact: true })
    .click();
  await p.getByRole("button", { name: "시험 제출 확정", exact: true }).click();
  await expect(
    p.getByRole("heading", { name: "학습 결과", exact: true }),
  ).toBeVisible();
  expect(await read(p, true)).toHaveLength(1);
  expect((await read(p)).attempts).toHaveLength(100);
});
test("손 이동 중 펜 접촉은 해당 손을 끝날 때까지 무효화하고 새 손은 기존 손바닥이 남아도 즉시 이동·탭한다", async ({
  page: p,
}) => {
  await begin(p);
  await p.setViewportSize({ width: 1280, height: 500 });
  const paper = area(p),
    touch = await pointerContact(paper, 201);
  touch.clientY = 420;
  await paper.dispatchEvent("pointerdown", touch);
  await paper.dispatchEvent("pointermove", { ...touch, clientY: 360 });
  await expect.poll(() => p.evaluate(() => scrollY)).toBeGreaterThan(20);
  const release = await holdPen(p, 202),
    before = await p.evaluate(() => scrollY);
  await paper.dispatchEvent("pointermove", { ...touch, clientY: 300 });
  expect(await p.evaluate(() => scrollY)).toBe(before);
  await release();
  await paper.dispatchEvent("pointermove", { ...touch, clientY: 260 });
  expect(await p.evaluate(() => scrollY)).toBe(before);
  const fresh = { ...touch, pointerId: 203, clientY: 420 };
  await paper.dispatchEvent("pointerdown", fresh);
  await paper.dispatchEvent("pointermove", { ...fresh, clientY: 350 });
  await expect
    .poll(() => p.evaluate(() => scrollY))
    .toBeGreaterThan(before + 20);
  await paper.dispatchEvent("pointerup", {
    ...fresh,
    clientY: 350,
    buttons: 0,
  });
  const one = p.getByRole("button", { name: "1번 선택", exact: true });
  await one.dispatchEvent("pointerup", { ...touch, buttons: 0 });
  await clickEvent(one, touch);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await tap(one, "touch", 0, 204);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await expect(marks(p)).toHaveCount(1);
});
test("호환 click은 펜·마우스·새 손 탭을 허용하고 이전 손바닥·펜 드래그의 후속 click만 차단한다", async ({
  page: p,
}) => {
  await begin(p);
  const one = p.getByRole("button", { name: "1번 선택", exact: true }),
    two = p.getByRole("button", { name: "2번 선택", exact: true });
  await clickEvent(one, await pointerContact(one, 990));
  await expect(one).toHaveAttribute("aria-pressed", "false");
  const compatTap = async (target: Locator, id: number, type: string) => {
    const e = await pointerContact(target, id, type);
    await target.dispatchEvent("pointerdown", e);
    await target.dispatchEvent("pointerup", { ...e, buttons: 0 });
    await target.dispatchEvent("click", {
      detail: 1,
      bubbles: true,
      cancelable: true,
    });
  };
  await tap(one, "pen", 8, 301);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await compatTap(one, 302, "pen");
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await compatTap(two, 303, "mouse");
  await expect(two).toHaveAttribute("aria-pressed", "true");
  const release = await holdPen(p, 304),
    palm = await pointerContact(one, 305);
  await one.dispatchEvent("pointerdown", palm);
  await release();
  await one.dispatchEvent("pointerup", { ...palm, buttons: 0 });
  await one.dispatchEvent("click", {
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
  await expect(two).toHaveAttribute("aria-pressed", "true");
  await compatTap(one, 306, "touch");
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await two.focus();
  await p.keyboard.press("Enter");
  await expect(two).toHaveAttribute("aria-pressed", "true");
});

test("취소·여러 손·hover·blur·화면 복귀 뒤에도 자동 입력이 남은 잠금 없이 다시 동작한다", async ({
  page: p,
}) => {
  await begin(p);
  await p.setViewportSize({ width: 1280, height: 500 });
  const paper = area(p),
    a = await pointerContact(paper, 401),
    b = { ...a, pointerId: 402 };
  await paper.dispatchEvent("pointermove", {
    ...a,
    pointerId: 410,
    pointerType: "pen",
    buttons: 0,
  });
  await paper.dispatchEvent("pointerdown", a);
  await paper.dispatchEvent("pointerdown", b);
  const scroll = await p.evaluate(() => scrollY);
  await paper.dispatchEvent("pointermove", { ...a, clientY: a.clientY - 80 });
  expect(await p.evaluate(() => scrollY)).toBe(scroll);
  await paper.dispatchEvent("pointercancel", a);
  await paper.dispatchEvent("pointercancel", b);
  await fingerScroll(p, 4);
  await p.evaluate(() => scrollTo(0, 0));
  const release = await holdPen(p, 403),
    palm = await pointerContact(paper, 404);
  await paper.dispatchEvent("pointerdown", palm);
  await release("lostpointercapture");
  await p.evaluate(() => window.dispatchEvent(new Event("blur")));
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  const one = p.getByRole("button", { name: "1번 선택", exact: true });
  await one.dispatchEvent("pointerup", { ...palm, buttons: 0 });
  await clickEvent(one, palm);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await tap(one, "touch", 0, 407);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await fingerScroll(p, 5);
  await p.evaluate(() => scrollTo(0, 0));
  await draw(p, 406);
  await expect(marks(p)).toHaveCount(2);
  await expect(
    p.getByRole("button", { name: "연필", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("TouchEvent 호환 손바닥 접촉은 펜을 뗀 뒤에도 취소하고 새 손 제스처·기본 마우스는 보존한다", async ({
  page: p,
}) => {
  await begin(p);
  const one = p.getByRole("button", { name: "1번 선택", exact: true }),
    two = p.getByRole("button", { name: "2번 선택", exact: true });
  const release = await holdPen(p, 501);
  const fire = async (
    target: Locator,
    type: string,
    id: number,
    activeIds = [id],
  ) =>
    target.evaluate(
      (el, { type, id, activeIds }) => {
        const contact = (identifier: number) => {
          const target =
            identifier === 502
              ? document.querySelector('button[aria-label="1번 선택"]')!
              : el;
          const r = target.getBoundingClientRect();
          return new Touch({
            identifier,
            target,
            clientX: r.x + 20,
            clientY: r.y + 20,
          });
        };
        const touches = activeIds.map(contact);
        return el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches,
            changedTouches: [contact(id)],
            targetTouches: touches.filter((t) => t.target === el),
          }),
        );
      },
      { type, id, activeIds },
    );
  expect(await fire(one, "touchstart", 502)).toBe(false);
  await release();
  // A new contact must keep its UA tap path even while the old native palm is
  // still held. Pointer IDs and Touch identifiers are separate namespaces.
  const fresh = await pointerContact(two, 503);
  await two.dispatchEvent("pointerdown", fresh);
  expect(await fire(two, "touchstart", 504, [502, 504])).toBe(true);
  await two.dispatchEvent("pointerup", { ...fresh, buttons: 0 });
  expect(await fire(two, "touchend", 504, [502])).toBe(true);
  await expect(two).toHaveAttribute("aria-pressed", "false");
  const bounds = (await two.boundingBox())!,
    cdp = await p.context().newCDPSession(p);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          id: 77,
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    // No dispatchEvent("click") here: Chromium must emit the actual tap click.
    await expect(two).toHaveAttribute("aria-pressed", "true");
  } finally {
    await cdp.detach();
  }
  expect(await fire(one, "touchmove", 502)).toBe(false);
  expect(await fire(one, "touchend", 502, [])).toBe(false);
  await one.dispatchEvent("click", {
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await tap(one, "touch", 0, 505);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await two.click();
  await expect(two).toHaveAttribute("aria-pressed", "true");
});
