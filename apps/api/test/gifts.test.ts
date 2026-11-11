import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { UnconfiguredSettlement } from '../src/near.js';
import { createDryRunStubFetch, DRY_RUN_STUB_BASE_URL, HttpOneClickClient, type OneClickQuoteRequest } from '../src/oneclick.js';
import { JsonStore } from '../src/store.js';
import { giftBody, makeHarness, TEST_API_KEY } from './helpers.js';

const ADDR_A = '0xAAAA00000000000000000000000000000000aaaa';
const ADDR_B = '0xBBBB00000000000000000000000000000000bbbb';

describe('gifts', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  it('1. quote-to-gift (non-dry fixture): a mocked quote with a depositAddress creates a gift keyed by it; a second quote is a second gift', async () => {
    h.oneClickMock.depositAddresses.push(ADDR_A, ADDR_B);

    const r1 = await h.request('POST', '/api/gifts/quote', giftBody());
    assert.equal(r1.status, 201, r1.text);
    assert.equal(r1.json.depositAddress, ADDR_A);
    assert.equal(r1.json.status, 'pending_deposit');
    assert.equal(r1.json.receiptNote, 'demo, not a tax document');
    assert.equal(r1.json.quoteMode, 'dry_run');
    assert.equal(r1.json.depositAddressSimulated, false);
    assert.equal(r1.json.fund, 'general');
    assert.equal(r1.json.donor, 'Donor A');
    assert.equal(r1.json.amountIn, '10000000');
    assert.equal(r1.json.amountOut, '9950000');
    assert.equal(r1.json.depositMemo, null);
    assert.ok(r1.json.correlationId);
    assert.ok(r1.json.id);
    // No donor refund address or quote signature leaks back out.
    assert.equal(r1.json.refundTo, undefined);
    assert.equal(r1.json.quoteSignature, undefined);

    // Real HTTP client was called with the documented request shape and auth header.
    const call = h.oneClickMock.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.url.pathname, '/v0/quote');
    assert.equal(call.headers.get('x-api-key'), TEST_API_KEY);
    assert.deepEqual(
      { ...call.body, deadline: typeof call.body.deadline },
      {
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: giftBody().originAsset,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: 'nep141:usdc.fakes.testnet',
        amount: '10000000',
        refundTo: giftBody().refundTo,
        refundType: 'ORIGIN_CHAIN',
        recipient: 'treasury.openlid.testnet',
        recipientType: 'DESTINATION_CHAIN',
        deadline: 'string',
      },
    );

    const r2 = await h.request('POST', '/api/gifts/quote', giftBody({ donor: 'Donor B', fund: 'missions' }));
    assert.equal(r2.status, 201, r2.text);
    assert.equal(r2.json.depositAddress, ADDR_B);
    assert.notEqual(r2.json.id, r1.json.id);
    assert.equal(h.oneClickMock.calls.filter((c) => c.url.pathname === '/v0/quote').length, 2, 'one quote per gift');

    const list = await h.request('GET', '/api/gifts');
    assert.equal(list.json.gifts.length, 2);
    assert.deepEqual(new Set(list.json.gifts.map((g: any) => g.depositAddress)), new Set([ADDR_A, ADDR_B]));

    const one = await h.request('GET', `/api/gifts/${r1.json.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.depositAddress, ADDR_A);

    const missions = await h.request('GET', '/api/gifts?fund=missions');
    assert.deepEqual(missions.json.gifts.map((g: any) => g.id), [r2.json.id]);

    // Persisted to OPENLID_DATA_DIR and reloadable.
    const onDisk = JSON.parse(await readFile(join(h.dataDir, 'gifts.json'), 'utf8'));
    assert.equal(onDisk.length, 2);
    const reloaded = new JsonStore(h.dataDir);
    await reloaded.init();
    assert.equal(reloaded.findGiftByDepositAddress(ADDR_A)?.id, r1.json.id);
  });

  it('2. two gifts never share a deposit address: a reused address from 1Click is rejected', async () => {
    h.oneClickMock.depositAddresses.push(ADDR_A, ADDR_A, ADDR_A.toLowerCase());

    const r1 = await h.request('POST', '/api/gifts/quote', giftBody());
    assert.equal(r1.status, 201);

    const r2 = await h.request('POST', '/api/gifts/quote', giftBody({ donor: 'Donor B' }));
    assert.equal(r2.status, 409, r2.text);
    assert.match(r2.json.error, /deposit address/);

    // Same EVM address in a different case is still reuse.
    const r3 = await h.request('POST', '/api/gifts/quote', giftBody({ donor: 'Donor C' }));
    assert.equal(r3.status, 409, r3.text);

    const list = await h.request('GET', '/api/gifts');
    assert.equal(list.json.gifts.length, 1);
    assert.equal(list.json.gifts[0].donor, 'Donor A');
  });

  it('3. matching is by deposit address only: same amountIn, independent statuses', async () => {
    h.oneClickMock.depositAddresses.push(ADDR_A, ADDR_B);
    const a = (await h.request('POST', '/api/gifts/quote', giftBody({ donor: 'A' }))).json;
    const b = (await h.request('POST', '/api/gifts/quote', giftBody({ donor: 'B' }))).json;
    assert.equal(a.amountIn, b.amountIn, 'precondition: identical amounts');

    h.oneClickMock.statuses.set(ADDR_A, { status: 'SUCCESS', amountOut: '9960000' });
    h.oneClickMock.statuses.set(ADDR_B, { status: 'PENDING_DEPOSIT' });

    const syncA = await h.request('POST', `/api/gifts/${a.id}/sync`);
    assert.equal(syncA.status, 200, syncA.text);
    assert.equal(syncA.json.status, 'settled');
    assert.equal(syncA.json.settledAmount, '9960000');

    // The status request used only A's deposit address.
    const statusCalls = h.oneClickMock.calls.filter((c) => c.url.pathname === '/v0/status');
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0]!.url.searchParams.get('depositAddress'), ADDR_A);
    assert.equal(statusCalls[0]!.headers.get('x-api-key'), TEST_API_KEY);

    // B is untouched.
    const bAfter = (await h.request('GET', `/api/gifts/${b.id}`)).json;
    assert.equal(bAfter.status, 'pending_deposit');
    assert.equal(bAfter.oneClickStatus, null);
    assert.equal(bAfter.settledAmount, null);

    // B syncs independently.
    h.oneClickMock.statuses.set(ADDR_B, { status: 'PROCESSING' });
    const syncB = await h.request('POST', `/api/gifts/${b.id}/sync`);
    assert.equal(syncB.json.status, 'processing');
    assert.equal((await h.request('GET', `/api/gifts/${a.id}`)).json.status, 'settled');

    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.giftsByFund.general, { settledAmount: '9960000', count: 1 });
  });

  it('4. sync maps SUCCESS/REFUNDED/FAILED to settled/refunded/failed and GET /api/gifts shows them', async () => {
    const addrs = ['addr-success', 'addr-refunded', 'addr-failed', 'addr-known', 'addr-incomplete', 'addr-pending'];
    h.oneClickMock.depositAddresses.push(...addrs);
    const ids: Record<string, string> = {};
    for (const addr of addrs) {
      const r = await h.request('POST', '/api/gifts/quote', giftBody({ donor: addr }));
      assert.equal(r.status, 201, r.text);
      ids[addr] = r.json.id;
    }
    h.oneClickMock.statuses.set('addr-success', { status: 'SUCCESS' });
    h.oneClickMock.statuses.set('addr-refunded', { status: 'REFUNDED' });
    h.oneClickMock.statuses.set('addr-failed', { status: 'FAILED' });
    h.oneClickMock.statuses.set('addr-known', { status: 'KNOWN_DEPOSIT_TX' });
    h.oneClickMock.statuses.set('addr-incomplete', { status: 'INCOMPLETE_DEPOSIT' });
    h.oneClickMock.statuses.set('addr-pending', { status: 'PENDING_DEPOSIT' });

    for (const addr of addrs) {
      const r = await h.request('POST', `/api/gifts/${ids[addr]}/sync`);
      assert.equal(r.status, 200, r.text);
    }

    const byAddr = Object.fromEntries(
      (await h.request('GET', '/api/gifts')).json.gifts.map((g: any) => [g.depositAddress, g]),
    );
    assert.equal(byAddr['addr-success'].status, 'settled');
    assert.equal(byAddr['addr-refunded'].status, 'refunded');
    assert.equal(byAddr['addr-failed'].status, 'failed');
    assert.equal(byAddr['addr-known'].status, 'processing');
    assert.equal(byAddr['addr-incomplete'].status, 'processing');
    assert.equal(byAddr['addr-pending'].status, 'pending_deposit');
    assert.equal(byAddr['addr-refunded'].oneClickStatus, 'REFUNDED');
    // Settled gift falls back to the quoted amountOut when swapDetails has none.
    assert.equal(byAddr['addr-success'].settledAmount, '9950000');
    assert.equal(byAddr['addr-failed'].settledAmount, null);

    // Only the settled gift counts toward the fund summary.
    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.giftsByFund.general, { settledAmount: '9950000', count: 1 });
  });

  it('sync sends depositMemo when the quote returned one', async () => {
    h.oneClickMock.depositAddresses.push('stellar-deposit-addr');
    h.oneClickMock.depositMemos.push('memo-123');
    const g = (await h.request('POST', '/api/gifts/quote', giftBody())).json;
    assert.equal(g.depositMemo, 'memo-123');
    h.oneClickMock.statuses.set('stellar-deposit-addr', { status: 'FAILED' });
    const r = await h.request('POST', `/api/gifts/${g.id}/sync`);
    assert.equal(r.json.status, 'failed');
    const call = h.oneClickMock.calls.find((c) => c.url.pathname === '/v0/status')!;
    assert.equal(call.url.searchParams.get('depositMemo'), 'memo-123');
  });

  it('a 1Click error on sync leaves the gift unchanged and returns 502', async () => {
    h.oneClickMock.depositAddresses.push(ADDR_A);
    const g = (await h.request('POST', '/api/gifts/quote', giftBody())).json;
    const r = await h.request('POST', `/api/gifts/${g.id}/sync`); // no status registered -> upstream 404
    assert.equal(r.status, 502);
    assert.ok(r.json.error);
    assert.equal((await h.request('GET', `/api/gifts/${g.id}`)).json.status, 'pending_deposit');
  });

  it('dry quote without depositAddress: each gift gets a unique sim:<id> address, matched by address only', async () => {
    // Official dry-run shape: no depositAddress in either response.
    const a = await h.request('POST', '/api/gifts/quote', giftBody({ donor: 'Same Amount A' }));
    const b = await h.request('POST', '/api/gifts/quote', giftBody({ donor: 'Same Amount B' }));
    assert.equal(a.status, 201, a.text);
    assert.equal(b.status, 201, b.text);
    assert.equal(a.json.depositAddress, `sim:${a.json.id}`);
    assert.equal(b.json.depositAddress, `sim:${b.json.id}`);
    assert.notEqual(a.json.depositAddress, b.json.depositAddress);
    assert.equal(a.json.amountIn, b.json.amountIn, 'precondition: identical amounts');
    assert.equal(a.json.depositAddressSimulated, true);
    assert.equal(a.json.quoteMode, 'dry_run');
    assert.equal(a.json.receiptNote, 'demo, not a tax document');
    assert.ok(h.oneClickMock.calls.every((c) => c.url.pathname !== '/v0/quote' || c.body.dry === true));
    assert.equal(h.store.findGiftByDepositAddress(`sim:${b.json.id}`)?.id, b.json.id);

    // Sync on a simulated address never calls 1Click status and leaves the gift as-is.
    const sync = await h.request('POST', `/api/gifts/${a.json.id}/sync`);
    assert.equal(sync.status, 200);
    assert.equal(sync.json.status, 'pending_deposit');
    assert.equal(h.oneClickMock.calls.filter((c) => c.url.pathname === '/v0/status').length, 0);

    // Settling A does not touch B even though the amounts are identical.
    const settled = await h.request('POST', `/api/gifts/${a.json.id}/simulate-settlement`);
    assert.equal(settled.json.status, 'settled');
    assert.equal((await h.request('GET', `/api/gifts/${b.json.id}`)).json.status, 'pending_deposit');
  });

  it('rejects a 1Click quote that returns a reserved sim: address', async () => {
    h.oneClickMock.depositAddresses.push('sim:spoofed');
    const r = await h.request('POST', '/api/gifts/quote', giftBody());
    assert.equal(r.status, 502);
    assert.equal((await h.request('GET', '/api/gifts')).json.gifts.length, 0);
  });

  it('local dry-run stub (no ONECLICK_API_KEY): real client, dry shape, no network, refuses dry:false', async () => {
    const client = new HttpOneClickClient({ baseUrl: DRY_RUN_STUB_BASE_URL, fetch: createDryRunStubFetch() });
    const app = createApp({
      store: h.store,
      oneClick: client,
      near: h.treasury,
      settlement: h.settlement,
      network: 'testnet',
      contractId: 'treasury.openlid.testnet',
      usdcTokenId: 'usdc.fakes.testnet',
    });
    const res = await app.request('/api/gifts/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(giftBody({ amount: '25000000' })),
    });
    assert.equal(res.status, 201);
    const gift = (await res.json()) as any;
    assert.match(gift.depositAddress, /^sim:/);
    assert.equal(gift.quoteMode, 'dry_run');
    assert.equal(gift.amountOut, '25000000');
    assert.equal(gift.minAmountOut, '24750000');
    assert.equal(gift.quoteDeadline, null);
    assert.equal(h.oneClickMock.calls.length, 0, 'the mocked live API was never called');

    // The client itself refuses a non-dry request, before any HTTP call.
    await assert.rejects(
      client.quote({ ...({} as OneClickQuoteRequest), dry: false as unknown as true }),
      /dry-run/,
    );
  });

  it('dry quotes via the client have no depositAddress', async () => {
    const client = new HttpOneClickClient({ baseUrl: 'https://1click.mock.invalid', fetch: h.oneClickMock.fetch });
    const q = await client.quote({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'x',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:usdc.fakes.testnet',
      amount: '1',
      refundTo: 'r',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'treasury.openlid.testnet',
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date().toISOString(),
    });
    assert.equal(q.quote.depositAddress, undefined);
    // No API key configured -> no X-API-Key header sent.
    assert.equal(h.oneClickMock.calls.at(-1)!.headers.get('x-api-key'), null);
  });

  it('validates the quote request', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ donor: '' }, /donor/],
      [{ fund: 'roof' }, /fund/],
      [{ originAsset: undefined }, /originAsset/],
      [{ amount: '0' }, /amount/],
      [{ amount: '1.5' }, /amount/],
      [{ amount: 100 }, /amount/],
      [{ refundTo: '' }, /refundTo/],
      [{ refundType: 'INTENTS' }, /refundType/],
      [{ slippageTolerance: -1 }, /slippageTolerance/],
    ];
    for (const [patch, re] of cases) {
      const r = await h.request('POST', '/api/gifts/quote', giftBody(patch));
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.match(r.json.error, re);
    }
    assert.equal(h.oneClickMock.calls.length, 0, 'invalid requests never reach 1Click');
    assert.equal((await h.request('GET', '/api/gifts/nope')).status, 404);
    assert.equal((await h.request('POST', '/api/gifts/nope/sync')).status, 404);
  });

  it('returns 503 for quotes when treasury contract / USDC token are not configured', async () => {
    const app = createApp({
      store: h.store,
      oneClick: new HttpOneClickClient({ baseUrl: 'https://1click.mock.invalid', fetch: h.oneClickMock.fetch }),
      near: h.treasury,
      settlement: h.settlement,
      network: 'testnet',
    });
    const res = await app.request('/api/gifts/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(giftBody()),
    });
    assert.equal(res.status, 503);
    assert.equal(h.oneClickMock.calls.length, 0);
  });

  it('CORS allows the local UI origins only', async () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
      const r = await h.request('GET', '/api/gifts', undefined, { origin });
      assert.equal(r.headers.get('access-control-allow-origin'), origin);
    }
    const bad = await h.request('GET', '/api/gifts', undefined, { origin: 'https://evil.example' });
    assert.notEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.example');
  });
});

describe('simulate-settlement (testnet only)', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  afterEach(() => h.cleanup());

  it('happy path: credits the test FT to the treasury and marks the gift settled', async () => {
    h = await makeHarness();
    const g = (await h.request('POST', '/api/gifts/quote', giftBody({ fund: 'building' }))).json;
    assert.match(g.depositAddress, /^sim:/);

    const r = await h.request('POST', `/api/gifts/${g.id}/simulate-settlement`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'settled');
    assert.equal(r.json.settledAmount, '9950000');
    assert.equal(r.json.settlementTxHash, 'fake-tx-1');
    assert.equal(r.json.quoteMode, 'dry_run');
    assert.equal(r.json.receiptNote, 'demo, not a tax document');
    assert.deepEqual(h.settlement.credits, [{ giftId: g.id, amount: '9950000' }]);

    assert.equal((await h.request('GET', '/api/gifts')).json.gifts[0].status, 'settled');
    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.giftsByFund.building, { settledAmount: '9950000', count: 1 });

    // Settling twice is refused and does not mint again.
    const again = await h.request('POST', `/api/gifts/${g.id}/simulate-settlement`);
    assert.equal(again.status, 409);
    assert.equal(h.settlement.credits.length, 1);
    // No 1Click deposit or status call was made.
    assert.equal(h.oneClickMock.calls.filter((c) => c.url.pathname !== '/v0/quote').length, 0);
  });

  it('is refused on mainnet: 403, nothing minted, status unchanged', async () => {
    h = await makeHarness({ network: 'mainnet' });
    const g = (await h.request('POST', '/api/gifts/quote', giftBody())).json;
    const r = await h.request('POST', `/api/gifts/${g.id}/simulate-settlement`);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /mainnet/);
    assert.equal(h.settlement.credits.length, 0);
    assert.equal((await h.request('GET', `/api/gifts/${g.id}`)).json.status, 'pending_deposit');
  });

  it('is refused on any network other than testnet', async () => {
    h = await makeHarness({ network: 'localnet' });
    const g = (await h.request('POST', '/api/gifts/quote', giftBody())).json;
    const r = await h.request('POST', `/api/gifts/${g.id}/simulate-settlement`);
    assert.equal(r.status, 403);
    assert.equal(h.settlement.credits.length, 0);
  });

  it('refuses gifts with a real 1Click address, and leaves status unchanged when the mint fails', async () => {
    h = await makeHarness();
    h.oneClickMock.depositAddresses.push('0xREAL000000000000000000000000000000000001');
    const real = (await h.request('POST', '/api/gifts/quote', giftBody())).json;
    assert.equal((await h.request('POST', `/api/gifts/${real.id}/simulate-settlement`)).status, 409);

    const sim = (await h.request('POST', '/api/gifts/quote', giftBody())).json;
    h.settlement.fail = new Error('rpc down');
    const r = await h.request('POST', `/api/gifts/${sim.id}/simulate-settlement`);
    assert.equal(r.status, 500);
    assert.equal((await h.request('GET', `/api/gifts/${sim.id}`)).json.status, 'pending_deposit');
    assert.equal((await h.request('POST', '/api/gifts/nope/simulate-settlement')).status, 404);
  });

  it('returns 503 when settlement is not configured', async () => {
    h = await makeHarness();
    const app = createApp({
      store: h.store,
      oneClick: new HttpOneClickClient({ baseUrl: DRY_RUN_STUB_BASE_URL, fetch: createDryRunStubFetch() }),
      near: h.treasury,
      settlement: new UnconfiguredSettlement('not configured'),
      network: 'testnet',
      contractId: 'treasury.openlid.testnet',
      usdcTokenId: 'usdc.fakes.testnet',
    });
    const q = await app.request('/api/gifts/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(giftBody()),
    });
    const g = (await q.json()) as any;
    const r = await app.request(`/api/gifts/${g.id}/simulate-settlement`, { method: 'POST' });
    assert.equal(r.status, 503);
  });
});

describe('config', () => {
  it('refuses mainnet and non-dry 1Click at startup', () => {
    assert.throws(() => loadConfig({ OPENLID_NETWORK: 'mainnet' }), /mainnet/);
    assert.throws(() => loadConfig({ OPENLID_NETWORK: 'MAINNET' }), /mainnet/);
    assert.throws(() => loadConfig({ ONECLICK_DRY_RUN: 'false' }), /dry-run/);
    const c = loadConfig({ ONECLICK_DRY_RUN: 'true', OPENLID_DEMO_KEYS_DIR: '/tmp/x/.demo-keys' });
    assert.equal(c.network, 'testnet');
    assert.equal(c.demoKeysDir, '/tmp/x/.demo-keys');
    assert.equal(c.oneClickApiKey, undefined);
  });
});
