/** URL credentials stay in memory and are removed before app startup awaits IO. */
export interface AuthLinkTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  issuer: string;
  subject: string;
}
export type AuthRedirect =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "session"; tokens: AuthLinkTokens };
const incomplete =
  "로그인 링크가 불완전하거나 올바르지 않습니다. 이메일에서 새 링크를 요청하세요.";
const expired =
  "로그인 링크가 만료되었거나 이미 사용되었습니다. 새 로그인 메일을 요청하세요.";
const authKeys = [
  "access_token",
  "refresh_token",
  "expires_at",
  "expires_in",
  "token_type",
  "type",
  "error",
  "error_code",
  "error_description",
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function failure(message = incomplete): AuthRedirect {
  return { kind: "error", message };
}
export function authReturnUrl(href: string): string {
  const url = new URL(href);
  url.hash = "";
  url.searchParams.set("view", "original");
  url.searchParams.set("mode", "real");
  url.searchParams.set("auth", "callback");
  return url.href;
}

export function parseAuthFragment(
  fragment: string,
  now = Date.now(),
): AuthRedirect {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  if (!authKeys.some((key) => params.has(key))) return { kind: "none" };
  if (
    fragment.length > 32768 ||
    authKeys.some((key) => params.getAll(key).length > 1)
  )
    return failure();
  if (
    params.has("error") ||
    params.has("error_code") ||
    params.has("error_description")
  )
    return failure(
      /expired|access_denied/i.test(
        params.get("error_code") ?? params.get("error") ?? "",
      )
        ? expired
        : "로그인 링크를 확인할 수 없습니다. 새 로그인 메일을 요청하세요.",
    );
  const accessToken = params.get("access_token") ?? "",
    refreshToken = params.get("refresh_token") ?? "";
  if (
    !accessToken ||
    !refreshToken ||
    /\s/.test(accessToken + refreshToken) ||
    params.get("token_type")?.toLowerCase() !== "bearer"
  )
    return failure();
  if (
    params.has("type") &&
    !["magiclink", "signup", "email"].includes(params.get("type")!)
  )
    return failure();
  for (const field of ["expires_at", "expires_in"]) {
    const value = params.get(field);
    if (
      value !== null &&
      (!/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) <= 0)
    )
      return failure();
  }
  try {
    const parts = accessToken.split(".");
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      return failure();
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    );
    if (!claims || typeof claims !== "object") return failure();
    const c = claims as Record<string, unknown>;
    if (
      typeof c.iss !== "string" ||
      typeof c.sub !== "string" ||
      !uuid.test(c.sub) ||
      !Number.isSafeInteger(c.exp)
    )
      return failure();
    if (
      (c.exp as number) <= now / 1000 ||
      (params.has("expires_at") &&
        Number(params.get("expires_at")) <= now / 1000)
    )
      return failure(expired);
    return {
      kind: "session",
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: c.exp as number,
        issuer: c.iss,
        subject: c.sub,
      },
    };
  } catch {
    return failure();
  }
}

export function captureAuthRedirect(
  location?: Pick<Location, "href">,
  history?: Pick<History, "state" | "replaceState">,
): AuthRedirect {
  if (!location || !history) {
    if (typeof window === "undefined") return { kind: "none" };
    location = window.location;
    history = window.history;
  }
  const url = new URL(location.href),
    fragment = url.hash;
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  if (!authKeys.some((key) => params.has(key))) return { kind: "none" };
  try {
    history.replaceState(history.state, "", authReturnUrl(url.href));
  } catch {
    return failure(
      "로그인 주소를 정리할 수 없습니다. 새 창에서 앱을 열고 다시 로그인하세요.",
    );
  }
  return parseAuthFragment(fragment);
}
