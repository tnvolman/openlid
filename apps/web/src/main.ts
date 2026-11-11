import { createApi } from "./api.ts";
import type { Api } from "./api.ts";
import { isMockMode, resolveApiBase } from "./config.ts";
import { triggerCsvDownload } from "./csv.ts";
import { createMockFetch } from "./fixtures.ts";
import { friendlyError } from "./format.ts";
import { renderGifts, renderHolds, renderPayouts, renderSummary } from "./render.ts";
import { RECEIPT_NOTE, TESTNET_NOTICE } from "./types.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const mock = isMockMode(location.search);
const mockFetch = mock ? createMockFetch() : undefined;
const base = mock ? "" : resolveApiBase(location.search, import.meta.env.VITE_OPENLID_API_BASE);
const api: Api = createApi(base, mockFetch);

$("api-base").textContent = mock ? "(in-memory fixture)" : base || "same origin (/api via Vite proxy)";
$("mode-badge").hidden = !mock;
$("receipt-note").textContent = RECEIPT_NOTE;
$("testnet-notice").textContent = TESTNET_NOTICE;

function showError(err: unknown) {
  const el = $("error");
  if (err == null) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = `Error: ${friendlyError(err instanceof Error ? err.message : String(err))}`;
}

async function load() {
  showError(null);
  const results = await Promise.allSettled([api.summary(), api.heldHolds(), api.payouts(), api.gifts()]);
  const [summary, holds, payouts, gifts] = results;
  $("summary").innerHTML = summary.status === "fulfilled" ? renderSummary(summary.value) : "Unavailable.";
  $("holds").innerHTML = holds.status === "fulfilled" ? renderHolds(holds.value) : "Unavailable.";
  $("payouts").innerHTML = payouts.status === "fulfilled" ? renderPayouts(payouts.value) : "Unavailable.";
  $("gifts").innerHTML = gifts.status === "fulfilled" ? renderGifts(gifts.value) : "Unavailable.";
  const failed = results.find((r) => r.status === "rejected");
  if (failed) showError((failed as PromiseRejectedResult).reason);
}

$("holds").addEventListener("click", async (ev) => {
  const btn = (ev.target as HTMLElement).closest("button[data-action]") as HTMLButtonElement | null;
  if (!btn) return;
  const billId = btn.dataset.billId!;
  const action = btn.dataset.action as "approve" | "reject";
  if (!confirm(`${action === "approve" ? "Approve and pay" : "Reject"} bill ${billId}?`)) return;
  // On-chain approve/reject waits for NEAR finality (often 20-30 s): show progress and block double clicks.
  const row = btn.closest("td");
  const rowButtons = Array.from(row?.querySelectorAll("button") ?? [btn]) as HTMLButtonElement[];
  const label = btn.textContent;
  rowButtons.forEach((b) => (b.disabled = true));
  btn.textContent = action === "approve" ? "Paying… waiting for the blockchain" : "Rejecting… waiting for the blockchain";
  try {
    await (action === "approve" ? api.approveHold(billId) : api.rejectHold(billId));
    await load();
  } catch (err) {
    showError(err);
    btn.textContent = label;
    rowButtons.forEach((b) => (b.disabled = false));
  }
});

$("download-csv").addEventListener("click", async () => {
  if (!mockFetch) {
    triggerCsvDownload(document, api.exportCsvUrl);
    return;
  }
  const text = await (await mockFetch(api.exportCsvUrl)).text();
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  triggerCsvDownload(document, url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("refresh").addEventListener("click", () => void load());

void load();
