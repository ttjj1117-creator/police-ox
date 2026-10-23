import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authReturnUrl,
  captureAuthRedirect,
  parseAuthFragment,
  type AuthRedirect,
} from "../src/original/sync/auth-link";
import {
  SupabaseTransport,
  type AuthSession,
} from "../src/original/sync/transport";
import { CloudController } from "../src/original/sync/controller";
import { SyncAccountStore } from "../src/original/sync/local";
import { OriginalRepository } from "../src/original/storage";
import {
  initialOriginalState,
  startSession,
  defaultSelection,
} from "../src/original/engine";
import { demoData } from "../src/original/demo";

const project = "https://auth-test.supabase.co",
  config = { url: project, key: "sb_publishable_test" };
const userA = "11111111-1111-4111-8111-111111111111",
  userB = "22222222-2222-4222-8222-222222222222";
const authKey = `sync:auth:${project}`,
  owner = (id = userA) => `${project}|${id}`;
const resources: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(resources.splice(0).map((r) => r.close()));
});
function fragment(
  claims: Record<string, unknown> = {},
  params: Record<string, string> = {},
): string {
  const encode = (v: unknown) =>
    btoa(JSON.stringify(v))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const jwt = `${encode({ alg: "ES256" })}.${encode({ iss: `${project}/auth/v1`, sub: userA, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.synthetic-signature`;
  return `#${new URLSearchParams({ access_token: jwt, refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: "3600", type: "magiclink", ...params })}`;
}
function redirect(
  claims: Record<string, unknown> = {},
): Extract<AuthRedirect, { kind: "session" }> {
  const parsed = parseAuthFragment(fragment(claims));
  if (parsed.kind !== "session") throw new Error("Invalid synthetic fixture");
  return parsed;
}
function auth(id = userA): AuthSession {
  return {
    access_token: "saved-access",
    refresh_token: "saved-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id, email: "fixture@example.com" },
  };
}
function stores() {
  const name = `auth-link-${crypto.randomUUID()}`,
    store = new SyncAccountStore(name),
    repository = new OriginalRepository(name);
  resources.push(store, repository);
  return { store, repository };
}
function activeBank() {
  const state = initialOriginalState("real"),
    q = structuredClone(demoData().questions[0]);
  q.id = "const_2026_1_1";
  q.source.examCode = "po";
  q.source.year = 2026;
  q.source.round = "1";
  q.source.questionNumber = 1;
  q.officialAnswer.status = "final";
  q.source.questionPdf = { fileName: "neutral-fixture.pdf", pages: [1] };
  q.source.answerPdf = {
    fileName: "neutral-answer.pdf",
    pages: [1],
    subjectColumn: "헌법",
  };
  state.data.questions = [q];
  startSession(state, "real", { ...defaultSelection, limit: 1 }, "study");
  return state;
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function controller(
  store: SyncAccountStore,
  link: AuthRedirect = redirect(),
  fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ id: userA, email: "fixture@example.com" })),
) {
  const transport = new SupabaseTransport(config, fetcher),
    cloud = new CloudController(store, transport, link);
  cloud.setEnabled(false);
  return { cloud, transport, fetcher };
}

describe("email login callback parsing and immediate URL cleanup", () => {
  it("clears credentials before returning a parsed callback and preserves the deployment path and unrelated query", () => {
    const replaceState = vi.fn(),
      history = { state: { previous: true }, replaceState };
    const result = captureAuthRedirect(
      { href: `https://app.example/police-ox/?keep=1&mode=demo${fragment()}` },
      history,
    );
    expect(result.kind).toBe("session");
    expect(replaceState).toHaveBeenCalledOnce();
    const clean = new URL(String(replaceState.mock.calls[0][2]));
    expect(clean.pathname).toBe("/police-ox/");
    expect(clean.hash).toBe("");
    expect(Object.fromEntries(clean.searchParams)).toEqual({
      keep: "1",
      mode: "real",
      view: "original",
      auth: "callback",
    });
    expect(clean.href).not.toContain("synthetic");
    expect(replaceState.mock.calls[0][0]).toEqual(history.state);
  });
  it("leaves ordinary anchors untouched and builds a credential-free return URL", () => {
    const replaceState = vi.fn();
    expect(
      captureAuthRedirect(
        { href: "https://app.example/path/#question-1" },
        { state: null, replaceState },
      ),
    ).toEqual({ kind: "none" });
    expect(replaceState).not.toHaveBeenCalled();
    expect(
      authReturnUrl(`https://app.example/path/?view=original${fragment()}`),
    ).not.toContain("#");
  });
  it.each([
    fragment({}, { refresh_token: "" }),
    fragment({}, { access_token: "malformed" }),
    fragment({}, { token_type: "other" }),
    fragment({}, { type: "recovery" }),
    fragment({}, { expires_in: "NaN" }),
    fragment({}, { expires_at: "0" }),
    fragment({ sub: "invalid" }),
    `${fragment()}&refresh_token=duplicate`,
  ])(
    "rejects an incomplete or malformed callback without reflecting credentials",
    (hash) => {
      const result = parseAuthFragment(hash);
      expect(result.kind).toBe("error");
      expect(JSON.stringify(result)).not.toContain("synthetic");
    },
  );
  it("clears expired/error callbacks too, displaying only a safe error message", () => {
    const replaceState = vi.fn();
    const expired = captureAuthRedirect(
      {
        href: `https://app.example/${fragment({ exp: Math.floor(Date.now() / 1000) - 1 })}`,
      },
      { state: null, replaceState },
    );
    expect(expired).toMatchObject({
      kind: "error",
      message: expect.stringContaining("만료"),
    });
    expect(String(replaceState.mock.calls[0][2])).not.toContain("#");
    expect(
      parseAuthFragment(
        "#error=access_denied&error_code=otp_expired&error_description=DO_NOT_REFLECT_THIS",
      ),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("만료"),
    });
    expect(
      JSON.stringify(
        parseAuthFragment(
          "#error=unexpected&error_description=DO_NOT_REFLECT_THIS",
        ),
      ),
    ).not.toContain("DO_NOT_REFLECT");
  });
});

describe("server-verified email link sessions", () => {
  it("validates /user with the configured server and sends a clean return URL when requesting mail", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(
        response({ id: userA, email: "fixture@example.com" }),
      );
    const transport = new SupabaseTransport(config, fetcher),
      link = redirect();
    const returnUrl = authReturnUrl(
      "https://app.example/police-ox/?view=original",
    );
    await transport.sendCode("fixture@example.com", returnUrl);
    const sent = new URL(String(fetcher.mock.calls[0][0]));
    expect(sent.pathname).toBe("/auth/v1/otp");
    expect(sent.searchParams.get("redirect_to")).toBe(returnUrl);
    const session = await transport.acceptLink(link.tokens);
    expect(fetcher.mock.calls[1][0]).toBe(`${project}/auth/v1/user`);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      apikey: config.key,
      Authorization: `Bearer ${link.tokens.accessToken}`,
    });
    expect(session).toMatchObject({
      user: { id: userA },
      expires_at: link.tokens.expiresAt,
    });
  });
  it("rejects a different project before sending credentials anywhere", async () => {
    const fetcher = vi.fn<typeof fetch>(),
      transport = new SupabaseTransport(config, fetcher);
    await expect(
      transport.acceptLink(
        redirect({ iss: "https://another.supabase.co/auth/v1" }).tokens,
      ),
    ).rejects.toThrow("다른 동기화 서버");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    "rejects an expired/invalid server token (%i)",
    async (status) => {
      const transport = new SupabaseTransport(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(response({ message: "invalid token" }, status)),
      );
      await expect(transport.acceptLink(redirect().tokens)).rejects.toThrow(
        "새 로그인 메일",
      );
    },
  );
  it.each([{ id: userB }, { id: "invalid" }, null])(
    "rejects an invalid or mismatched verified user: %j",
    async (user) => {
      const transport = new SupabaseTransport(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(response(user)),
      );
      await expect(transport.acceptLink(redirect().tokens)).rejects.toThrow(
        "계정을 확인",
      );
    },
  );
});

describe("callback controller lifecycle and durable account protection", () => {
  it("keeps an explicitly saved server setting across restart instead of replacing it with the build default", async () => {
    const { store } = stores();
    await store.setValue("sync:public-config", config);
    const cloud = new CloudController(store, undefined, { kind: "none" });
    cloud.setEnabled(false);
    await cloud.init({
      VITE_SUPABASE_URL: "https://build-default.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_BUILD_DEFAULT",
    });
    expect(cloud.snapshot().config).toEqual(config);
  });
  it("uses the build default when the user has not saved a server setting", async () => {
    const { store } = stores(),
      cloud = new CloudController(store, undefined, { kind: "none" });
    cloud.setEnabled(false);
    await cloud.init({
      VITE_SUPABASE_URL: config.url,
      VITE_SUPABASE_PUBLISHABLE_KEY: config.key,
    });
    expect(cloud.snapshot().config).toEqual(config);
  });
  it("initializes once under repeated mounts and never automatically uploads anonymous data", async () => {
    const { store, repository } = stores(),
      original = activeBank();
    original.sessions[0].status = "ended";
    original.sessions[0].finishedAt = new Date().toISOString();
    await repository.save("real", original, 0);
    const { cloud, fetcher } = controller(store);
    await Promise.all([cloud.init(), cloud.init()]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cloud.snapshot()).toMatchObject({
      ready: true,
      ownerId: owner(),
      error: "",
    });
    expect((await store.getValue<AuthSession>(authKey))?.user.id).toBe(userA);
    expect(await store.readUnlinked()).toEqual(original);
    const account = await store.read(owner());
    expect(account.state.data.questions).toEqual([]);
    expect(account.state.sessions).toEqual([]);
    expect(account.meta.outbox).toEqual([]);
  });
  it("blocks a callback if an anonymous learning session is active and leaves its state and credentials untouched", async () => {
    const { store, repository } = stores(),
      original = activeBank();
    await repository.save("real", original, 0);
    const { cloud } = controller(store);
    await cloud.init();
    expect(cloud.snapshot()).toMatchObject({
      ready: true,
      auth: null,
      ownerId: null,
      error: expect.stringContaining("진행 중"),
    });
    expect(await store.getValue(authKey)).toBeNull();
    expect(await store.readUnlinked()).toEqual(original);
  });
  it("rechecks durable activity after network verification instead of relying on disabled UI controls", async () => {
    const { store, repository } = stores();
    let release!: (r: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { cloud } = controller(store, redirect(), fetcher),
      pending = cloud.init();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await repository.save("real", activeBank(), 0);
    release(response({ id: userA }));
    await pending;
    expect(cloud.snapshot().error).toContain("진행 중");
    expect(await store.getValue(authKey)).toBeNull();
  });
  it("preserves a signed-in account and its active session when another account's link arrives", async () => {
    const { store } = stores(),
      oldAuth = auth(),
      saved = await store.read(owner());
    saved.state = activeBank();
    await store.write(owner(), saved, 0);
    await store.setValue(authKey, oldAuth);
    const before = await store.read(owner()),
      fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ id: userB }));
    const { cloud } = controller(store, redirect({ sub: userB }), fetcher);
    await cloud.init();
    expect(cloud.snapshot()).toMatchObject({
      ownerId: owner(),
      auth: oldAuth,
      error: expect.stringContaining("다른 계정"),
    });
    expect(await store.getValue(authKey)).toEqual(oldAuth);
    expect(await store.read(owner())).toEqual(before);
  });
  it("does not expose a new owner until its verified credentials are durably saved", async () => {
    const { store } = stores();
    vi.spyOn(store, "setValue").mockRejectedValue(new Error("storage failed"));
    const { cloud } = controller(store);
    await cloud.init();
    expect(cloud.snapshot()).toMatchObject({
      ready: true,
      auth: null,
      ownerId: null,
      error: "storage failed",
    });
  });
  it("keeps manual OTP login working with the same account activity guard", async () => {
    const { store, repository } = stores();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        response({ ...auth(), expires_in: 3600 }),
      );
    const { cloud } = controller(store, { kind: "none" }, fetcher);
    await cloud.init();
    await cloud.verify("fixture@example.com", "12345678");
    expect(cloud.snapshot().ownerId).toBe(owner());
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      email: "fixture@example.com",
      token: "12345678",
      type: "email",
    });
    await cloud.logout();
    await repository.save("real", activeBank(), 0);
    await expect(
      cloud.verify("fixture@example.com", "12345678"),
    ).rejects.toThrow("진행 중");
    expect(await store.getValue(authKey)).toBeNull();
  });
});
