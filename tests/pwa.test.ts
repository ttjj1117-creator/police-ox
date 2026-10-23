import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import {
  assertBuildFiles,
  assertNoAdminCredential,
  assertPublicFiles,
  assertPublicModule,
  deploymentBase,
  workerSource,
} from "../build/pwa.mjs";

const source = (version = "abc123", base = "/police-ox/") =>
  workerSource({
    base,
    version,
    files: [
      "index.html",
      "assets/main-test.js",
      "manifest.webmanifest",
      "icons/ox-192.png",
      "icons/ox-512.png",
    ],
  });
function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const cached: string[] = [];
  const cacheLookups: string[] = [];
  const requests: string[] = [];
  let skipped = 0;
  const cache = {
    addAll: async (items: Request[]) => {
      cached.push(...items.map((item) => new URL(item.url).pathname));
    },
    match: async (url: string) => {
      cacheLookups.push(url);
      return { shell: true };
    },
  };
  const localRequest = class extends Request {
    constructor(url: string, init: any) {
      super(new URL(url, "https://test.example").href, init);
    }
  };
  runInNewContext(source(), {
    self: {
      location: { origin: "https://test.example" },
      addEventListener: (type: string, fn: any) => {
        handlers[type] = fn;
      },
      skipWaiting: () => {
        skipped++;
        return Promise.resolve();
      },
    },
    caches: { open: async () => cache },
    Request: localRequest,
    Response,
    URL,
    fetch: async (request: Request) => {
      requests.push(request.url);
      throw new Error("offline");
    },
  });
  return { handlers, cached, cacheLookups, requests, skipped: () => skipped };
}
async function runEvent(handler: (event: any) => void, event: any = {}) {
  let promise: Promise<unknown> | undefined;
  handler({
    ...event,
    waitUntil: (value: Promise<unknown>) => {
      promise = value;
    },
    respondWith: (value: Promise<unknown>) => {
      promise = value;
    },
  });
  return promise ? await promise : undefined;
}
describe("audited Pages/PWA build", () => {
  it("accepts a root or project subpath and rejects origins and traversal", () => {
    expect(deploymentBase()).toBe("/");
    expect(deploymentBase("/police-ox/")).toBe("/police-ox/");
    for (const base of [
      "./",
      "//host/",
      "/../",
      "/police-ox",
      "https://host/",
      "/x?token=/",
    ])
      expect(() => deploymentBase(base)).toThrow();
  });
  it("rejects personal files, source PDFs and private source imports", () => {
    expect(() =>
      assertPublicFiles(["manifest.webmanifest", "icons/ox-192.png"]),
    ).not.toThrow();
    for (const file of ["backup.json", ".env", "exam.pdf", "sources/exam.pdf"])
      expect(() => assertPublicFiles([file])).toThrow();
    for (const id of [
      "C:/app/conversion/output/question.json",
      "C:\\app\\sources\\exams\\a.pdf",
      "/app/src/ui/ExplanationPreview.tsx",
    ])
      expect(() => assertPublicModule(id)).toThrow();
    expect(() =>
      assertPublicModule("/app/src/fixtures/book-taxonomies.json"),
    ).not.toThrow();
    expect(() =>
      assertBuildFiles(["index.html", "assets/main-abc.js", "sw.js"]),
    ).not.toThrow();
    expect(() => assertBuildFiles(["explanation-preview.html"])).toThrow();
    expect(() => assertBuildFiles(["personal-backup.json"])).toThrow();
  });
  it("rejects secret keys and service-role JWTs while allowing public keys", () => {
    expect(() =>
      assertNoAdminCredential("sb_publishable_public_example"),
    ).not.toThrow();
    expect(() =>
      assertNoAdminCredential("sb_secret_private_example"),
    ).toThrow();
    const payload = Buffer.from(
      JSON.stringify({ role: "service_role" }),
    ).toString("base64url");
    expect(() =>
      assertNoAdminCredential("eyJhbGciOiJIUzI1NiJ9." + payload + ".signature"),
    ).toThrow();
  });
  it("versions its static cache and never opts into automatic takeover or data cleanup", () => {
    expect(source("one")).toContain("police-ox-static-one");
    expect(source("two")).toContain("police-ox-static-two");
    expect(source()).not.toMatch(/clients\.claim\s*\(/);
    expect(source()).not.toMatch(
      /caches\.delete\s*\(|deleteDatabase\s*\(|indexedDB/,
    );
    expect(source()).not.toContain("api.supabase");
  });
  it("pre-caches only the exact build allowlist and waits for an explicit update message", async () => {
    const w = worker();
    await runEvent(w.handlers.install);
    expect(w.cached).toEqual([
      "/police-ox/index.html",
      "/police-ox/assets/main-test.js",
      "/police-ox/manifest.webmanifest",
      "/police-ox/icons/ox-192.png",
      "/police-ox/icons/ox-512.png",
    ]);
    expect(w.skipped()).toBe(0);
    await runEvent(w.handlers.message, { data: { type: "OTHER" } });
    expect(w.skipped()).toBe(0);
    await runEvent(w.handlers.message, {
      data: { type: "APPLY_WAITING_UPDATE" },
    });
    expect(w.skipped()).toBe(1);
  });
  it("never intercepts auth, APIs, non-GETs, query assets or unrelated navigation", () => {
    const w = worker();
    for (const [url, method, headers, mode] of [
      ["https://project.supabase.co/rest/v1/records", "GET", {}, "cors"],
      [
        "https://test.example/police-ox/assets/main-test.js",
        "GET",
        { Authorization: "Bearer private" },
        "cors",
      ],
      [
        "https://test.example/police-ox/assets/main-test.js?token=private",
        "GET",
        {},
        "cors",
      ],
      ["https://test.example/police-ox/index.html", "POST", {}, "cors"],
      ["https://test.example/another/", "GET", {}, "navigate"],
      ["https://test.example/police-ox/backup.json", "GET", {}, "cors"],
    ] as const) {
      let intercepted = false;
      w.handlers.fetch({
        request: { url, method, mode, headers: new Headers(headers) },
        respondWith: () => {
          intercepted = true;
        },
      });
      expect(intercepted, url).toBe(false);
    }
    expect(w.cacheLookups).toEqual([]);
  });
  it("serves the precached shell on an offline subpath reload without caching auth query responses", async () => {
    const w = worker();
    const result = await runEvent(w.handlers.fetch, {
      request: {
        url: "https://test.example/police-ox/?view=original&code=private",
        method: "GET",
        mode: "navigate",
        headers: new Headers(),
      },
    });
    expect(result).toEqual({ shell: true });
    expect(w.cacheLookups).toEqual(["/police-ox/index.html"]);
  });
  it("reuses the existing deployment workflow with lockfile install, tests and public-only settings", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("VITE_BASE_PATH: /police-ox/");
    expect(workflow).toContain("path: dist");
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toMatch(
      /SERVICE_ROLE|SECRET_KEY|DATABASE_PASSWORD|path: \./,
    );
  });
});
