import { canonicalExplanationValue } from "./contract";
import { parseExplanationBundle, type ExplanationBundle } from "./sync";
import type { AuthSession, CloudConfig } from "../sync/transport";

const BUCKET = "police-sync-private";
const CHUNK = 256 * 1024;
const FANOUT = 256;
const utf8 = new TextEncoder();
type Ref = {
  path: string;
  sha: string;
  bytes: number;
  kind: "chunk" | "index";
};
const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const hashPattern = /^[a-f0-9]{64}$/;
/** Immutable private Storage objects use the bucket's existing owner policies.
 * The small tree of manifests keeps each request below its 1 MiB object limit,
 * without imposing another total-file limit on explanation JSON. */
export class ExplanationCloudTransport {
  constructor(
    public config: CloudConfig,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  private prefix(auth: AuthSession) {
    return `${auth.user.id}/real/explanations`;
  }
  private checkPath(
    path: string,
    auth: AuthSession,
    area: "chunks" | "manifests",
  ) {
    if (
      !path.startsWith(`${this.prefix(auth)}/${area}/`) ||
      !hashPattern.test(path.slice(path.lastIndexOf("/") + 1)) ||
      path.split("/").length !== 5
    )
      throw Error("다른 계정 또는 잘못된 해설 파일 경로입니다.");
  }
  private async request(
    path: string,
    auth: AuthSession,
    init: RequestInit = {},
  ) {
    let response: Response;
    try {
      response = await this.fetcher(this.config.url + path, {
        ...init,
        cache: "no-store",
        headers: {
          apikey: this.config.key,
          Authorization: `Bearer ${auth.access_token}`,
          ...init.headers,
        },
      });
    } catch {
      throw Error(
        "해설 서버에 연결하지 못했습니다. 이 기기 자료는 보존되어 연결 후 다시 전송합니다.",
      );
    }
    return response;
  }
  private async get(
    path: string,
    auth: AuthSession,
    expected?: { sha: string; bytes: number },
  ) {
    const area = path.includes("/manifests/") ? "manifests" : "chunks";
    this.checkPath(path, auth, area);
    if (
      expected &&
      (!hashPattern.test(expected.sha) ||
        !Number.isSafeInteger(expected.bytes) ||
        expected.bytes < 0 ||
        expected.bytes > CHUNK)
    )
      throw Error("해설 조각 크기·해시 참조가 다릅니다.");
    const response = await this.request(
      `/storage/v1/object/authenticated/${BUCKET}/${path}`,
      auth,
    );
    if (!response.ok)
      throw Error(
        `해설 다운로드 실패 (${response.status}) · 기존 자료는 보존됩니다.`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expectedSha = expected?.sha ?? path.slice(path.lastIndexOf("/") + 1);
    if (
      expectedSha !== path.slice(path.lastIndexOf("/") + 1) ||
      bytes.length > CHUNK ||
      (expected && bytes.length !== expected.bytes) ||
      (await sha256(bytes)) !== expectedSha
    )
      throw Error("해설 파일의 크기·해시가 다릅니다. 기존 자료는 보존됩니다.");
    return bytes;
  }
  private async put(
    bytes: Uint8Array,
    auth: AuthSession,
    area: "chunks" | "manifests",
    kind: Ref["kind"] = "chunk",
  ): Promise<Ref> {
    if (bytes.length > CHUNK) throw Error("해설 전송 조각이 너무 큽니다.");
    const sha = await sha256(bytes),
      path = `${this.prefix(auth)}/${area}/${sha}`;
    const response = await this.request(
      `/storage/v1/object/${BUCKET}/${path}`,
      auth,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upsert": "false",
        },
        body: bytes as BodyInit,
      },
    );
    if (!response.ok) {
      if (![400, 409].includes(response.status))
        throw Error(
          `해설 업로드 실패 (${response.status}) · 이 기기 자료는 보존됩니다.`,
        );
      // A duplicate is successful only if the existing object has the exact hash.
      await this.get(path, auth, { sha, bytes: bytes.length });
    }
    return { path, sha, bytes: bytes.length, kind };
  }
  async list(auth: AuthSession): Promise<string[]> {
    const result: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const response = await this.request(
        `/storage/v1/object/list/${BUCKET}`,
        auth,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prefix: `${this.prefix(auth)}/manifests`,
            limit: 100,
            offset,
            sortBy: { column: "name", order: "asc" },
          }),
        },
      );
      if (!response.ok)
        throw Error(`해설 목록을 읽지 못했습니다 (${response.status}).`);
      const rows: unknown = await response.json();
      if (!Array.isArray(rows) || rows.length > 100)
        throw Error("해설 서버 목록 형식이 다릅니다.");
      for (const row of rows) {
        if (!row || typeof row.name !== "string" || !hashPattern.test(row.name))
          throw Error("해설 서버 파일 이름이 다릅니다.");
        result.push(`${this.prefix(auth)}/manifests/${row.name}`);
      }
      if (rows.length < 100) return [...new Set(result)];
    }
  }
  async upload(bundle: ExplanationBundle, auth: AuthSession): Promise<string> {
    const checked = await parseExplanationBundle(bundle),
      bytes = utf8.encode(canonicalExplanationValue(checked));
    let refs: Ref[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK)
      refs.push(
        await this.put(bytes.slice(offset, offset + CHUNK), auth, "chunks"),
      );
    while (refs.length > 1 || refs[0].kind !== "index") {
      const next: Ref[] = [];
      for (let index = 0; index < refs.length; index += FANOUT)
        next.push(
          await this.put(
            utf8.encode(
              JSON.stringify({
                version: 1,
                children: refs.slice(index, index + FANOUT),
              }),
            ),
            auth,
            "chunks",
            "index",
          ),
        );
      refs = next;
    }
    const root = await this.put(
      utf8.encode(
        JSON.stringify({
          format: "police-explanation-sync",
          version: 1,
          total: bytes.length,
          payloadSha256: await sha256(bytes),
          root: refs[0],
        }),
      ),
      auth,
      "manifests",
    );
    return root.path;
  }
  async download(path: string, auth: AuthSession): Promise<ExplanationBundle> {
    this.checkPath(path, auth, "manifests");
    const manifest = JSON.parse(
      new TextDecoder().decode(await this.get(path, auth)),
    );
    if (
      manifest?.format !== "police-explanation-sync" ||
      manifest.version !== 1 ||
      !Number.isSafeInteger(manifest.total) ||
      manifest.total < 1 ||
      !hashPattern.test(manifest.payloadSha256)
    )
      throw Error("해설 전송 묶음 형식이 다릅니다.");
    const parts: Uint8Array[] = [];
    let total = 0;
    const ancestors = new Set<string>();
    const collect = async (raw: unknown, depth: number) => {
      const ref = raw as Ref;
      if (
        !ref ||
        typeof ref.path !== "string" ||
        !hashPattern.test(ref.sha) ||
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes < 1 ||
        ref.bytes > CHUNK ||
        !["chunk", "index"].includes(ref.kind) ||
        depth > 24
      )
        throw Error("해설 전송 조각 참조가 다릅니다.");
      this.checkPath(ref.path, auth, "chunks");
      if (ancestors.has(ref.path)) throw Error("해설 조각 참조가 순환합니다.");
      const bytes = await this.get(ref.path, auth, ref);
      if (ref.kind === "chunk") {
        total += bytes.length;
        if (total > manifest.total)
          throw Error("해설 전송 묶음 크기가 다릅니다.");
        parts.push(bytes);
      } else {
        ancestors.add(ref.path);
        const index = JSON.parse(new TextDecoder().decode(bytes));
        if (
          index?.version !== 1 ||
          !Array.isArray(index.children) ||
          !index.children.length ||
          index.children.length > FANOUT
        )
          throw Error("해설 전송 조각 목록이 다릅니다.");
        for (const child of index.children) await collect(child, depth + 1);
        ancestors.delete(ref.path);
      }
    };
    await collect(manifest.root, 0);
    if (total !== manifest.total)
      throw Error("해설 파일이 덜 내려받아졌습니다. 기존 자료는 보존됩니다.");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    if ((await sha256(bytes)) !== manifest.payloadSha256)
      throw Error("해설 묶음 해시가 다릅니다. 기존 자료는 보존됩니다.");
    return parseExplanationBundle(JSON.parse(new TextDecoder().decode(bytes)));
  }
}
