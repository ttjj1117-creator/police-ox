import { z } from "zod";
import { emptyData } from "../demo";
import type { OriginalData } from "../model";
import { previewMerge } from "../validation";
import type { AuthSession, CloudConfig } from "./transport";

const bucket = "police-ox-shared";
const maxStoredBytes = 50_000_000;
const maxJsonBytes = 128 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const objectRef = z.object({
  bytes: z.number().int().positive().max(maxStoredBytes),
  sha256: digest,
}).strict();
const manifestSchema = z.object({
  version: z.literal(1),
  releaseId: digest,
  questions: objectRef,
  explanations: objectRef,
}).strict();
export type SharedLibraryManifest = z.infer<typeof manifestSchema>;
type Part = "questions" | "explanations";

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function boundedBytes(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw Error("공유 자료 파일 크기가 올바르지 않습니다.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const decodeJson = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

export class SharedLibrary {
  constructor(
    private readonly config: CloudConfig,
    private readonly auth: AuthSession,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async read(path: string, maxBytes: number, optional = false) {
    const endpoint = new URL(
      `/storage/v1/object/authenticated/${bucket}/${path}`,
      this.config.url,
    );
    endpoint.searchParams.set("v", crypto.randomUUID());
    const response = await this.fetcher(endpoint.href, {
      headers: {
        apikey: this.config.key,
        Authorization: `Bearer ${this.auth.access_token}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (optional && [400, 403, 404].includes(response.status)) return null;
    if (!response.ok || !response.body)
      throw Error("공유 학습 자료를 받지 못했습니다. 다시 동기화하세요.");
    return boundedBytes(response.body, maxBytes);
  }

  async getManifest(): Promise<SharedLibraryManifest | null> {
    const bytes = await this.read("current.json", 4096, true);
    if (!bytes) return null;
    const manifest = manifestSchema.parse(decodeJson(bytes));
    const identity = new TextEncoder().encode(
      `${manifest.questions.sha256}:${manifest.explanations.sha256}`,
    );
    if ((await sha256(identity)) !== manifest.releaseId)
      throw Error("공유 학습 자료의 식별값이 일치하지 않습니다.");
    return manifest;
  }

  async getPart(manifest: SharedLibraryManifest, kind: Part): Promise<unknown> {
    const checked = manifestSchema.parse(manifest);
    const ref = checked[kind];
    const bytes = await this.read(
      `releases/${checked.releaseId}/${kind}.json.gz`,
      ref.bytes,
    );
    if (!bytes || bytes.byteLength !== ref.bytes || (await sha256(bytes)) !== ref.sha256)
      throw Error("공유 학습 자료가 손상되었습니다. 다시 동기화하세요.");
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return decodeJson(await boundedBytes(stream, maxJsonBytes));
  }
}

export async function parseSharedQuestions(value: unknown): Promise<OriginalData> {
  const { packages } = z.object({
    packages: z.array(z.unknown()).min(1),
  }).strict().parse(value);
  let data = emptyData();
  for (const pkg of packages) {
    const next = await previewMerge(data, pkg, "real");
    if (next.data.packages.length !== data.packages.length + 1)
      throw Error("공유 문제 자료에 같은 파일이 두 번 포함되어 있습니다.");
    data = next.data;
  }
  if (!data.questions.length) throw Error("공유 문제 자료가 비어 있습니다.");
  return data;
}
