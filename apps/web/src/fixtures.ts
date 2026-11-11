// Static demo fixture for ?mock=1 and tests. Fake account names and fake
// deposit addresses only: no keys, no real wallets, no mainnet anything.
import type { FetchLike } from "./api.ts";
import { FUNDS, RECEIPT_NOTE } from "./types.ts";
import type { Gift, HoldView, PayoutView, Summary } from "./types.ts";

const gift = (id: string, donor: string, fund: Gift["fund"], amountOut: string, status: Gift["status"]): Gift => ({
  id,
  donor,
  fund,
  depositAddress: `0xDEMO${id.replace(/\W/g, "").toUpperCase().padEnd(36, "0")}`,
  depositMemo: null,
  correlationId: `demo-corr-${id}`,
  amountIn: amountOut,
  amountOut,
  originAsset: "nep141:demo-usdc.base.omft.near",
  status,
  receiptNote: RECEIPT_NOTE,
});

export function fixtureState() {
  return {
    gifts: [
      gift("g6", "Donor F", "building", "75000000", "failed"),
      gift("g5", "Donor E", "missions", "40000000", "refunded"),
      gift("g4", "Donor D", "general", "10000000", "processing"),
      gift("g3", "Donor C", "building", "250000000", "settled"),
      gift("g2", "Donor B", "missions", "60000000", "settled"),
      gift("g1", "Donor A", "general", "100000000", "settled"),
    ] as Gift[],
    payouts: [
      { bill_id: "bill-electric-001", vendor: "power-co.demo.testnet", amount: "180000000", memo: "Electric, October", status: "paid" },
    ] as PayoutView[],
    holds: [
      { bill_id: "bill-roof-002", vendor: "roofer.demo.testnet", amount: "4200000000", memo: "Roof repair deposit", status: "held" },
    ] as HoldView[],
  };
}

export type FixtureState = ReturnType<typeof fixtureState>;

const sum = (xs: string[]) => xs.reduce((a, b) => a + BigInt(b), 0n).toString();

export function summarize(s: FixtureState): Summary {
  const giftsByFund = Object.fromEntries(
    FUNDS.map((f) => {
      const inFund = s.gifts.filter((g) => g.fund === f);
      const settled = inFund.filter((g) => g.status === "settled");
      return [f, { settledAmount: sum(settled.map((g) => g.amountOut)), count: inFund.length }];
    }),
  ) as Summary["giftsByFund"];
  const held = s.holds.filter((h) => h.status === "held");
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
  for (const p of s.payouts) lines.push(`payout,${p.bill_id},${p.vendor},,${p.amount},${p.status}`);
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
        hold.status = "approved";
        state.payouts.unshift({ bill_id: hold.bill_id, vendor: hold.vendor, amount: hold.amount, memo: hold.memo, status: "paid" });
      } else {
        hold.status = "rejected";
      }
      return json(200, hold);
    }
    return json(404, { error: `mock: no route ${method} ${p}` });
  };
  return Object.assign(fn, { state });
}
