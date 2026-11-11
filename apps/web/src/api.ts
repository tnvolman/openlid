import type { Gift, HoldView, PayoutView, Summary } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Client for the OpenLid HTTP API. `base` has no trailing slash ("" = same origin). */
export function createApi(base: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)) {
  const root = base.replace(/\/+$/, "");

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    // no-store: the page must always show live hold/payout state, never a cached copy.
    const res = await fetchImpl(`${root}${path}`, { cache: "no-store", ...init });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, msg);
    }
    return body as T;
  }

  const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

  return {
    exportCsvUrl: `${root}/api/export.csv`,
    summary: () => call<Summary>("/api/summary"),
    gifts: async () => (await call<{ gifts: Gift[] }>("/api/gifts")).gifts,
    payouts: async () => (await call<{ payouts: PayoutView[] }>("/api/payouts")).payouts,
    heldHolds: async () => (await call<{ holds: HoldView[] }>("/api/holds?status=held")).holds,
    approveHold: (billId: string) =>
      call<unknown>(`/api/holds/${encodeURIComponent(billId)}/approve`, post),
    rejectHold: (billId: string) =>
      call<unknown>(`/api/holds/${encodeURIComponent(billId)}/reject`, post),
  };
}

export type Api = ReturnType<typeof createApi>;
