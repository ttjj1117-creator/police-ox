import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { ExplanationCloudTransport } from "../src/original/explanations/sync-transport";
import { parseExplanationBundle } from "../src/original/explanations/sync";
import { SharedLibrary } from "../src/original/sync/shared-library";

const config = {
  url: "https://frequent-transfer.example.invalid",
  key: "sb_publishable_TEST_ONLY",
};
const uid = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const auth = {
  access_token: "TEST_ONLY_access",
  refresh_token: "TEST_ONLY_refresh",
  expires_at: 2_000_000_000,
  user: { id: uid },
};
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
afterEach(() => vi.restoreAllMocks());

/** Models immutable HTTP storage, not server-side authorization. SQL tests cover RLS. */
function privateStorage() {
  const objects = new Map<string, Uint8Array>();
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(config.url);
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Bearer ${auth.access_token}`,
    );
    expect(new Headers(init.headers).get("apikey")).toBe(config.key);
    expect(init.cache).toBe("no-store");
    if (url.pathname === "/storage/v1/object/list/police-sync-private") {
      const body = JSON.parse(String(init.body));
      const prefix = body.prefix + "/";
      const names = [...objects.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
        .sort();
      return Response.json(
        names
          .slice(body.offset, body.offset + body.limit)
          .map((name) => ({ name })),
      );
    }
    const route = url.pathname.match(
      /^\/storage\/v1\/object\/(authenticated\/)?police-sync-private\/(.+)$/,
    );
    if (!route) throw Error("TEST_ONLY_unexpected_route");
    const path = route[2];
    if (init.method === "POST") {
      expect(route[1]).toBeUndefined();
      expect(new Headers(init.headers).get("x-upsert")).toBe("false");
      if (objects.has(path)) return new Response(null, { status: 409 });
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
      expect(path.split("/").at(-1)).toBe(hash(bytes));
      objects.set(path, bytes);
      return Response.json({ Key: path });
    }
    expect(route[1]).toBe("authenticated/");
    const bytes = objects.get(path);
    return bytes
      ? new Response(bytes as BodyInit)
      : new Response(null, { status: 404 });
  });
  return { objects, fetcher };
}

it("keeps old explanation lists and strict bundle parsing separate from connection sidecars", async () => {
  const { objects, fetcher } = privateStorage();
  const legacy = new ExplanationCloudTransport(config, fetcher);
  const sidecar = new ExplanationCloudTransport(
    config,
    fetcher,
    "frequent-issues",
  );
  const value = {
    format: "TEST_ONLY_connections",
    source: "TEST_ONLY",
    text: "가🙂".repeat(120000),
  };
  const frequentPath = await sidecar.uploadValue(value, auth);
  const oldPath = await legacy.upload({ legacy: [], instructor: [] }, auth);
  expect(frequentPath).toContain(`${uid}/real/frequent-issues/manifests/`);
  expect(oldPath).toContain(`${uid}/real/explanations/manifests/`);
  expect(await sidecar.list(auth)).toEqual([frequentPath]);
  expect(await legacy.list(auth)).toEqual([oldPath]);
  expect(await sidecar.downloadValue(frequentPath, auth)).toEqual(value);
  expect(await legacy.download(oldPath, auth)).toEqual({
    legacy: [],
    instructor: [],
  });
  const calls = fetcher.mock.calls.length;
  await expect(legacy.downloadValue(frequentPath, auth)).rejects.toThrow(
    "계정",
  );
  await expect(sidecar.downloadValue(oldPath, auth)).rejects.toThrow("계정");
  await expect(
    sidecar.downloadValue(frequentPath.replace(uid, other), auth),
  ).rejects.toThrow("계정");
  expect(fetcher).toHaveBeenCalledTimes(calls);
  await expect(
    parseExplanationBundle({ legacy: [], instructor: [], connections: value }),
  ).rejects.toThrow("형식");
  const manifest = JSON.parse(
    new TextDecoder().decode(objects.get(frequentPath)),
  );
  expect(manifest.format).toBe("police-frequent-issues-sync");
});

it("checks every existing immutable object before treating a duplicate upload as successful", async () => {
  const { objects, fetcher } = privateStorage();
  const sidecar = new ExplanationCloudTransport(
    config,
    fetcher,
    "frequent-issues",
  );
  const value = {
    format: "TEST_ONLY_connections",
    text: "TEST_ONLY_private_payload",
  };
  const path = await sidecar.uploadValue(value, auth);
  await expect(sidecar.uploadValue(value, auth)).resolves.toBe(path);
  const chunk = [...objects.keys()].find((key) => key.includes("/chunks/"))!;
  const bytes = objects.get(chunk)!;
  objects.set(chunk, new Uint8Array(bytes.length));
  await expect(sidecar.uploadValue(value, auth)).rejects.toThrow("해시");
  await expect(sidecar.downloadValue(path, auth)).rejects.toThrow("해시");
});

it("rejects a validly hashed wrong-resource manifest, foreign child path, truncation and payload hash mismatch", async () => {
  const { objects, fetcher } = privateStorage();
  const sidecar = new ExplanationCloudTransport(
    config,
    fetcher,
    "frequent-issues",
  );
  const path = await sidecar.uploadValue({ text: "TEST_ONLY" }, auth);
  const manifest = JSON.parse(new TextDecoder().decode(objects.get(path)));
  const add = (value: unknown) => {
    const bytes = jsonBytes(value),
      result = `${uid}/real/frequent-issues/manifests/${hash(bytes)}`;
    objects.set(result, bytes);
    return result;
  };
  await expect(
    sidecar.downloadValue(
      add({ ...manifest, format: "police-explanation-sync" }),
      auth,
    ),
  ).rejects.toThrow("형식");
  await expect(
    sidecar.downloadValue(
      add({
        ...manifest,
        root: {
          ...manifest.root,
          path: manifest.root.path.replace("frequent-issues", "explanations"),
        },
      }),
      auth,
    ),
  ).rejects.toThrow("계정");
  await expect(
    sidecar.downloadValue(
      add({ ...manifest, total: manifest.total + 1 }),
      auth,
    ),
  ).rejects.toThrow("덜 내려");
  await expect(
    sidecar.downloadValue(
      add({ ...manifest, payloadSha256: "a".repeat(64) }),
      auth,
    ),
  ).rejects.toThrow("묶음 해시");
});

function sharedFixture(
  raw: Uint8Array = jsonBytes({
    format: "TEST_ONLY_connections",
    text: "한글🙂",
  }),
) {
  const gzip = new Uint8Array(gzipSync(raw));
  const manifest = {
    version: 1,
    releaseId: hash(gzip),
    connections: { bytes: gzip.byteLength, sha256: hash(gzip) },
  };
  const paths: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    expect(url.origin).toBe(config.url);
    expect(url.searchParams.get("v")).toBeTruthy();
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${auth.access_token}`,
    );
    expect(new Headers(init?.headers).get("apikey")).toBe(config.key);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    if (url.pathname.endsWith("/frequent-issues/current.json"))
      return Response.json(manifest);
    if (
      url.pathname.endsWith(
        `/frequent-issues/releases/${manifest.releaseId}/connections.json.gz`,
      )
    )
      return new Response(gzip);
    throw Error("TEST_ONLY_unexpected_shared_route");
  });
  return { gzip, manifest, paths, fetcher };
}

it("loads only the authenticated shared sidecar and leaves the original shared manifest shape untouched", async () => {
  const fixture = sharedFixture();
  const shared = new SharedLibrary(config, auth, fixture.fetcher);
  await expect(shared.getFrequentIssues()).resolves.toEqual({
    format: "TEST_ONLY_connections",
    text: "한글🙂",
  });
  expect(fixture.paths).toEqual([
    "/storage/v1/object/authenticated/police-ox-shared/frequent-issues/current.json",
    `/storage/v1/object/authenticated/police-ox-shared/frequent-issues/releases/${fixture.manifest.releaseId}/connections.json.gz`,
  ]);
  const old = new SharedLibrary(config, auth, async () =>
    Response.json(fixture.manifest),
  );
  await expect(old.getManifest()).rejects.toThrow();
});

it.each([400, 403, 404])(
  "treats unavailable optional shared connections (%s) as absent",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status }),
    );
    await expect(
      new SharedLibrary(config, auth, fetcher).getFrequentIssues(),
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);

it("rejects server failure, oversized/unknown manifests and inconsistent release identity before downloading content", async () => {
  await expect(
    new SharedLibrary(
      config,
      auth,
      async () => new Response(null, { status: 500 }),
    ).getFrequentIssues(),
  ).rejects.toThrow("받지");
  await expect(
    new SharedLibrary(
      config,
      auth,
      async () => new Response(" ".repeat(4097)),
    ).getFrequentIssues(),
  ).rejects.toThrow("크기");
  const { manifest } = sharedFixture();
  for (const invalid of [
    { ...manifest, releaseId: "b".repeat(64) },
    {
      ...manifest,
      connections: { ...manifest.connections, bytes: 50_000_001 },
    },
    { ...manifest, url: "https://TEST_ONLY.invalid/foreign.json.gz" },
  ]) {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(invalid));
    await expect(
      new SharedLibrary(config, auth, fetcher).getFrequentIssues(),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  }
});

it("rejects shared content with a wrong byte count/hash, invalid gzip or invalid UTF-8", async () => {
  const { gzip, manifest } = sharedFixture();
  for (const bytes of [new Uint8Array(gzip.length), gzip.slice(0, -1)]) {
    const fetcher = vi.fn<typeof fetch>(async (_input) =>
      fetcher.mock.calls.length === 1
        ? Response.json(manifest)
        : new Response(bytes),
    );
    await expect(
      new SharedLibrary(config, auth, fetcher).getFrequentIssues(),
    ).rejects.toThrow("손상");
  }
  const badGzip = jsonBytes({ not: "gzip" });
  const notCompressed = {
    version: 1,
    releaseId: hash(badGzip),
    connections: { bytes: badGzip.length, sha256: hash(badGzip) },
  };
  let calls = 0;
  await expect(
    new SharedLibrary(config, auth, async () =>
      ++calls === 1 ? Response.json(notCompressed) : new Response(badGzip),
    ).getFrequentIssues(),
  ).rejects.toThrow();
  const invalidUtf8 = sharedFixture(new Uint8Array([255]));
  await expect(
    new SharedLibrary(config, auth, invalidUtf8.fetcher).getFrequentIssues(),
  ).rejects.toThrow();
});
