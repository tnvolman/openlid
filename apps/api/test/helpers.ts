import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { ContractRejectedError, type NearContractClient, type RequestPayoutArgs } from '../src/near.js';
import { HttpOneClickClient } from '../src/oneclick.js';
import { JsonStore } from '../src/store.js';
import type { HoldStatus, HoldView, OneClickStatus, PayoutView } from '../src/types.js';

export const TEST_API_KEY = 'test-1click-api-key-not-real';

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

/**
 * Mock of the 1Click HTTP API, plugged in as `fetch` for the real HttpOneClickClient.
 * Each quote pops the next queued deposit address; statuses are keyed by deposit address.
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
          ...(body.dry ? {} : { depositAddress }),
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
 */
export class FakeTreasury implements NearContractClient {
  allowlist = new Set<string>();
  perBillLimit = 100_000_000n; // 100 USDC
  monthlyCap = 1_000_000_000n; // 1000 USDC
  spent = 0n;
  payouts = new Map<string, PayoutView>();
  holds = new Map<string, HoldView>();
  requests: RequestPayoutArgs[] = [];

  private panic(msg: string): never {
    throw new ContractRejectedError(msg);
  }

  async requestPayout(args: RequestPayoutArgs) {
    this.requests.push(args);
    const amount = BigInt(args.amount);
    if (!args.billId) this.panic('bill_id must be non-empty');
    if (amount <= 0n) this.panic('amount must be > 0');
    if (this.payouts.has(args.billId) || this.holds.has(args.billId)) this.panic('duplicate bill_id');
    if (!this.allowlist.has(args.vendor)) this.panic('vendor is not on the allowlist');
    if (this.spent + amount > this.monthlyCap) this.panic('monthly cap exceeded');
    const view = { bill_id: args.billId, vendor: args.vendor, amount: args.amount, memo: args.memo };
    if (amount <= this.perBillLimit) {
      this.spent += amount;
      this.payouts.set(args.billId, { ...view, status: 'paid' });
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
    if (this.spent + BigInt(h.amount) > this.monthlyCap) this.panic('monthly cap exceeded');
    this.spent += BigInt(h.amount);
    h.status = 'approved';
    this.payouts.set(billId, { bill_id: billId, vendor: h.vendor, amount: h.amount, memo: h.memo, status: 'paid' });
  }
  async rejectHold(billId: string) {
    const h = this.holds.get(billId);
    if (!h || h.status !== 'held') this.panic('hold is not held');
    h.status = 'rejected';
  }
}

export async function makeHarness() {
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
  const app = createApp({
    store,
    oneClick,
    near: treasury,
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

  return {
    app,
    store,
    dataDir,
    oneClickMock,
    treasury,
    request,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

export const giftBody = (overrides: Record<string, unknown> = {}) => ({
  donor: 'Donor A',
  fund: 'general',
  originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  amount: '10000000',
  refundTo: '0x1111111111111111111111111111111111111111',
  refundType: 'ORIGIN_CHAIN',
  slippageTolerance: 100,
  ...overrides,
});
