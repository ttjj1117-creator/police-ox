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

test("연속 종이는 본문·빈 공간·선택지·번호 위를 한 획으로 지나고 연필·지우개·undo를 유지한다", async ({
  page: p,
}) => {
  await begin(p);
  await expect(
    p.getByRole("button", { name: "이동·읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await tap(p.getByRole("button", { name: "연필", exact: true }));
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
test("손 접촉은 펜 전후·번호·다음·메뉴·답안표·종료확인과 후속 click에서 잠기며 펜·마우스·키보드는 사용한다", async ({
  page: p,
}) => {
  await begin(p);
  await p.getByRole("button", { name: "연필", exact: true }).click();
  const one = p.getByRole("button", { name: "1번 선택", exact: true });
  for (const name of [
    "1번 선택",
    "다음 문항",
    "시험 제출",
    "메뉴",
    "답안표 0/100",
  ])
    await tap(p.getByRole("button", { name, exact: true }), "touch");
  await expect(one).toHaveAttribute("aria-pressed", "false");
  expect((await active(p)).index).toBe(0);
  await expect(p.getByRole("alertdialog")).toHaveCount(0);
  await p.getByRole("button", { name: "답안표 0/100", exact: true }).click();
  const sheet = p.getByRole("dialog", { name: "답안표", exact: true });
  await tap(
    sheet.getByRole("button", { name: "2번 문항으로 이동", exact: true }),
    "touch",
  );
  expect((await active(p)).index).toBe(0);
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "시험 제출", exact: true }).click();
  const modal = p.getByRole("alertdialog"),
    cancel = modal.getByRole("button", {
      name: "취소 · 계속 풀기",
      exact: true,
    });
  await expect(cancel).toBeFocused();
  await tap(
    modal.getByRole("button", { name: "시험 제출 확정", exact: true }),
    "touch",
  );
  await expect(modal).toBeVisible();
  await cancel.click();
  await tap(one, "pen", 8);
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await tap(one);
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await p.getByRole("button", { name: "2번 선택", exact: true }).focus();
  await p.keyboard.press("Enter");
  await expect(
    p.getByRole("button", { name: "2번 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const mode = p.getByRole("button", { name: "이동·읽기", exact: true });
  await tap(mode, "touch");
  await expect(mode).toHaveAttribute("aria-pressed", "false");
  await tap(mode);
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await one.dispatchEvent("click", {
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
  await expect(
    p.getByRole("button", { name: "2번 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("1.2초 잠금 해제는 이동·취소를 견디고 읽기 모드의 손 스크롤·번호를 복구한다", async ({
  page: p,
}) => {
  await p.clock.install();
  await begin(p);
  await p.getByRole("button", { name: "연필", exact: true }).click();
  const u = p.locator("[data-touch-unlock]"),
    b = (await u.boundingBox())!,
    e = {
      pointerId: 91,
      pointerType: "touch",
      clientX: b.x + 20,
      clientY: b.y + 20,
      button: 0,
      buttons: 1,
      bubbles: true,
    };
  await u.dispatchEvent("pointerdown", e);
  await p.clock.runFor(700);
  await u.dispatchEvent("pointermove", { ...e, clientX: b.x + 35 });
  await p.clock.runFor(800);
  await expect(u).toBeVisible();
  await u.dispatchEvent("pointerup", { ...e, buttons: 0 });
  await u.dispatchEvent("pointerdown", { ...e, pointerId: 92 });
  await p.clock.runFor(1100);
  await u.dispatchEvent("pointercancel", { ...e, pointerId: 92 });
  await p.clock.runFor(300);
  await expect(u).toBeVisible();
  await u.dispatchEvent("pointerdown", { ...e, pointerId: 93 });
  await p.clock.runFor(1201);
  await expect(
    p.getByRole("button", { name: "이동·읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await p
    .locator(".quiz-input-scope")
    .dispatchEvent("pointerup", { ...e, pointerId: 93, buttons: 0 });
  await p.clock.runFor(1600);
  await tap(p.getByRole("button", { name: "1번 선택", exact: true }), "touch");
  await expect(
    p.getByRole("button", { name: "1번 선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await p.setViewportSize({ width: 1280, height: 500 });
  await p.evaluate(() => scrollTo(0, 0));
  const r = (await area(p).boundingBox())!,
    cdp = await p.context().newCDPSession(p),
    x = Math.round(r.x + r.width * 0.6),
    y = Math.round(Math.min(450, r.y + 80));
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id: 2, x, y }],
    });
    for (let n = 1; n <= 7; n++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ id: 2, x, y: y - n * 20 }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect.poll(() => p.evaluate(() => scrollY)).toBeGreaterThan(30);
  } finally {
    await cdp.detach();
  }
  await expect(marks(p)).toHaveCount(0);
});
test("문항 간 모드·취소 획·빠른 왕복·새로고침에서 필기와 답안·마감 시각을 보존한다", async ({
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
    p.getByRole("button", { name: "이동·읽기", exact: true }),
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
test("먼저 닿은 손 접촉도 모드 전환 후 잠기고 확인창 위에서 긴 누르기 복구를 사용할 수 있다", async ({
  page: p,
}) => {
  await p.clock.install();
  await begin(p);
  const paper = area(p),
    r = (await paper.boundingBox())!,
    pen = {
      pointerId: 81,
      pointerType: "pen",
      clientX: r.x + 150,
      clientY: r.y + 25,
      buttons: 1,
      button: 0,
      pressure: 0.5,
      bubbles: true,
    };
  await paper.dispatchEvent("pointerdown", pen);
  await paper.dispatchEvent("pointerup", { ...pen, buttons: 0 });
  await expect(marks(p)).toHaveCount(0);
  const one = p.getByRole("button", { name: "1번 선택", exact: true }),
    b = (await one.boundingBox())!,
    touch = {
      pointerId: 82,
      pointerType: "touch",
      clientX: b.x + 20,
      clientY: b.y + 20,
      buttons: 1,
      button: 0,
      bubbles: true,
    };
  await one.dispatchEvent("pointerdown", touch);
  await tap(p.getByRole("button", { name: "연필", exact: true }));
  await one.dispatchEvent("pointerup", { ...touch, buttons: 0 });
  await one.evaluate(
    (el, e) => el.dispatchEvent(new PointerEvent("click", e)),
    { ...touch, buttons: 0, detail: 1, cancelable: true },
  );
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await p.getByRole("button", { name: "시험 제출", exact: true }).click();
  const unlock = p.locator("[data-touch-unlock]"),
    box = (await unlock.boundingBox())!;
  expect(
    await p.evaluate(
      ({ x, y }) =>
        !!document.elementFromPoint(x, y)?.closest("[data-touch-unlock]"),
      { x: box.x + 20, y: box.y + 20 },
    ),
  ).toBe(true);
  const e = {
    pointerId: 83,
    pointerType: "touch",
    clientX: box.x + 20,
    clientY: box.y + 20,
    buttons: 1,
    button: 0,
    bubbles: true,
  };
  await unlock.dispatchEvent("pointerdown", e);
  await p.clock.runFor(1201);
  await p
    .locator(".quiz-input-scope")
    .dispatchEvent("pointerup", { ...e, buttons: 0 });
  await expect(p.getByRole("alertdialog")).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(p.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    p.getByRole("button", { name: "이동·읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("click에 pointerType이 없는 브라우저에서도 확인된 펜·마우스 버튼 탭을 허용하고 손 후속 click은 차단한다", async ({
  page: p,
}) => {
  await begin(p);
  await p.getByRole("button", { name: "연필", exact: true }).click();
  const one = p.getByRole("button", { name: "1번 선택", exact: true }),
    b = (await one.boundingBox())!,
    event = {
      pointerId: 401,
      pointerType: "pen",
      clientX: b.x + 20,
      clientY: b.y + 20,
      buttons: 1,
      button: 0,
      bubbles: true,
    };
  await one.dispatchEvent("pointerdown", event);
  await one.dispatchEvent("pointerup", { ...event, buttons: 0 });
  await one.dispatchEvent("click", {
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
  await expect(one).toHaveAttribute("aria-pressed", "true");
  const two = p.getByRole("button", { name: "2번 선택", exact: true }),
    r = (await two.boundingBox())!;
  await two.dispatchEvent("pointerdown", {
    ...event,
    pointerType: "mouse",
    pointerId: 402,
    clientX: r.x + 20,
    clientY: r.y + 20,
  });
  await two.dispatchEvent("pointerup", {
    ...event,
    pointerType: "mouse",
    pointerId: 402,
    clientX: r.x + 20,
    clientY: r.y + 20,
    buttons: 0,
  });
  await two.dispatchEvent("click", {
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
  await expect(two).toHaveAttribute("aria-pressed", "true");
  await tap(one, "touch");
  await one.dispatchEvent("click", {
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
  await expect(two).toHaveAttribute("aria-pressed", "true");
});
