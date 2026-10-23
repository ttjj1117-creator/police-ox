import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

export function deploymentBase(value = "/") {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) {
    throw new Error(
      "VITE_BASE_PATH must be / or an absolute directory such as /police-ox/.",
    );
  }
  return value;
}
export const PUBLIC_FILES = [
  "manifest.webmanifest",
  "icons/ox-192.png",
  "icons/ox-512.png",
];
export function filesUnder(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory()
      ? filesUnder(join(root, entry.name), name + "/")
      : [name];
  });
}
export function assertPublicFiles(files) {
  for (const file of files) {
    if (!PUBLIC_FILES.includes(file))
      throw new Error(`Public file is not allowlisted: ${file}`);
  }
}
export function assertPublicModule(id) {
  const normalized = id.replaceAll("\\", "/");
  if (
    /\/(?:sources|conversion)\//i.test(normalized) ||
    /\/ExplanationPreview\.[tj]sx?(?:\?|$)/.test(normalized)
  ) {
    throw new Error(`Private source cannot be published: ${id}`);
  }
}
export function assertBuildFiles(files) {
  for (const file of files) {
    if (
      !(
        file === "index.html" ||
        file === "sw.js" ||
        PUBLIC_FILES.includes(file) ||
        /^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(file)
      )
    ) {
      throw new Error(`Unexpected deployment output: ${file}`);
    }
  }
}
export function assertNoAdminCredential(text) {
  if (
    /sb_secret_[A-Za-z0-9_-]+/.test(text) ||
    /(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)\s*[:=]\s*["']?(?!["']?(?:\s|$))[^\s"']{16}/.test(
      text,
    )
  ) {
    throw new Error(
      "An administrator credential must not be in public output.",
    );
  }
  for (const token of text.matchAll(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  )) {
    try {
      if (
        JSON.parse(Buffer.from(token[0].split(".")[1], "base64url").toString())
          .role === "service_role"
      )
        throw new Error("An administrator JWT must not be in public output.");
    } catch (error) {
      if (
        error.message === "An administrator JWT must not be in public output."
      )
        throw error;
    }
  }
}
export function workerSource({ base, version, files }) {
  deploymentBase(base);
  const urls = files
    .filter((file) => file !== "sw.js")
    .map((file) => base + file);
  return `/* Generated from audited static files. No private data or API cache. */
const CACHE = ${JSON.stringify("police-ox-static-" + version)};
const BASE = ${JSON.stringify(base)};
const STATIC = new Set(${JSON.stringify(urls)});
const SHELL = BASE + 'index.html';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...STATIC].map(url => new Request(url, { cache: 'reload', credentials: 'same-origin' })))));
});
// Waiting is intentional. Existing tabs keep their current worker and hashed files.
// No clients.claim, automatic skipWaiting, reload, IndexedDB or outbox cleanup.
self.addEventListener('message', event => {
  if (event.data?.type === 'APPLY_WAITING_UPDATE') event.waitUntil(self.skipWaiting());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('Authorization')) return;
  if (request.mode === 'navigate' && (url.pathname === BASE || url.pathname === SHELL)) {
    // Never cache a runtime/auth response or query string; only the build-time shell is cached.
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match(SHELL)).then(response => response || Response.error())));
    return;
  }
  if (url.search || !STATIC.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
});
`;
}
export function staticPwaPlugin() {
  let config;
  return {
    name: "audited-static-pwa",
    apply: "build",
    configResolved(value) {
      config = value;
    },
    buildStart() {
      assertPublicFiles(filesUnder(config.publicDir));
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk")
          for (const id of Object.keys(item.modules)) assertPublicModule(id);
      }
    },
    closeBundle() {
      const out = resolve(config.root, config.build.outDir);
      const files = filesUnder(out).sort();
      assertBuildFiles(files);
      const hash = createHash("sha256");
      for (const file of files) {
        const bytes = readFileSync(join(out, file));
        if (!file.endsWith(".png"))
          assertNoAdminCredential(bytes.toString("utf8"));
        hash.update(file).update(bytes);
      }
      const version = hash.digest("hex").slice(0, 20);
      writeFileSync(
        join(out, "sw.js"),
        workerSource({ base: config.base, version, files }),
      );
      assertBuildFiles(filesUnder(out));
    },
  };
}
