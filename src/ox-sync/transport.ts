import { canonical } from "../domain/schema";
import {
  CloudError,
  type AuthSession,
  type CloudConfig,
} from "../original/sync/transport";
import { stampClock } from "../original/sync/clock";
import type { ClockSample, ReceivedEvent, SyncEvent, WireEvent } from "./types";
const BUCKET = "police-ox-sync-private",
  CHUNK = 256 * 1024,
  MAX = 100 * 1024 * 1024;
const hash = async (bytes: Uint8Array) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export class OxTransport {
  constructor(
    readonly config: CloudConfig,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  private async request(
    path: string,
    auth: AuthSession,
    init: RequestInit = {},
  ) {
    let r: Response;
    try {
      r = await this.fetcher(this.config.url + path, {
        ...init,
        cache: "no-store",
        headers: {
          apikey: this.config.key,
          Authorization: `Bearer ${auth.access_token}`,
          ...init.headers,
        },
      });
    } catch {
      throw new CloudError(
        "서버에 연결할 수 없습니다. OX 기록은 이 기기에 저장되어 있습니다.",
      );
    }
    if (!r.ok) {
      let code = "";
      try {
        const v = await r.json();
        code = String(v.code ?? v.error_code ?? v.message ?? "");
      } catch {}
      throw new CloudError(
        /version_conflict/.test(code)
          ? "다른 기기의 OX 변경과 버전 충돌이 있습니다. 최신 내용을 확인하세요."
          : r.status === 401 || r.status === 403
            ? "로그인을 다시 확인하세요. OX 기록은 보관되어 있습니다."
            : r.status === 429
              ? "요청이 잦습니다. 잠시 후 다시 시도하세요."
              : `OX 서버 요청 실패 (${r.status})`,
        r.status,
        code,
      );
    }
    return r;
  }
  private path(user: string, path: string) {
    if (
      !path.startsWith(`${user}/ox/`) ||
      path.includes("..") ||
      !/^[A-Za-z0-9/_\-.]+$/.test(path)
    )
      throw new Error("다른 계정의 OX 파일 경로입니다.");
  }
  private async get(
    ref: { path: string; sha: string; bytes: number },
    auth: AuthSession,
  ) {
    this.path(auth.user.id, ref.path);
    if (
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 0 ||
      ref.bytes > MAX ||
      !/^[a-f0-9]{64}$/.test(ref.sha)
    )
      throw new Error("OX 파일 참조가 올바르지 않습니다.");
    const bytes = new Uint8Array(
      await (
        await this.request(
          `/storage/v1/object/authenticated/${BUCKET}/${ref.path}`,
          auth,
        )
      ).arrayBuffer(),
    );
    if (bytes.length !== ref.bytes || (await hash(bytes)) !== ref.sha)
      throw new Error("OX 파일의 크기·해시가 다릅니다.");
    return bytes;
  }
  private async put(bytes: Uint8Array, auth: AuthSession) {
    const sha = await hash(bytes),
      path = `${auth.user.id}/ox/objects/${sha}`,
      ref = { path, sha, bytes: bytes.length };
    try {
      await this.request(`/storage/v1/object/${BUCKET}/${path}`, auth, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upsert": "false",
        },
        body: bytes as BodyInit,
      });
    } catch (e) {
      if (!(e instanceof CloudError) || ![400, 409].includes(e.status)) throw e;
      await this.get(ref, auth);
    }
    return ref;
  }
  async upload(event: SyncEvent, auth: AuthSession): Promise<WireEvent> {
    const bytes = new TextEncoder().encode(canonical(event));
    if (bytes.length > MAX)
      throw new Error("OX 전송 묶음은 100 MiB 이하여야 합니다.");
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK)
      chunks.push(await this.put(bytes.slice(offset, offset + CHUNK), auth));
    const body = await this.put(
      new TextEncoder().encode(
        JSON.stringify({ version: 1, total: bytes.length, chunks }),
      ),
      auth,
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
    const bytes = await this.get(
        { path: wire.bodyPath, sha: wire.bodySha256, bytes: wire.bodyBytes },
        auth,
      ),
      m = JSON.parse(new TextDecoder().decode(bytes));
    if (
      m.version !== 1 ||
      !Number.isSafeInteger(m.total) ||
      m.total < 0 ||
      m.total > MAX ||
      !Array.isArray(m.chunks) ||
      m.chunks.length > 400
    )
      throw new Error("OX 파일 묶음 형식 오류");
    const all = new Uint8Array(m.total);
    let offset = 0;
    for (const ref of m.chunks) {
      if (ref.bytes > CHUNK) throw new Error("OX 조각 크기 초과");
      const part = await this.get(ref, auth);
      if (offset + part.length > all.length)
        throw new Error("OX 파일 묶음 크기 오류");
      all.set(part, offset);
      offset += part.length;
    }
    if (offset !== all.length)
      throw new Error("OX 파일이 덜 내려받아졌습니다.");
    const event = JSON.parse(new TextDecoder().decode(all)) as SyncEvent;
    for (const key of [
      "protocolVersion",
      "eventId",
      "deviceId",
      "deviceSequence",
      "baseCursor",
      "createdAt",
      "kind",
    ] as const)
      if (event[key] !== wire[key])
        throw new Error("OX 이벤트 식별 정보가 다릅니다.");
    if (
      (event.kind === "bank" &&
        event.payload.baseVersion !== wire.baseVersion) ||
      (event.kind === "mark" &&
        (event.payload.questionId !== wire.markQuestionId ||
          event.payload.baseMarkVersion !== wire.baseMarkVersion))
    )
      throw new Error("OX 이벤트 버전 정보가 다릅니다.");
    return event;
  }
  async push(
    wire: WireEvent,
    auth: AuthSession,
  ): Promise<{ seq: number; duplicate: boolean }> {
    return (
      await this.request("/rest/v1/rpc/police_ox_sync_push", auth, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_event: wire }),
      })
    ).json();
  }
  async pull(
    cursor: number,
    auth: AuthSession,
  ): Promise<{ events: ReceivedEvent[]; cursor: number; clock: ClockSample }> {
    const start = Date.now(),
      raw = await (
        await this.request("/rest/v1/rpc/police_ox_sync_pull", auth, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ p_after: cursor, p_limit: 50 }),
        })
      ).json(),
      end = Date.now();
    if (
      !Array.isArray(raw.events) ||
      !Number.isSafeInteger(raw.cursor) ||
      raw.cursor < cursor ||
      !Number.isFinite(Date.parse(raw.serverTime))
    )
      throw new Error("OX 서버 수신 형식 오류");
    const events: ReceivedEvent[] = [];
    for (const row of raw.events) {
      if (!Number.isSafeInteger(row.seq) || row.seq <= cursor)
        throw new Error("OX 서버 수신 순번 오류");
      events.push({ ...row, event: await this.download(row.event, auth) });
    }
    return {
      events,
      cursor: raw.cursor,
      clock: stampClock(
        Date.parse(raw.serverTime) - (start + end) / 2,
        Math.max(1000, (end - start) / 2 + 1000),
      ),
    };
  }
}
