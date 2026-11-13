import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import {
  ExplanationSyncRepository,
  explanationBundleFingerprint,
} from "../src/original/explanations/sync";
import { syncExplanationLibrariesCore } from "../src/original/explanations/sync-runner-core";
import { ExplanationCloudTransport } from "../src/original/explanations/sync-transport";
import { explanationSyncFixture } from "./fixtures/explanation-sync";

const config = {
  url: "https://shared.example.invalid",
  key: "sb_publishable_TEST",
};
const id = "11111111-1111-4111-8111-111111111111";
const owner = `${config.url}|${id}`;
const other = `${config.url}|22222222-2222-4222-8222-222222222222`;
const auth = {
  access_token: "shared-test-token",
  refresh_token: "shared-test-refresh",
  expires_at: 2_000_000_000,
  user: { id },
};

async function setup() {
  const { source, legacy, instructor } = await explanationSyncFixture();
  const bundle = { legacy: [legacy], instructor: [instructor] };
  const describePart = (payload: unknown) => {
    const bytes = new Uint8Array(gzipSync(JSON.stringify(payload)));
    return {
      bytes,
      ref: {
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };
  const questions = describePart({ packages: [source] });
  const explanations = describePart(bundle);
  const releaseId = createHash("sha256")
    .update(`${questions.ref.sha256}:${explanations.ref.sha256}`)
    .digest("hex");
  const sharedPath = "/storage/v1/object/authenticated/police-ox-shared";
  const sharedFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(config.url);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${auth.access_token}`,
    );
    if (url.pathname === `${sharedPath}/current.json`)
      return Response.json({
        version: 1,
        releaseId,
        questions: questions.ref,
        explanations: explanations.ref,
      });
    if (
      url.pathname ===
      `${sharedPath}/releases/${releaseId}/explanations.json.gz`
    )
      return new Response(explanations.bytes);
    throw Error(`Unexpected shared object ${url.pathname}`);
  });
  const privateFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/storage/v1/object/list/police-sync-private") {
      expect(JSON.parse(String(init?.body)).prefix).toBe(
        `${id}/real/explanations/manifests`,
      );
      return Response.json([]);
    }
    throw Error(`Unexpected private transfer ${url.pathname}`);
  });
  const repository = new ExplanationSyncRepository(new IDBFactory());
  const transport = new ExplanationCloudTransport(config, privateFetch);
  const upload = vi.spyOn(transport, "upload");
  const sync = () =>
    syncExplanationLibrariesCore(owner, auth, config, {
      repository,
      transport,
      shared: true,
      sharedFetch,
    });
  const personal = {
    legacy: [],
    instructor: [{ ...instructor, packageId: "TEST_ONLY_personal_instructor" }],
  };
  return { repository, bundle, personal, sharedFetch, upload, sync };
}

it("loads the shared explanation release for the authenticated account without publishing it privately", async () => {
  const { repository, bundle, personal, sharedFetch, upload, sync } =
    await setup();
  try {
    await repository.merge(other, personal);
    const otherBefore = await repository.read(other);
    await expect(sync()).resolves.toEqual({ legacy: 1, instructor: 1 });
    const seeded = await repository.read(owner);
    expect(seeded.bundle).toEqual(bundle);
    expect(seeded.published).toContain(
      await explanationBundleFingerprint(seeded.bundle),
    );
    expect(seeded.received).toEqual([]);
    expect(await repository.read(other)).toEqual(otherBefore);
    expect(sharedFetch).toHaveBeenCalledTimes(2);
    expect(upload).not.toHaveBeenCalled();

    await expect(sync()).resolves.toEqual({ legacy: 1, instructor: 1 });
    expect(await repository.read(owner)).toEqual(seeded);
    expect(sharedFetch).toHaveBeenCalledTimes(2);
    expect(upload).not.toHaveBeenCalled();
  } finally {
    await repository.close();
  }
});

it("preserves the authenticated account's existing personal explanation library", async () => {
  const { repository, personal, sharedFetch, upload, sync } = await setup();
  try {
    await repository.merge(owner, personal);
    const privateLibrary = await repository.read(owner);
    await repository.markPublished(
      owner,
      await explanationBundleFingerprint(privateLibrary.bundle),
    );
    const before = await repository.read(owner);
    await expect(sync()).resolves.toEqual({ legacy: 0, instructor: 1 });
    expect(await repository.read(owner)).toEqual(before);
    expect(sharedFetch).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  } finally {
    await repository.close();
  }
});
