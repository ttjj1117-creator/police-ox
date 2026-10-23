/// <reference types="vite/client" />

export function appBasePath(): string {
  return import.meta.env.BASE_URL;
}

export function appUrl(query = ""): string {
  return (
    appBasePath() + (query && !query.startsWith("?") ? "?" + query : query)
  );
}
