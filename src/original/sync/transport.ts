import { z } from "zod";
import { canonical } from "../../domain/schema";
import type { ClockSample, ReceivedEvent, SyncEvent, WireEvent } from "./types";
import { stampClock } from "./clock";

export interface CloudConfig {
  url: string;
  key: string;
}
export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string; email?: string };
}
const authShape = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().optional(),
  expires_at: z.number().optional(),
  user: z.object({ id: z.string().uuid(), email: z.string().optional() }),
});
export function cloudConfig(env: Record<string, unknown>): CloudConfig | null {
  const url = String(env.VITE_SUPABASE_URL ?? "").replace(/\/$/, ""),
    key = String(env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "");
  if (!url && !key) return null;
  if (
    (!/^https:\/\/[^/]+$/.test(url) &&
      !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(url)) ||
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)
  )
    throw new Error("Supabase URL과 공개용 publishable key 설정을 확인하세요.");
  return { url, key };
}
export class CloudError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "",
  ) {
    super(message);
  }
}
const BUCKET = "police-sync-private";
const CHUNK = 256 * 1024;
const MAX_BODY = 100 * 1024 * 1024;
const utf8 = new TextEncoder();
async function hash(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export class SupabaseTransport {
  constructor(
    public config: CloudConfig,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  private async request(
    path: string,
    token: string | null,
    init: RequestInit = {},
  ) {
    let response: Response;
    try {
      response = await this.fetcher(this.config.url + path, {
        ...init,
        cache: "no-store",
        headers: {
          apikey: this.config.key,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new CloudError(
        "서버에 연결할 수 없습니다. 기록은 이 기기에 보관되어 있으며 연결 후 다시 시도할 수 있습니다.",
      );
    }
    if (!response.ok) {
      let detail = "",
        code = "";
      try {
        const e = await response.json();
        detail = e.msg ?? e.message ?? e.error_description ?? e.error ?? "";
        code = e.error_code ?? e.code ?? detail;
      } catch {}
      const versionConflict =
        /bank_version_conflict|mark_version_conflict/.test(detail);
      const text = versionConflict
        ? "다른 기기에서 자료나 표시가 변경되었습니다. 최신 내용을 확인한 뒤 반영할 변경을 선택하세요."
        : /otp_expired|otp_disabled/.test(code)
          ? "인증번호가 만료되었거나 올바르지 않습니다. 새 번호를 받아 다시 입력하세요."
          : response.status === 429
            ? "요청이 너무 잦습니다. 잠시 후 다시 시도하세요."
            : response.status === 401 || response.status === 403
              ? "로그인을 다시 확인하세요. 이 기기의 기록은 보관되어 있습니다."
              : detail || `서버 요청 실패 (${response.status})`;
      throw new CloudError(
        text,
        response.status,
        versionConflict ? detail : code,
      );
    }
    return response;
  }
  async sendCode(email: string) {
    await this.request("/auth/v1/otp", null, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
  }
  private session(value: unknown): AuthSession {
    const a = authShape.parse(value);
    return {
      ...a,
      expires_at:
        a.expires_at ?? Math.floor(Date.now() / 1000) + (a.expires_in ?? 3600),
    };
  }
  async verify(email: string, token: string) {
    return this.session(
      await (
        await this.request("/auth/v1/verify", null, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, token, type: "email" }),
        })
      ).json(),
    );
  }
  async refresh(session: AuthSession) {
    return this.session(
      await (
        await this.request("/auth/v1/token?grant_type=refresh_token", null, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        })
      ).json(),
    );
  }
  async logout(session: AuthSession) {
    await this.request("/auth/v1/logout?scope=local", session.access_token, {
      method: "POST",
    });
  }
  private checkPath(user: string, path: string) {
    if (
      !path.startsWith(`${user}/real/`) ||
      path.includes("..") ||
      !/^[A-Za-z0-9/_\-.]+$/.test(path)
    )
      throw new Error("다른 계정의 파일 경로는 사용할 수 없습니다.");
  }
  private async put(user: string, bytes: Uint8Array, token: string) {
    const sha = await hash(bytes),
      path = `${user}/real/objects/${sha}`;
    try {
      await this.request(`/storage/v1/object/${BUCKET}/${path}`, token, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upsert": "false",
        },
        body: bytes as BodyInit,
      });
    } catch (e) {
      if (!(e instanceof CloudError) || ![400, 409].includes(e.status)) throw e;
      const existing = await this.get(user, path, sha, bytes.byteLength, token);
      if ((await hash(existing)) !== sha)
        throw new Error("저장된 파일 해시가 다릅니다.");
    }
    return { path, sha, bytes: bytes.byteLength };
  }
  private async get(
    user: string,
    path: string,
    sha: string,
    size: number,
    token: string,
  ) {
    this.checkPath(user, path);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY)
      throw new Error("파일 크기 제한을 초과했습니다.");
    const bytes = new Uint8Array(
      await (
        await this.request(
          `/storage/v1/object/authenticated/${BUCKET}/${path}`,
          token,
        )
      ).arrayBuffer(),
    );
    if (bytes.length !== size || (await hash(bytes)) !== sha)
      throw new Error(
        "다운로드 파일의 크기·해시가 다릅니다. 기존 기록을 유지합니다.",
      );
    return bytes;
  }
  async upload(event: SyncEvent, auth: AuthSession): Promise<WireEvent> {
    const cloned = structuredClone(event),
      assetRefs: Record<
        string,
        {
          sha: string;
          bytes: number;
          parts: { path: string; sha: string; bytes: number }[];
        }
      > = {};
    const assets =
      cloned.kind === "bank"
        ? [
            ...cloned.payload.data.assets,
            ...cloned.payload.data.packages.flatMap((p) => p.assets),
          ]
        : cloned.kind === "session"
          ? cloned.payload.session.assets
          : [];
    for (const asset of assets) {
      const key = asset.sha256;
      if (!assetRefs[key]) {
        const bytes = Uint8Array.from(atob(asset.base64), (c) =>
          c.charCodeAt(0),
        );
        if ((await hash(bytes)) !== key)
          throw new Error("그림 원본 해시가 다릅니다.");
        const parts = [];
        for (let offset = 0; offset < bytes.length; offset += CHUNK)
          parts.push(
            await this.put(
              auth.user.id,
              bytes.slice(offset, offset + CHUNK),
              auth.access_token,
            ),
          );
        assetRefs[key] = { sha: key, bytes: bytes.length, parts };
      }
      asset.base64 = "";
    }
    const bytes = utf8.encode(canonical(cloned));
    if (bytes.length > MAX_BODY)
      throw new Error(
        "동기화 묶음은 100 MiB 이하여야 합니다. 문제 파일을 나누어 등록하세요.",
      );
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK)
      chunks.push(
        await this.put(
          auth.user.id,
          bytes.slice(offset, offset + CHUNK),
          auth.access_token,
        ),
      );
    const body = await this.put(
      auth.user.id,
      utf8.encode(
        JSON.stringify({ version: 1, chunks, assetRefs, total: bytes.length }),
      ),
      auth.access_token,
    );
    return {
      protocolVersion: 1,
      eventId: event.eventId,
      deviceId: event.deviceId,
      deviceSequence: event.deviceSequence,
      baseCursor: event.baseCursor,
      createdAt: event.createdAt,
      kind: event.kind,
      bodyPath: body.path,
      bodySha256: body.sha,
      bodyBytes: body.bytes,
      baseVersion: event.kind === "bank" ? event.payload.baseVersion : null,
      markQuestionId: event.kind === "mark" ? event.payload.questionId : null,
      baseMarkVersion:
        event.kind === "mark" ? event.payload.baseMarkVersion : null,
    };
  }
  async download(wire: WireEvent, auth: AuthSession): Promise<SyncEvent> {
    const refShape = z.object({
      path: z.string(),
      sha: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().min(0).max(CHUNK),
    });
    const manifest = z
      .object({
        version: z.literal(1),
        total: z.number().int().min(0).max(MAX_BODY),
        chunks: z.array(refShape).max(400),
        assetRefs: z.record(
          z.object({
            sha: z.string(),
            bytes: z.number().int().min(0).max(MAX_BODY),
            parts: z.array(refShape).max(400),
          }),
        ),
      })
      .parse(
        JSON.parse(
          new TextDecoder().decode(
            await this.get(
              auth.user.id,
              wire.bodyPath,
              wire.bodySha256,
              wire.bodyBytes,
              auth.access_token,
            ),
          ),
        ),
      );
    const all = new Uint8Array(manifest.total);
    let offset = 0;
    for (const chunk of manifest.chunks) {
      const b = await this.get(
        auth.user.id,
        chunk.path,
        chunk.sha,
        chunk.bytes,
        auth.access_token,
      );
      if (offset + b.length > all.length)
        throw new Error("파일 묶음 크기 오류");
      all.set(b, offset);
      offset += b.length;
    }
    if (offset !== all.length)
      throw new Error("파일 묶음이 덜 내려받아졌습니다.");
    const event = JSON.parse(new TextDecoder().decode(all)) as SyncEvent;
    if (
      event.eventId !== wire.eventId ||
      event.kind !== wire.kind ||
      event.deviceId !== wire.deviceId ||
      event.deviceSequence !== wire.deviceSequence ||
      event.baseCursor !== wire.baseCursor ||
      event.createdAt !== wire.createdAt ||
      event.protocolVersion !== 1
    )
      throw new Error("전송 이벤트와 파일의 식별 정보가 다릅니다.");
    if (
      (event.kind === "bank" &&
        event.payload.baseVersion !== wire.baseVersion) ||
      (event.kind === "mark" &&
        (event.payload.questionId !== wire.markQuestionId ||
          event.payload.baseMarkVersion !== wire.baseMarkVersion))
    )
      throw new Error("전송 버전 정보와 파일 내용이 다릅니다.");
    const assets =
      event.kind === "bank"
        ? [
            ...event.payload.data.assets,
            ...event.payload.data.packages.flatMap((p) => p.assets),
          ]
        : event.kind === "session"
          ? event.payload.session.assets
          : [];
    const cache = new Map<string, string>();
    for (const asset of assets) {
      const ref = manifest.assetRefs[asset.sha256];
      if (!ref || ref.sha !== asset.sha256)
        throw new Error("그림 참조가 누락되었습니다.");
      if (!cache.has(ref.sha)) {
        const bytes = new Uint8Array(ref.bytes);
        let offset = 0;
        for (const part of ref.parts) {
          const chunk = await this.get(
            auth.user.id,
            part.path,
            part.sha,
            part.bytes,
            auth.access_token,
          );
          if (offset + chunk.length > bytes.length)
            throw new Error("그림 묶음 크기 오류");
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (offset !== bytes.length || (await hash(bytes)) !== ref.sha)
          throw new Error("그림 묶음 해시 오류");
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        cache.set(ref.sha, btoa(binary));
      }
      asset.base64 = cache.get(ref.sha)!;
    }
    return event;
  }
  async push(wire: WireEvent, auth: AuthSession) {
    return (
      await this.request("/rest/v1/rpc/police_sync_push", auth.access_token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_event: wire }),
      })
    ).json() as Promise<{
      seq: number;
      bankVersion: number;
      markVersion?: number;
      duplicate: boolean;
      serverTime: string;
    }>;
  }
  async pull(
    cursor: number,
    auth: AuthSession,
  ): Promise<{
    events: ReceivedEvent[];
    cursor: number;
    bankVersion: number;
    clock: ClockSample;
  }> {
    const start = Date.now();
    const raw = await (
      await this.request("/rest/v1/rpc/police_sync_pull", auth.access_token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_after: cursor, p_limit: 50 }),
      })
    ).json();
    if (
      !Array.isArray(raw.events) ||
      !Number.isSafeInteger(raw.cursor) ||
      raw.cursor < cursor ||
      !Number.isSafeInteger(raw.bankVersion) ||
      !Number.isFinite(Date.parse(raw.serverTime))
    )
      throw new Error("서버 동기화 응답 형식이 다릅니다.");
    const end = Date.now(),
      events: ReceivedEvent[] = [];
    for (const row of raw.events) {
      if (!Number.isSafeInteger(row.seq) || row.seq <= cursor)
        throw new Error("동기화 순번 오류");
      events.push({ ...row, event: await this.download(row.event, auth) });
    }
    return {
      events,
      cursor: raw.cursor,
      bankVersion: raw.bankVersion,
      clock: stampClock(
        Date.parse(raw.serverTime) - (start + end) / 2,
        Math.max(1000, (end - start) / 2 + 1000),
      ),
    };
  }
}
