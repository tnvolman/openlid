import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import {
  ContractRejectedError,
  type CreditTreasuryArgs,
  type NearContractClient,
  type RequestPayoutArgs,
  type TestnetSettlement,
} from '../src/near.js';
import { HttpOneClickClient } from '../src/oneclick.js';
import { JsonStore } from '../src/store.js';
import { FUNDS, isFund, type Fund, type HoldStatus, type HoldView, type OneClickStatus, type PayoutView } from '../src/types.js';

export const TEST_API_KEY = 'test-1click-api-key-not-real';

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

/**
 * Mock of the 1Click HTTP API, plugged in as `fetch` for the real HttpOneClickClient.
 * Like the official dry-run shape, a quote has no depositAddress by default. Queuing an address makes the
 * next response a non-dry-shaped fixture so matching against real addresses can still be tested.
 * Statuses are keyed by deposit address.
 */
export class MockOneClick {
  calls: RecordedCall[] = [];
  depositAddresses: string[] = [];
  depositMemos: Array<string | undefined> = [];
  statuses = new Map<string, { status: OneClickStatus; amountOut?: string }>();
  quoteAmountOut = '9950000';

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method: init?.method ?? 'GET', url, headers, body });

    if (url.pathname === '/v0/quote' && init?.method === 'POST') {
      const depositAddress = this.depositAddresses.shift();
      const depositMemo = this.depositMemos.shift();
      return Response.json({
        correlationId: `corr-${this.calls.length}`,
        signature: 'ed25519:mock-quote-signature',
        timestamp: new Date().toISOString(),
        quoteRequest: body,
        quote: {
          ...(depositAddress ? { depositAddress } : {}),
          ...(depositMemo ? { depositMemo } : {}),
          amountIn: body.amount,
          amountOut: this.quoteAmountOut,
          minAmountOut: '9900000',
          deadline: body.deadline,
        },
      });
    }
    if (url.pathname === '/v0/status') {
      const addr = url.searchParams.get('depositAddress') ?? '';
      const st = this.statuses.get(addr);
      if (!st) return Response.json({ message: 'deposit address not found' }, { status: 404 });
      return Response.json({
        correlationId: 'corr-status',
        status: st.status,
        updatedAt: new Date().toISOString(),
        quoteResponse: { quote: { depositAddress: addr } },
        swapDetails: st.amountOut ? { amountOut: st.amountOut } : {},
      });
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  };
}

/**
 * In-memory stand-in for the treasury contract, following INTERFACES.md policy:
 * allowlisted + <= per-bill limit + within cap => paid; allowlisted + over limit + within cap => held; else panic.
 * Like the contract, every bill names a fund and (paid or held) must fit that fund's
 * available = received - paid. `creditFund` is the owner-only `credit_fund` ledger update.
 */
export class FakeTreasury implements NearContractClient {
  allowlist = new Set<string>();
  perBillLimit = 100_000_000n; // 100 USDC
  monthlyCap = 1_000_000_000n; // 1000 USDC
  spent = 0n;
  payouts = new Map<string, PayoutView>();
  holds = new Map<string, HoldView>();
  requests: RequestPayoutArgs[] = [];
  ledger = new Map<Fund, { received: bigint; paid: bigint }>(FUNDS.map((f) => [f, { received: 0n, paid: 0n }]));
  creditedGifts = new Set<string>();
  /** When set, the next ft_transfer "fails" and is rolled back, like on_payout_transfer. */
  failNextTransfer = false;

  private panic(msg: string): never {
    throw new ContractRejectedError(msg);
  }

  private assertFund(fund: unknown): asserts fund is Fund {
    if (!isFund(fund)) this.panic('fund must be one of general, missions, building');
  }

  available(fund: Fund): bigint {
    const l = this.ledger.get(fund)!;
    return l.received > l.paid ? l.received - l.paid : 0n;
  }

  private assertCovers(fund: Fund, amount: bigint) {
    const available = this.available(fund);
    if (amount > available) this.panic(`insufficient fund balance: ${fund} has ${available} available, bill needs ${amount}`);
  }

  /** credit_fund(fund, amount, gift_id). */
  creditFund(fund: string, amount: string, giftId: string) {
    this.assertFund(fund);
    if (BigInt(amount) <= 0n) this.panic('amount must be > 0');
    if (!giftId) this.panic('gift_id must be non-empty');
    if (this.creditedGifts.has(giftId)) this.panic('duplicate gift_id: gift already credited');
    this.creditedGifts.add(giftId);
    this.ledger.get(fund)!.received += BigInt(amount);
  }

  /** Records the payout and fund usage; on a failed transfer rolls both back and returns false. */
  private pay(view: PayoutView): boolean {
    const amount = BigInt(view.amount);
    this.spent += amount;
    this.ledger.get(view.fund)!.paid += amount;
    this.payouts.set(view.bill_id, view);
    if (!this.failNextTransfer) return true;
    this.failNextTransfer = false;
    this.spent -= amount;
    this.ledger.get(view.fund)!.paid -= amount;
    this.payouts.delete(view.bill_id);
    return false;
  }

  async requestPayout(args: RequestPayoutArgs) {
    this.requests.push(args);
    const amount = BigInt(args.amount);
    this.assertFund(args.fund);
    if (!args.billId) this.panic('bill_id must be non-empty');
    if (amount <= 0n) this.panic('amount must be > 0');
    if (this.payouts.has(args.billId) || this.holds.has(args.billId)) this.panic('duplicate bill_id');
    if (!this.allowlist.has(args.vendor)) this.panic('vendor is not on the allowlist');
    if (this.spent + amount > this.monthlyCap) this.panic('monthly cap exceeded');
    this.assertCovers(args.fund, amount);
    const view = { bill_id: args.billId, vendor: args.vendor, amount: args.amount, memo: args.memo, fund: args.fund };
    if (amount <= this.perBillLimit) {
      if (!this.pay({ ...view, status: 'paid' })) {
        this.panic(`ft_transfer failed and the payout was rolled back for ${args.billId} (treasury may lack token balance)`);
      }
      return { status: 'paid' as const };
    }
    this.holds.set(args.billId, { ...view, status: 'held' });
    return { status: 'held' as const };
  }
  async getPayout(billId: string) {
    return this.payouts.get(billId) ?? null;
  }
  async getHold(billId: string) {
    return this.holds.get(billId) ?? null;
  }
  async listHolds(status?: HoldStatus) {
    return [...this.holds.values()].filter((h) => !status || h.status === status);
  }
  async approveHold(billId: string) {
    const h = this.holds.get(billId);
    if (!h || h.status !== 'held') this.panic('hold is not held');
    if (!this.allowlist.has(h.vendor)) this.panic('vendor is not active on the allowlist');
    if (this.spent + BigInt(h.amount) > this.monthlyCap) this.panic('monthly cap exceeded');
    this.assertCovers(h.fund, BigInt(h.amount));
    h.status = 'approved';
    // The on-chain call succeeds even when the transfer callback rolls back; the hold is then `held` again.
    if (!this.pay({ bill_id: billId, vendor: h.vendor, amount: h.amount, memo: h.memo, fund: h.fund, status: 'paid' })) {
      h.status = 'held';
    }
  }
  async rejectHold(billId: string) {
    const h = this.holds.get(billId);
    if (!h || h.status !== 'held') this.panic('hold is not held');
    h.status = 'rejected';
  }
}

/**
 * Records test-FT credits instead of minting on testnet, and (like NearTestFtSettlement) then credits
 * the treasury's fund ledger. Set `fail` to fail the mint, `failCredit` to fail only credit_fund.
 */
export class FakeSettlement implements TestnetSettlement {
  credits: CreditTreasuryArgs[] = [];
  minted: CreditTreasuryArgs[] = [];
  fail?: Error;
  failCredit?: Error;
  constructor(private readonly treasury?: FakeTreasury) {}
  async creditTreasury(args: CreditTreasuryArgs) {
    if (this.fail) throw this.fail;
    this.minted.push(args);
    if (this.failCredit) throw this.failCredit;
    this.treasury?.creditFund(args.fund, args.amount, args.giftId);
    this.credits.push(args);
    return { txHash: `fake-tx-${this.credits.length}`, creditTxHash: `fake-credit-tx-${this.credits.length}` };
  }
}

export async function makeHarness(opts: { network?: string } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openlid-api-test-'));
  const store = new JsonStore(dataDir);
  await store.init();
  const oneClickMock = new MockOneClick();
  const oneClick = new HttpOneClickClient({
    baseUrl: 'https://1click.mock.invalid',
    apiKey: TEST_API_KEY,
    fetch: oneClickMock.fetch,
  });
  const treasury = new FakeTreasury();
  const settlement = new FakeSettlement(treasury);
  const app = createApp({
    store,
    oneClick,
    near: treasury,
    settlement,
    network: opts.network ?? 'testnet',
    contractId: 'treasury.openlid.testnet',
    usdcTokenId: 'usdc.fakes.testnet',
  });

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  /** Quote a sim: gift to `fund` and settle it, crediting the fake fund ledger. Returns the gift view. */
  const fundGift = async (fund: Fund, amountOut: string) => {
    const saved = oneClickMock.quoteAmountOut;
    oneClickMock.quoteAmountOut = amountOut;
    const q = await request('POST', '/api/gifts/quote', giftBody({ fund }));
    oneClickMock.quoteAmountOut = saved;
    const s = await request('POST', `/api/gifts/${q.json.id}/simulate-settlement`);
    if (s.status !== 200) throw new Error(`fundGift: ${s.status} ${s.text}`);
    return s.json;
  };

  return {
    app,
    store,
    fundGift,
    dataDir,
    oneClickMock,
    treasury,
    settlement,
    request,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

export const giftBody = (overrides: Record<string, unknown> = {}) => ({
  donor: 'donor-demo-1',
  fund: 'general',
  originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  amount: '10000000',
  refundTo: '0x1111111111111111111111111111111111111111',
  refundType: 'ORIGIN_CHAIN',
  slippageTolerance: 100,
  ...overrides,
});
