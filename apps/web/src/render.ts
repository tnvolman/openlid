import { countByStatus, escapeHtml as e, formatSignedUsdc, formatTime, formatUsdc, groupGiftsByFund } from "./format.ts";
import { FUND_RESTRICTION, FUND_SILO_NOTE, FUNDS } from "./types.ts";
import { isSimulatedAddress } from "./types.ts";
import type { Gift, HoldView, PayoutView, Summary } from "./types.ts";

const status = (s: string) => `<span class="status status-${e(s)}">${e(s)}</span>`;
const empty = (msg: string) => `<p class="empty">${e(msg)}</p>`;
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

export function renderSummary(s: Summary): string {
  const fundRows = FUNDS.map((f) => {
    const row = s.giftsByFund?.[f] ?? {
      restriction: FUND_RESTRICTION[f],
      count: 0,
      received: "0",
      paidOut: "0",
      held: "0",
      available: "0",
    };
    return `<tr data-fund="${f}"><td>${f}</td><td>${e(row.restriction ?? FUND_RESTRICTION[f])}</td><td class="num">${row.count}</td>
      <td class="num">${formatUsdc(row.received)}</td><td class="num">${formatUsdc(row.paidOut)}</td>
      <td class="num">${formatUsdc(row.held)}</td><td class="num">${formatUsdc(row.available)}</td></tr>`;
  }).join("");
  return `${renderReconciliation(s)}
    <table>
      <thead><tr><th>Fund</th><th>Restriction</th><th class="num">Gifts</th><th class="num">Received</th><th class="num">Paid out</th><th class="num">Held</th><th class="num">Available</th></tr></thead>
      <tbody>${fundRows}</tbody>
    </table>
    <p class="note">Available is uncommitted: received − paid out − held. Holds reserve their amount until approved or rejected. ${e(FUND_SILO_NOTE)}</p>
    <p>Payouts paid: <strong>${s.payouts.paidCount}</strong> (${formatUsdc(s.payouts.paidAmount)})
     · Holds outstanding: <strong>${s.holds.heldCount}</strong> (${formatUsdc(s.holds.heldAmount)})</p>`;
}

/** Live cash next to the sum of fund ledgers, with a visible flag when they differ. */
export function renderReconciliation(s: Summary): string {
  const r = s.reconciliation;
  const cash = s.treasuryBalance ?? r?.cash ?? null;
  const parts: string[] = [];
  if (cash != null) parts.push(`<p class="balance">Treasury balance (live, on-chain): <strong>${formatUsdc(cash)}</strong></p>`);
  if (r) {
    parts.push(
      `<p class="ledger-total">Sum of fund ledgers (received − paid, ${r.ledgerSource === "chain" ? "on-chain" : "API records"}): <strong>${formatUsdc(r.ledgerTotal)}</strong></p>`,
    );
    if (r.status === "match") {
      parts.push(`<p class="recon recon-match" data-recon="match">Cash matches the fund ledgers.</p>`);
    } else if (r.status === "mismatch") {
      parts.push(
        `<p class="recon recon-mismatch" data-recon="mismatch" role="alert"><strong>Mismatch:</strong> treasury cash differs from the fund ledgers by ${formatSignedUsdc(r.difference ?? "0")} (cash − ledgers). Investigate before paying bills: tokens may have arrived without a fund credit, or a credit may be missing its tokens.</p>`,
      );
    } else {
      parts.push(`<p class="recon recon-unknown" data-recon="unknown">Cash could not be read, so cash vs fund ledgers is not checked.</p>`);
    }
  }
  return parts.join("\n");
}

const ref = (hash: string | null | undefined) => (hash ? `<code title="${e(hash)}">${e(short(hash))}</code>` : "—");

export function renderHolds(holds: HoldView[]): string {
  const held = holds.filter((h) => h.status === "held");
  if (held.length === 0) return empty("No bills waiting for the treasurer.");
  const rows = held
    .map(
      (h) => `<tr data-bill-id="${e(h.bill_id)}">
        <td><code>${e(h.bill_id)}</code></td><td>${e(h.fund)}</td><td>${e(h.vendor)}</td>
        <td class="num">${formatUsdc(h.amount)}</td><td>${e(h.memo)}</td>
        <td>${formatTime(h.requestedAt)}</td><td>${ref(h.requestTxHash)}</td><td>${status(h.status)}</td>
        <td>
          <button type="button" data-action="approve" data-bill-id="${e(h.bill_id)}">Approve</button>
          <button type="button" data-action="reject" data-bill-id="${e(h.bill_id)}">Reject</button>
        </td></tr>`,
    )
    .join("");
  return `<table>
    <thead><tr><th>Bill</th><th>Fund</th><th>Vendor</th><th class="num">Amount</th><th>Memo</th><th>Requested</th><th>Request ref</th><th>Status</th><th>Treasurer</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderPayouts(payouts: PayoutView[]): string {
  if (payouts.length === 0) return empty("No payouts yet.");
  const rows = payouts
    .map(
      (p) => `<tr data-bill-id="${e(p.bill_id)}"><td><code>${e(p.bill_id)}</code></td><td>${e(p.fund)}</td><td>${e(p.vendor)}</td>
        <td class="num">${formatUsdc(p.amount)}</td><td>${e(p.memo)}</td>
        <td>${formatTime(p.requestedAt)}</td><td>${formatTime(p.paidAt)}</td><td>${ref(p.paymentTxHash)}</td><td>${status(p.status)}</td></tr>`,
    )
    .join("");
  return `<table>
    <thead><tr><th>Bill</th><th>Fund</th><th>Vendor</th><th class="num">Amount</th><th>Memo</th><th>Requested</th><th>Paid</th><th>Payment ref</th><th>Status</th></tr></thead>
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
