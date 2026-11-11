// Static demo fixture for ?mock=1 and tests (Example Community Church). Mirrors the testnet demo: every
// gift is a dry-run quote with a simulated `sim:` deposit address (no real
// deposit address, no live cross-chain deposit). Fake .testnet names only:
// no keys, no real wallets, no mainnet anything.
import type { FetchLike } from "./api.ts";
import { BOUNDARY_LINES, FUND_RESTRICTION, FUNDS, RECEIPT_NOTE } from "./types.ts";
import type { Fund, Gift, HoldView, PayoutView, Summary } from "./types.ts";

const gift = (id: string, donor: string, fund: Gift["fund"], amountOut: string, status: Gift["status"]): Gift => ({
  id,
  donor,
  fund,
  depositAddress: `sim:${id}`,
  depositMemo: null,
  correlationId: `demo-corr-${id}`,
  amountIn: amountOut,
  amountOut,
  originAsset: "nep141:demo-usdc.base.omft.near",
  status,
  quoteMode: "dry_run",
  receiptNote: RECEIPT_NOTE,
});

export function fixtureState() {
  return {
    gifts: [
      gift("g6", "donor-demo-6", "building", "75000000", "failed"),
      gift("g5", "donor-demo-5", "missions", "40000000", "refunded"),
      gift("g4", "donor-demo-4", "general", "10000000", "processing"),
      gift("g3", "donor-demo-3", "building", "250000000", "settled"),
      gift("g2", "donor-demo-2", "missions", "60000000", "settled"),
      gift("g1", "donor-demo-1", "general", "100000000", "settled"),
    ] as Gift[],
    // Every bill names a fund and fits it: building received 250, paid 180 (electric for the building).
    // The general-fund hold reserves 90 of its 100, leaving 10 uncommitted; see fund math in summarize().
    payouts: [
      {
        bill_id: "bill-electric-001",
        vendor: "power-co.demo.testnet",
        amount: "180000000",
        memo: "Electric, October",
        fund: "building",
        status: "paid",
        requestedAt: "2026-11-03T15:20:00.000Z",
        paidAt: "2026-11-03T15:20:00.000Z",
        paymentTxHash: "demoTxElectric001PaidOnTestnet",
        requestTxHash: "demoTxElectric001PaidOnTestnet",
      },
    ] as PayoutView[],
    holds: [
      {
        bill_id: "bill-roof-002",
        vendor: "roofer.demo.testnet",
        amount: "90000000",
        memo: "Roof repair deposit",
        fund: "general",
        status: "held",
        requestedAt: "2026-11-10T18:05:00.000Z",
        requestTxHash: "demoTxRoof002RequestOnTestnet",
        paidAt: null,
        paymentTxHash: null,
      },
    ] as HoldView[],
  };
}

export type FixtureState = ReturnType<typeof fixtureState>;

const sum = (xs: string[]) => xs.reduce((a, b) => a + BigInt(b), 0n).toString();

/** Fund ledger as the contract keeps it: received, paid, and held (outstanding holds, reserved). */
export function ledger(s: FixtureState, fund: Fund) {
  const received = BigInt(sum(s.gifts.filter((g) => g.fund === fund && g.status === "settled").map((g) => g.amountOut)));
  const paid = BigInt(sum(s.payouts.filter((p) => p.fund === fund).map((p) => p.amount)));
  const held = BigInt(sum(s.holds.filter((h) => h.fund === fund && h.status === "held").map((h) => h.amount)));
  return { received, paid, held };
}

/** Uncommitted balance: received - paid - held, never negative. */
export function available(s: FixtureState, fund: Fund): bigint {
  const { received, paid, held } = ledger(s, fund);
  const a = received - paid - held;
  return a > 0n ? a : 0n;
}

/**
 * Fixture summary. Live cash defaults to the fund ledger total (a matching treasury); pass `cash` to show a
 * mismatch.
 */
export function summarize(s: FixtureState, cash?: string): Summary {
  const held = s.holds.filter((h) => h.status === "held");
  const giftsByFund = Object.fromEntries(
    FUNDS.map((f) => {
      const l = ledger(s, f);
      return [
        f,
        {
          restriction: FUND_RESTRICTION[f],
          count: s.gifts.filter((g) => g.fund === f && g.status === "settled").length,
          received: l.received.toString(),
          paidOut: l.paid.toString(),
          held: l.held.toString(),
          available: (l.received - l.paid - l.held).toString(),
        },
      ];
    }),
  ) as Summary["giftsByFund"];
  const ledgerTotal = FUNDS.reduce((acc, f) => acc + ledger(s, f).received - ledger(s, f).paid, 0n);
  const treasuryBalance = cash ?? ledgerTotal.toString();
  const difference = BigInt(treasuryBalance) - ledgerTotal;
  return {
    giftsByFund,
    treasuryBalance,
    reconciliation: {
      cash: treasuryBalance,
      ledgerTotal: ledgerTotal.toString(),
      ledgerSource: "chain",
      difference: difference.toString(),
      status: difference === 0n ? "match" : "mismatch",
    },
    payouts: { paidCount: s.payouts.length, paidAmount: sum(s.payouts.map((p) => p.amount)) },
    holds: { heldCount: held.length, heldAmount: sum(held.map((h) => h.amount)) },
    receiptNote: RECEIPT_NOTE,
  };
}

/** Same layout as the API export: disclaimers, one row per gift/payout with fund, then reconciliation. */
export function fixtureCsv(s: FixtureState): string {
  const lines = [
    `# ${RECEIPT_NOTE}`,
    `# ${BOUNDARY_LINES[0]}`,
    `# ${BOUNDARY_LINES[1]}`,
    `# ${BOUNDARY_LINES[4]}`,
    `# ${BOUNDARY_LINES[5]}`,
    "type,id,party,fund,restriction,amount_usdc_book_value_at_receipt,status,paid_at,payment_ref",
  ];
  for (const g of s.gifts) {
    lines.push(`gift,${g.id},${g.donor},${g.fund},${FUND_RESTRICTION[g.fund]},${g.amountOut},${g.status},,`);
  }
  for (const p of [...s.payouts, ...s.holds.filter((h) => h.status !== "approved")]) {
    lines.push(
      `payout,${p.bill_id},${p.vendor},${p.fund},${FUND_RESTRICTION[p.fund]},${p.amount},${p.status},${p.paidAt ?? ""},${p.paymentTxHash ?? ""}`,
    );
  }
  const sum = summarize(s);
  lines.push("", "# per-fund reconciliation (USDC atomic units, book value at receipt; available = received - paid - held)");
  lines.push("fund,restriction,gifts,received,paid,held,available");
  for (const f of FUNDS) {
    const x = sum.giftsByFund[f];
    lines.push([f, x.restriction, x.count, x.received, x.paidOut, x.held, x.available].join(","));
  }
  const r = sum.reconciliation!;
  lines.push(`# treasury cash (on-chain): ${r.cash}; fund ledgers total (received - paid, from chain): ${r.ledgerTotal}; ${r.status}`);
  return lines.join("\n") + "\n";
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** In-memory fetch that answers the INTERFACES.md routes from the fixture. */
export function createMockFetch(state: FixtureState = fixtureState()): FetchLike & { state: FixtureState } {
  const fn = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://mock.local");
    const method = (init?.method ?? "GET").toUpperCase();
    const p = url.pathname;
    if (method === "GET" && p === "/api/summary") return json(200, summarize(state));
    if (method === "GET" && p === "/api/gifts") {
      const fund = url.searchParams.get("fund");
      return json(200, { gifts: fund ? state.gifts.filter((g) => g.fund === fund) : state.gifts });
    }
    if (method === "GET" && p === "/api/payouts") return json(200, { payouts: state.payouts });
    if (method === "GET" && p === "/api/holds") {
      const st = url.searchParams.get("status");
      return json(200, { holds: st ? state.holds.filter((h) => h.status === st) : state.holds });
    }
    if (method === "GET" && p === "/api/export.csv") {
      return new Response(fixtureCsv(state), { status: 200, headers: { "content-type": "text/csv" } });
    }
    const m = p.match(/^\/api\/holds\/([^/]+)\/(approve|reject)$/);
    if (method === "POST" && m) {
      const billId = decodeURIComponent(m[1]);
      const hold = state.holds.find((h) => h.bill_id === billId);
      if (!hold) return json(404, { error: `no hold ${billId}` });
      if (hold.status !== "held") return json(409, { error: `hold ${billId} is ${hold.status}` });
      if (m[2] === "approve") {
        // Same re-check (and message) as the contract's approve_hold: this hold's own reservation set aside.
        const l = ledger(state, hold.fund);
        const excl = l.received - l.paid - (l.held - BigInt(hold.amount));
        const avail = excl > 0n ? excl : 0n;
        if (BigInt(hold.amount) > avail) {
          return json(422, {
            error: `contract rejected: insufficient fund balance: ${hold.fund} has ${avail} available, bill needs ${hold.amount}`,
          });
        }
        hold.status = "approved";
        hold.paidAt = new Date().toISOString();
        hold.paymentTxHash = `demoTxApprove-${hold.bill_id}`;
        state.payouts.unshift({
          bill_id: hold.bill_id,
          vendor: hold.vendor,
          amount: hold.amount,
          memo: hold.memo,
          fund: hold.fund,
          status: "paid",
          requestedAt: hold.requestedAt,
          paidAt: hold.paidAt,
          paymentTxHash: hold.paymentTxHash,
          requestTxHash: hold.requestTxHash,
        });
      } else {
        hold.status = "rejected";
      }
      return json(200, hold);
    }
    return json(404, { error: `mock: no route ${method} ${p}` });
  };
  return Object.assign(fn, { state });
}
