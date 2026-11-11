export const DEFAULT_API_BASE = "http://127.0.0.1:8787";

/**
 * Resolve the API base URL. Precedence: `?api=` query param, then
 * VITE_OPENLID_API_BASE, then http://127.0.0.1:8787. The value
 * `same-origin` means "use relative /api paths" (served via the Vite proxy).
 */
export function resolveApiBase(search: string, envBase: string | undefined): string {
  const fromQuery = new URLSearchParams(search).get("api");
  const raw = fromQuery ?? envBase ?? DEFAULT_API_BASE;
  if (raw === "same-origin" || raw === "") return "";
  return raw.replace(/\/+$/, "");
}

/** `?mock=1` serves the bundled fixture instead of calling the API. */
export function isMockMode(search: string): boolean {
  const v = new URLSearchParams(search).get("mock");
  return v === "1" || v === "true";
}
