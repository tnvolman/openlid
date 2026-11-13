import type { Gift, HoldView, PayoutView, Summary } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Header the API checks on approve/reject (and nowhere else). */
export const APPROVAL_HEADER = "X-OpenLid-Approval";

export interface ApiOptions {
  /** Sent as X-OpenLid-Approval on approveHold/rejectHold only. Unset: the header is omitted. */
  approvalSecret?: string;
}

/** Client for the OpenLid HTTP API. `base` has no trailing slash ("" = same origin). */
export function createApi(base: string, fetchImpl: FetchLike = (i, init) => fetch(i, init), opts: ApiOptions = {}) {
  const root = base.replace(/\/+$/, "");

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    // no-store last so a caller cannot override it; the page must show live hold/payout state.
    const res = await fetchImpl(`${root}${path}`, { ...init, cache: "no-store" });
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

  const treasurerPost = (): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.approvalSecret ? { [APPROVAL_HEADER]: opts.approvalSecret } : {}),
    },
    body: "{}",
  });

  return {
    exportCsvUrl: `${root}/api/export.csv`,
    summary: () => call<Summary>("/api/summary"),
    gifts: async () => (await call<{ gifts: Gift[] }>("/api/gifts")).gifts,
    payouts: async () => (await call<{ payouts: PayoutView[] }>("/api/payouts")).payouts,
    heldHolds: async () => (await call<{ holds: HoldView[] }>("/api/holds?status=held")).holds,
    approveHold: (billId: string) =>
      call<unknown>(`/api/holds/${encodeURIComponent(billId)}/approve`, treasurerPost()),
    rejectHold: (billId: string) =>
      call<unknown>(`/api/holds/${encodeURIComponent(billId)}/reject`, treasurerPost()),
  };
}

export type Api = ReturnType<typeof createApi>;
