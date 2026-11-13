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

/**
 * Treasurer approval secret (VITE_OPENLID_APPROVAL_SECRET), sent as `X-OpenLid-Approval` on approve/reject
 * only. Blank means unset; the API then answers approve/reject with its own error (401 or 503). This is a
 * local demo control: anything that can read this page's build or env can read the value.
 */
export function resolveApprovalSecret(envSecret: string | undefined): string | undefined {
  const v = envSecret?.trim();
  return v ? v : undefined;
}
