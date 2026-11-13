import { createApi } from "./api.ts";
import type { Api } from "./api.ts";
import { isMockMode, resolveApiBase, resolveApprovalSecret } from "./config.ts";
import { triggerCsvDownload } from "./csv.ts";
import { createMockFetch } from "./fixtures.ts";
import { load, showError, type PageEls } from "./load.ts";
import { renderGifts, renderHolds, renderPayouts, renderSummary } from "./render.ts";
import { RECEIPT_NOTE, TESTNET_NOTICE } from "./types.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const mock = isMockMode(location.search);
const mockFetch = mock ? createMockFetch() : undefined;
const base = mock ? "" : resolveApiBase(location.search, import.meta.env.VITE_OPENLID_API_BASE);
// Mock mode needs no secret; the in-memory fixture does not check it.
const approvalSecret = mock ? undefined : resolveApprovalSecret(import.meta.env.VITE_OPENLID_APPROVAL_SECRET);
const api: Api = createApi(base, mockFetch, { approvalSecret });

$("api-base").textContent = mock ? "(in-memory fixture)" : base || "same origin (/api via Vite proxy)";
$("mode-badge").hidden = !mock;
$("receipt-note").textContent = RECEIPT_NOTE;
$("testnet-notice").textContent = TESTNET_NOTICE;

const els: PageEls = {
  refreshBtn: $("refresh") as HTMLButtonElement,
  error: $("error"),
  summary: $("summary"),
  holds: $("holds"),
  payouts: $("payouts"),
  gifts: $("gifts"),
  updated: $("updated") as PageEls["updated"],
};

const render = { renderSummary, renderHolds, renderPayouts, renderGifts };

async function reload() {
  await load(api, els, render);
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
    await reload();
  } catch (err) {
    showError(els.error, err);
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

$("refresh").addEventListener("click", () => void reload());

void reload();
