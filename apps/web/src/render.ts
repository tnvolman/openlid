import { countByStatus, escapeHtml as e, formatUsdc, groupGiftsByFund } from "./format.ts";
import { FUNDS } from "./types.ts";
import { isSimulatedAddress } from "./types.ts";
import type { Gift, HoldView, PayoutView, Summary } from "./types.ts";

const status = (s: string) => `<span class="status status-${e(s)}">${e(s)}</span>`;
const empty = (msg: string) => `<p class="empty">${e(msg)}</p>`;
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

export function renderSummary(s: Summary): string {
  const fundRows = FUNDS.map((f) => {
    const row = s.giftsByFund?.[f] ?? { settledAmount: "0", count: 0 };
    return `<tr><td>${f}</td><td class="num">${row.count}</td><td class="num">${formatUsdc(row.settledAmount)}</td></tr>`;
  }).join("");
  return `
    <table>
      <thead><tr><th>Fund</th><th class="num">Gifts</th><th class="num">Settled</th></tr></thead>
      <tbody>${fundRows}</tbody>
    </table>
    <p>Payouts paid: <strong>${s.payouts.paidCount}</strong> (${formatUsdc(s.payouts.paidAmount)})
     · Holds outstanding: <strong>${s.holds.heldCount}</strong> (${formatUsdc(s.holds.heldAmount)})</p>`;
}

export function renderHolds(holds: HoldView[]): string {
  const held = holds.filter((h) => h.status === "held");
  if (held.length === 0) return empty("No bills waiting for the treasurer.");
  const rows = held
    .map(
      (h) => `<tr data-bill-id="${e(h.bill_id)}">
        <td><code>${e(h.bill_id)}</code></td><td>${e(h.vendor)}</td>
        <td class="num">${formatUsdc(h.amount)}</td><td>${e(h.memo)}</td><td>${status(h.status)}</td>
        <td>
          <button type="button" data-action="approve" data-bill-id="${e(h.bill_id)}">Approve</button>
          <button type="button" data-action="reject" data-bill-id="${e(h.bill_id)}">Reject</button>
        </td></tr>`,
    )
    .join("");
  return `<table>
    <thead><tr><th>Bill</th><th>Vendor</th><th class="num">Amount</th><th>Memo</th><th>Status</th><th>Treasurer</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderPayouts(payouts: PayoutView[]): string {
  if (payouts.length === 0) return empty("No payouts yet.");
  const rows = payouts
    .map(
      (p) => `<tr><td><code>${e(p.bill_id)}</code></td><td>${e(p.vendor)}</td>
        <td class="num">${formatUsdc(p.amount)}</td><td>${e(p.memo)}</td><td>${status(p.status)}</td></tr>`,
    )
    .join("");
  return `<table>
    <thead><tr><th>Bill</th><th>Vendor</th><th class="num">Amount</th><th>Memo</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function giftTable(gifts: Gift[]): string {
  if (gifts.length === 0) return empty("No gifts.");
  const rows = gifts
    .map(
      (g) => `<tr data-gift-id="${e(g.id)}"><td>${e(g.donor)}</td>
        <td class="num">${formatUsdc(g.amountOut)}</td><td>${status(g.status)}</td>
        <td><code title="${e(g.depositAddress)}">${e(short(g.depositAddress))}</code>${
          isSimulatedAddress(g.depositAddress) ? ' <span class="badge">simulated</span>' : ""
        }</td>
        <td>${e(g.originAsset)}</td></tr>`,
    )
    .join("");
  return `<table>
    <thead><tr><th>Donor</th><th class="num">USDC out</th><th>Status</th><th>Deposit address</th><th>Origin asset</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderGifts(gifts: Gift[]): string {
  const groups = groupGiftsByFund(gifts);
  const sections = FUNDS.map((f) => {
    const counts = Object.entries(countByStatus(groups[f]))
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    return `<div class="fund" data-fund="${f}">
      <h3>${f} <small>(${groups[f].length}${counts ? `: ${e(counts)}` : ""})</small></h3>
      ${giftTable(groups[f])}</div>`;
  });
  if (groups.other.length) {
    sections.push(`<div class="fund" data-fund="other"><h3>unrecognized fund tag</h3>${giftTable(groups.other)}</div>`);
  }
  return sections.join("");
}
