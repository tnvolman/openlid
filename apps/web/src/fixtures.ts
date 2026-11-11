// Static demo fixture for ?mock=1 and tests (Example Community Church). Mirrors the testnet demo: every
// gift is a dry-run quote with a simulated `sim:` deposit address (no real
// deposit address, no live cross-chain deposit). Fake .testnet names only:
// no keys, no real wallets, no mainnet anything.
import type { FetchLike } from "./api.ts";
import { FUNDS, RECEIPT_NOTE } from "./types.ts";
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
    // The general-fund hold (90 of 100 available) can be approved; see fund math in summarize().
    payouts: [
      { bill_id: "bill-electric-001", vendor: "power-co.demo.testnet", amount: "180000000", memo: "Electric, October", fund: "building", status: "paid" },
    ] as PayoutView[],
    holds: [
      { bill_id: "bill-roof-002", vendor: "roofer.demo.testnet", amount: "90000000", memo: "Roof repair deposit", fund: "general", status: "held" },
    ] as HoldView[],
  };
}

export type FixtureState = ReturnType<typeof fixtureState>;

const sum = (xs: string[]) => xs.reduce((a, b) => a + BigInt(b), 0n).toString();

/** Fund balance as the contract computes it: settled gifts received minus payouts paid. */
export function available(s: FixtureState, fund: Fund): bigint {
  const received = sum(s.gifts.filter((g) => g.fund === fund && g.status === "settled").map((g) => g.amountOut));
  const paid = sum(s.payouts.filter((p) => p.fund === fund).map((p) => p.amount));
  return BigInt(received) - BigInt(paid);
}

export function summarize(s: FixtureState): Summary {
  const held = s.holds.filter((h) => h.status === "held");
  const giftsByFund = Object.fromEntries(
    FUNDS.map((f) => {
      const settled = s.gifts.filter((g) => g.fund === f && g.status === "settled");
      const received = sum(settled.map((g) => g.amountOut));
      const paidOut = sum(s.payouts.filter((p) => p.fund === f).map((p) => p.amount));
      return [
        f,
        {
          count: settled.length,
          received,
          paidOut,
          held: sum(held.filter((h) => h.fund === f).map((h) => h.amount)),
          available: (BigInt(received) - BigInt(paidOut)).toString(),
        },
      ];
    }),
  ) as Summary["giftsByFund"];
  return {
    giftsByFund,
    payouts: { paidCount: s.payouts.length, paidAmount: sum(s.payouts.map((p) => p.amount)) },
    holds: { heldCount: held.length, heldAmount: sum(held.map((h) => h.amount)) },
    receiptNote: RECEIPT_NOTE,
  };
}

export function fixtureCsv(s: FixtureState): string {
  const lines = [`# ${RECEIPT_NOTE}`, "type,id,party,fund,amount,status"];
  for (const g of s.gifts) lines.push(`gift,${g.id},${g.donor},${g.fund},${g.amountOut},${g.status}`);
  for (const p of s.payouts) lines.push(`payout,${p.bill_id},${p.vendor},${p.fund},${p.amount},${p.status}`);
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
        // Same re-check (and message) as the contract's approve_hold.
        const avail = available(state, hold.fund);
        if (BigInt(hold.amount) > avail) {
          return json(422, {
            error: `contract rejected: insufficient fund balance: ${hold.fund} has ${avail} available, bill needs ${hold.amount}`,
          });
        }
        hold.status = "approved";
        state.payouts.unshift({ bill_id: hold.bill_id, vendor: hold.vendor, amount: hold.amount, memo: hold.memo, fund: hold.fund, status: "paid" });
      } else {
        hold.status = "rejected";
      }
      return json(200, hold);
    }
    return json(404, { error: `mock: no route ${method} ${p}` });
  };
  return Object.assign(fn, { state });
}
