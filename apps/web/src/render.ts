import { countByStatus, escapeHtml as e, formatDate, formatFund, formatSignedUsdc, formatTime, formatUsdc, formatUsdcPrecise, groupGiftsByFund } from "./format.ts";
import { AMOUNT_CAPTION, FUND_RESTRICTION, FUND_SILO_NOTE, FUNDS, RECON_NOTE } from "./types.ts";
import { isSimulatedAddress } from "./types.ts";
import type { Gift, HoldView, PayoutView, Summary } from "./types.ts";

const status = (s: string) => `<span class="pill status status-${e(s)}">${e(s)}</span>`;
const empty = (msg: string) => `<p class="empty">${e(msg)}</p>`;
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
/** Every amount table sits in a white card that scrolls sideways on its own if it is wider than the screen. */
const tableCard = (cls: string, table: string) => `<div class="table-card ${cls}">${table}</div>`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "230.00 USDC" as a KPI figure with a smaller unit. Display only: the formatted string is split, not recomputed. */
function figure(atomic: string | null | undefined): string {
  const s = formatUsdc(atomic);
  return s.endsWith(" USDC") ? `${s.slice(0, -5)} <span class="unit">USDC</span>` : s;
}

const amountTitle = (atomic: string | null | undefined) => {
  const full = formatUsdcPrecise(atomic);
  return full === "—" ? "" : ` title="${e(full)}"`;
};

/** Table cell: 2-decimal display, full 6-decimal precision in the tooltip. */
const amountCell = (atomic: string | null | undefined, cls = "num") =>
  `<td class="${cls}"${amountTitle(atomic)}>${formatUsdc(atomic)}</td>`;

const kpi = (label: string, value: string, foot: string, atomic?: string | null) =>
  `<div class="kpi"><p class="kpi-label">${label}</p><p class="kpi-num"${atomic != null ? amountTitle(atomic) : ""}>${value}</p>${foot}</div>`;

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
    return `<tr data-fund="${f}"><td class="fund-name" data-restriction="${e(row.restriction ?? FUND_RESTRICTION[f])}">${e(formatFund(f))}</td><td class="restriction hide-m">${e(row.restriction ?? FUND_RESTRICTION[f])}</td><td class="num hide-m">${row.count}</td>
      ${amountCell(row.received, "num hide-m")}${amountCell(row.paidOut, "num hide-m")}
      ${amountCell(row.held)}${amountCell(row.available)}</tr>`;
  }).join("");
  return `${renderReconciliation(s)}
    <section>
    <h2>Funds</h2>
    ${tableCard(
      "funds",
      `<table>
      <caption>${e(AMOUNT_CAPTION)}</caption>
      <thead><tr><th>Fund</th><th class="hide-m">Restriction</th><th class="num hide-m">Gifts</th><th class="num hide-m">Received</th><th class="num hide-m">Paid out</th><th class="num">Held</th><th class="num">Available</th></tr></thead>
      <tbody>${fundRows}</tbody>
    </table>`,
    )}
    <p class="note">Available is uncommitted: received − paid out − held. Holds reserve their amount until approved or rejected. ${e(FUND_SILO_NOTE)}</p>
    </section>`;
}

/**
 * KPI row: live cash next to the sum of fund ledgers, with a match / mismatch / unknown line that is ALWAYS shown
 * (credit_fund amounts are owner-entered and not checked against the tokens received, so this line is the only
 * catch), then payouts and outstanding holds.
 */
export function renderReconciliation(s: Summary): string {
  const r = s.reconciliation;
  const cash = s.treasuryBalance ?? r?.cash ?? null;
  const cards: string[] = [];
  if (cash != null) {
    cards.push(kpi("Treasury balance", figure(cash), `<p class="kpi-note">Live, NEAR testnet</p>`, cash));
  }
  let recon: string;
  let ledgerNote = "";
  if (!r) {
    recon = `<p class="recon recon-unknown" data-recon="unknown">Cash vs fund ledgers was not reported by the API, so it is not checked.</p>`;
  } else {
    ledgerNote = `<p class="kpi-note">Received − paid, ${r.ledgerSource === "chain" ? "NEAR testnet" : "API records"}</p>`;
    if (r.status === "match") {
      recon = `<p class="recon recon-match" data-recon="match">Cash matches the fund ledgers.</p>`;
    } else if (r.status === "mismatch") {
      recon = `<p class="recon recon-mismatch" data-recon="mismatch" role="alert"><strong>Mismatch:</strong> treasury cash differs from the fund ledgers by ${formatSignedUsdc(r.difference ?? "0")} (cash − ledgers). Investigate before paying bills: tokens may have arrived without a fund credit, or a credit may be missing its tokens.</p>`;
    } else {
      recon = `<p class="recon recon-unknown" data-recon="unknown">Cash could not be read, so cash vs fund ledgers is not checked.</p>`;
    }
  }
  cards.push(kpi("Fund ledgers", r ? figure(r.ledgerTotal) : "—", `${recon}${ledgerNote}`, r ? r.ledgerTotal : null));
  cards.push(kpi("Paid out", figure(s.payouts.paidAmount), `<p class="kpi-note">${plural(s.payouts.paidCount, "payout", "payouts")} paid</p>`, s.payouts.paidAmount));
  const n = s.holds.heldCount;
  const holdNote = n === 0 ? "No bills waiting" : `${plural(n, "bill needs", "bills need")} a decision`;
  cards.push(kpi("On hold", figure(s.holds.heldAmount), `<p class="kpi-note">${holdNote}</p>`, s.holds.heldAmount));
  return `<div class="kpis">${cards.join("\n")}</div>
    <p class="note recon-note">${e(RECON_NOTE)}</p>`;
}

const ref = (hash: string | null | undefined) => (hash ? `<code title="${e(hash)}">${e(short(hash))}</code>` : "—");

const timeCell = (iso: string | null | undefined, mode: "date" | "datetime" = "datetime") => {
  if (mode === "date") {
    const date = formatDate(iso);
    const full = formatTime(iso);
    return iso && date !== "—" ? `<td title="${e(full)}">${e(date)}</td>` : "<td>—</td>";
  }
  const label = formatTime(iso);
  return iso && label !== "—" ? `<td title="${e(iso)}">${e(label)}</td>` : "<td>—</td>";
};

/**
 * First cell of a bill row: the memo as the bill name, then the bill id.
 * Phone (`.m-only`) and tablet (`.t-only`) meta lines carry facts from columns that hide at those widths.
 */
const billCell = (
  b: { bill_id: string; memo: string; vendor: string; fund: string },
  opts: { mobileMeta?: string; tabletMeta?: string; mobileRef?: string; facts?: string } = {},
) => {
  const name = b.memo || b.vendor;
  return `<td class="bill"><span class="bill-name" title="${e(name)}">${e(name)}</span><span class="bill-to" title="${e(b.vendor)}">to <span class="nowrap">${e(b.vendor)}</span></span><span class="bill-meta"><code title="${e(b.bill_id)}">${e(b.bill_id)}</code><span class="m-only"> · <span class="cap">${e(formatFund(b.fund))}</span>${opts.mobileMeta ?? ""}</span></span>${opts.tabletMeta ? `<span class="bill-meta t-only">${opts.tabletMeta}</span>` : ""}${opts.mobileRef ?? ""}${opts.facts ?? ""}</td>`;
};

export function renderHolds(holds: HoldView[]): string {
  const held = holds.filter((h) => h.status === "held");
  if (held.length === 0) return empty("No bills waiting for the treasurer.");
  const rows = held
    .map(
      (h) => `<tr data-bill-id="${e(h.bill_id)}">
        ${billCell(h, {
          tabletMeta: `<span class="cap">${e(formatFund(h.fund))}</span> · ${e(formatTime(h.requestedAt))} · ${ref(h.requestTxHash)}`,
          facts: `<span class="bill-facts m-only"${amountTitle(h.amount)}><span class="cap">${e(formatFund(h.fund))}</span> · ${e(formatUsdc(h.amount))}</span>`,
        })}<td>${e(formatFund(h.fund))}</td><td>${e(h.vendor)}</td>
        ${amountCell(h.amount)}<td>${e(h.memo)}</td>
        ${timeCell(h.requestedAt, "date")}<td>${ref(h.requestTxHash)}</td><td>${status(h.status)}</td>
        <td class="actions"><div class="acts">
          <button type="button" class="btn btn-reject" data-action="reject" data-bill-id="${e(h.bill_id)}">Reject</button>
          <button type="button" class="btn btn-approve" data-action="approve" data-bill-id="${e(h.bill_id)}">Approve</button>
        </div></td></tr>`,
    )
    .join("");
  return tableCard(
    "holds",
    `<table>
    <caption>${e(AMOUNT_CAPTION)}</caption>
    <thead><tr><th>Bill</th><th>Fund</th><th>Vendor</th><th class="num">Amount</th><th>Memo</th><th>Requested</th><th>Request ref</th><th>Status</th><th class="actions">Treasurer</th></tr></thead>
    <tbody>${rows}</tbody></table>`,
  );
}

export function renderPayouts(payouts: PayoutView[]): string {
  if (payouts.length === 0) return empty("No payouts yet.");
  const rows = payouts
    .map(
      (p) => `<tr data-bill-id="${e(p.bill_id)}">${billCell(p, {
          tabletMeta: `<span class="cap">${e(formatFund(p.fund))}</span> · ${e(formatTime(p.requestedAt))} · tx ${ref(p.paymentTxHash)}`,
          mobileRef: `<span class="bill-meta m-only">tx ${ref(p.paymentTxHash)}</span>`,
        })}<td>${e(formatFund(p.fund))}</td><td>${e(p.vendor)}</td>
        ${amountCell(p.amount)}<td>${e(p.memo)}</td>
        ${timeCell(p.requestedAt, "date")}${timeCell(p.paidAt)}<td>${ref(p.paymentTxHash)}</td><td>${status(p.status)}</td></tr>`,
    )
    .join("");
  return tableCard(
    "payouts",
    `<table>
    <caption>${e(AMOUNT_CAPTION)}</caption>
    <thead><tr><th>Bill</th><th>Fund</th><th>Vendor</th><th class="num">Amount</th><th>Memo</th><th>Requested</th><th>Paid</th><th>Payment ref</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody></table>`,
  );
}

const deposit = (g: Gift) =>
  `<code title="${e(g.depositAddress)}">${e(short(g.depositAddress))}</code>${isSimulatedAddress(g.depositAddress) ? ' <span class="badge">simulated</span>' : ""}`;

function giftTable(gifts: Gift[]): string {
  if (gifts.length === 0) return empty("No gifts.");
  const rows = gifts
    .map(
      (g) => `<tr data-gift-id="${e(g.id)}"><td class="donor" title="${e(g.donor)}">${e(g.donor)}<span class="bill-meta m-only">${deposit(g)}</span></td>
        ${amountCell(g.amountOut)}<td>${status(g.status)}</td>
        <td class="deposit">${deposit(g)}</td>
        <td class="origin" title="${e(g.originAsset)}">${e(g.originAsset)}</td></tr>`,
    )
    .join("");
  return tableCard(
    "gifts",
    `<table>
    <caption>${e(AMOUNT_CAPTION)}</caption>
    <thead><tr><th>Donor</th><th class="num">USDC out</th><th>Status</th><th>Deposit address</th><th>Origin asset</th></tr></thead>
    <tbody>${rows}</tbody></table>`,
  );
}

export function renderGifts(gifts: Gift[]): string {
  const groups = groupGiftsByFund(gifts);
  const sections = FUNDS.map((f) => {
    const counts = Object.entries(countByStatus(groups[f]))
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    return `<div class="fund" data-fund="${f}">
      <h3><span class="cap">${e(formatFund(f))}</span> <small>(${groups[f].length}${counts ? `: ${e(counts)}` : ""})</small></h3>
      ${giftTable(groups[f])}</div>`;
  });
  if (groups.other.length) {
    sections.push(`<div class="fund" data-fund="other"><h3>unrecognized fund tag</h3>${giftTable(groups.other)}</div>`);
  }
  return sections.join("");
}
