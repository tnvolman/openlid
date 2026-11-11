import type { Api } from "./api.ts";
import { friendlyError } from "./format.ts";
import type { Gift, HoldView, PayoutView, Summary } from "./types.ts";

/** Stamp shown after a load; includes seconds so a refresh is visibly new. */
export const UPDATED_TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};

export function formatUpdated(now = new Date()): string {
  return ` · updated ${now.toLocaleTimeString("en-US", UPDATED_TIME_OPTS)}`;
}

export type RefreshButton = {
  disabled: boolean;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export type FlashEl = {
  textContent: string;
  offsetWidth: number;
  classList: { remove(token: string): void; add(token: string): void };
};

export type PageEls = {
  refreshBtn: RefreshButton;
  error: { hidden: boolean; textContent: string };
  summary: { innerHTML: string };
  holds: { innerHTML: string };
  payouts: { innerHTML: string };
  gifts: { innerHTML: string };
  updated: FlashEl;
};

export function showError(el: PageEls["error"], err: unknown) {
  if (err == null) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = `Error: ${friendlyError(err instanceof Error ? err.message : String(err))}`;
}

export type Renderers = {
  renderSummary: (value: Summary) => string;
  renderHolds: (value: HoldView[]) => string;
  renderPayouts: (value: PayoutView[]) => string;
  renderGifts: (value: Gift[]) => string;
};

/**
 * Fetch the four treasury endpoints and paint the page. The Refresh button is
 * disabled and labelled "Refreshing…" while this runs. Does not touch Approve/Reject.
 */
export async function load(api: Api, els: PageEls, render: Renderers, now = new Date()): Promise<void> {
  showError(els.error, null);

  const label = els.refreshBtn.textContent || "Refresh";
  els.refreshBtn.disabled = true;
  els.refreshBtn.setAttribute("aria-busy", "true");
  els.refreshBtn.textContent = "Refreshing…";

  try {
    const results = await Promise.allSettled([api.summary(), api.heldHolds(), api.payouts(), api.gifts()]);
    const [summary, holds, payouts, gifts] = results;
    els.summary.innerHTML = summary.status === "fulfilled" ? render.renderSummary(summary.value) : "Unavailable.";
    els.holds.innerHTML = holds.status === "fulfilled" ? render.renderHolds(holds.value) : "Unavailable.";
    els.payouts.innerHTML = payouts.status === "fulfilled" ? render.renderPayouts(payouts.value) : "Unavailable.";
    els.gifts.innerHTML = gifts.status === "fulfilled" ? render.renderGifts(gifts.value) : "Unavailable.";

    els.updated.textContent = formatUpdated(now);
    els.updated.classList.remove("updated-flash");
    void els.updated.offsetWidth;
    els.updated.classList.add("updated-flash");

    const failed = results.find((r) => r.status === "rejected");
    if (failed) showError(els.error, (failed as PromiseRejectedResult).reason);
  } catch (err) {
    showError(els.error, err);
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.removeAttribute("aria-busy");
    els.refreshBtn.textContent = label;
  }
}
