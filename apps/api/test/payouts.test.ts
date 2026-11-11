import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { classifyNearError, ContractRejectedError, loadKeyFromFile, resolveKeyFile, UnconfiguredNearClient } from '../src/near.js';
import { HttpOneClickClient } from '../src/oneclick.js';
import { giftBody, makeHarness } from './helpers.js';

const VENDOR = 'roofer.testnet';

describe('payouts and holds', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
    h.treasury.allowlist.add(VENDOR);
  });
  afterEach(() => h.cleanup());

  it('5. paid for allowlisted in-limit bill, held for over-limit bill, contract rejection is 4xx { error }', async () => {
    await h.fundGift('general', '300000000');
    const paid = await h.request('POST', '/api/payouts/request', {
      vendor: VENDOR,
      amount: '50000000',
      billId: 'bill-001',
      memo: 'gutter repair',
      fund: 'general',
    });
    assert.equal(paid.status, 200, paid.text);
    assert.deepEqual(paid.json, { billId: 'bill-001', status: 'paid', vendor: VENDOR, amount: '50000000', fund: 'general' });
    assert.deepEqual(h.treasury.requests[0], {
      vendor: VENDOR,
      amount: '50000000',
      billId: 'bill-001',
      memo: 'gutter repair',
      fund: 'general',
    });

    const held = await h.request('POST', '/api/payouts/request', {
      vendor: VENDOR,
      amount: '250000000',
      billId: 'bill-002',
      memo: 'new roof (unusual)',
      fund: 'general',
    });
    assert.equal(held.status, 200, held.text);
    assert.deepEqual(held.json, { billId: 'bill-002', status: 'held', vendor: VENDOR, amount: '250000000', fund: 'general' });

    const rejected = await h.request('POST', '/api/payouts/request', {
      vendor: 'stranger.testnet',
      amount: '1000000',
      billId: 'bill-003',
      memo: 'not allowlisted',
      fund: 'general',
    });
    assert.ok(rejected.status >= 400 && rejected.status < 500, `got ${rejected.status}`);
    assert.equal(typeof rejected.json.error, 'string');
    assert.match(rejected.json.error, /allowlist/);
    assert.deepEqual(Object.keys(rejected.json), ['error']);

    const capExceeded = await h.request('POST', '/api/payouts/request', {
      vendor: VENDOR,
      amount: '2000000000',
      billId: 'bill-004',
      memo: 'way over cap',
      fund: 'general',
    });
    assert.ok(capExceeded.status >= 400 && capExceeded.status < 500);
    assert.match(capExceeded.json.error, /cap/);

    const payouts = (await h.request('GET', '/api/payouts')).json.payouts;
    assert.deepEqual(payouts, [
      { bill_id: 'bill-001', vendor: VENDOR, amount: '50000000', memo: 'gutter repair', fund: 'general', status: 'paid' },
    ]);

    const holds = (await h.request('GET', '/api/holds?status=held')).json.holds;
    assert.deepEqual(holds, [
      { bill_id: 'bill-002', vendor: VENDOR, amount: '250000000', memo: 'new roof (unusual)', fund: 'general', status: 'held' },
    ]);

    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.payouts, { paidCount: 1, paidAmount: '50000000' });
    assert.deepEqual(summary.holds, { heldCount: 1, heldAmount: '250000000' });
    assert.deepEqual(summary.giftsByFund.general, {
      count: 1,
      received: '300000000',
      paidOut: '50000000',
      held: '250000000',
      available: '250000000',
    });
    assert.equal(summary.receiptNote, 'demo, not a tax document');
  });

  it('duplicate billId is rejected', async () => {
    await h.fundGift('missions', '10000000');
    const body = { vendor: VENDOR, amount: '1000000', billId: 'dup', memo: '', fund: 'missions' };
    assert.equal((await h.request('POST', '/api/payouts/request', body)).status, 200);
    const again = await h.request('POST', '/api/payouts/request', body);
    assert.equal(again.status, 409);
    assert.ok(again.json.error);
  });

  it('validates payout requests before calling the contract', async () => {
    const bad = [
      { vendor: 'Not A Near Id', amount: '1', billId: 'b', memo: '', fund: 'general' },
      { vendor: VENDOR, amount: '-5', billId: 'b', memo: '', fund: 'general' },
      { vendor: VENDOR, amount: '1', billId: '', memo: '', fund: 'general' },
      { vendor: VENDOR, amount: '1', billId: 'b', memo: 7, fund: 'general' },
    ];
    for (const body of bad) {
      const r = await h.request('POST', '/api/payouts/request', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error);
    }
    // fund is required and must be one of the three funds.
    for (const fund of [undefined, '', 'roof', 'General', 7, null]) {
      const r = await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '1', billId: 'b', memo: '', fund });
      assert.equal(r.status, 400, String(fund));
      assert.deepEqual(r.json, { error: 'fund must be one of general, missions, building' });
    }
    assert.equal(h.treasury.requests.length, 0);
  });

  it('treasurer approve / reject holds', async () => {
    await h.fundGift('building', '300000000');
    for (const billId of ['hold-a', 'hold-b']) {
      const r = await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '150000000', billId, memo: 'big', fund: 'building' });
      assert.equal(r.json.status, 'held');
      assert.equal(r.json.fund, 'building');
    }
    const approve = await h.request('POST', '/api/holds/hold-a/approve');
    assert.equal(approve.status, 200, approve.text);
    assert.equal(approve.json.status, 'approved');
    assert.equal(approve.json.hold.fund, 'building');

    const reject = await h.request('POST', '/api/holds/hold-b/reject');
    assert.equal(reject.status, 200);
    assert.equal(reject.json.status, 'rejected');

    const again = await h.request('POST', '/api/holds/hold-b/approve');
    assert.equal(again.status, 422);
    assert.match(again.json.error, /not held/);

    assert.deepEqual((await h.request('GET', '/api/holds?status=held')).json.holds, []);
    assert.equal((await h.request('GET', '/api/holds')).json.holds.length, 2);
    assert.equal((await h.request('GET', '/api/holds?status=bogus')).status, 400);

    const payouts = (await h.request('GET', '/api/payouts')).json.payouts;
    assert.deepEqual(payouts.map((p: any) => [p.bill_id, p.fund]), [['hold-a', 'building']]);
    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.payouts, { paidCount: 1, paidAmount: '150000000' });
    assert.deepEqual(summary.holds, { heldCount: 0, heldAmount: '0' });
    assert.deepEqual(summary.giftsByFund.building, {
      count: 1,
      received: '300000000',
      paidOut: '150000000',
      held: '0',
      available: '150000000',
    });
  });

  it('export.csv includes gifts, payouts and the demo note; guards against formula injection', async () => {
    h.oneClickMock.depositAddresses.push('addr-csv');
    await h.request('POST', '/api/gifts/quote', giftBody({ donor: '=HYPERLINK("x")' }));
    await h.fundGift('missions', '1000000');
    await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '1000000', billId: 'csv-1', memo: 'a, "b"', fund: 'missions' });

    const r = await h.request('GET', '/api/export.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/csv/);
    const lines = r.text.trim().split('\n');
    assert.equal(lines[0], '# demo, not a tax document');
    assert.match(lines[1]!, /^type,id,/);
    const gift = lines.find((l) => l.startsWith('gift,') && l.includes('addr-csv'))!;
    assert.ok(gift.includes('addr-csv'));
    assert.ok(gift.includes(`"'=HYPERLINK(""x"")"`), gift);
    const payout = lines.find((l) => l.startsWith('payout,'))!;
    assert.ok(payout.includes('csv-1') && payout.includes('"a, ""b"""'), payout);
    const header = lines[1]!.split(',');
    assert.equal(payout.split(',')[header.indexOf('fund')], 'missions', payout);
  });

  it('without NEAR configured: payouts 503, summary still works', async () => {
    const app = createApp({
      store: h.store,
      oneClick: new HttpOneClickClient({ baseUrl: 'https://1click.mock.invalid', fetch: h.oneClickMock.fetch }),
      near: new UnconfiguredNearClient('NEAR is not configured'),
      settlement: h.settlement,
      network: 'testnet',
    });
    const res = await app.request('/api/payouts/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: VENDOR, amount: '1', billId: 'x', memo: '', fund: 'general' }),
    });
    assert.equal(res.status, 503);
    const summary = (await (await app.request('/api/summary')).json()) as any;
    assert.equal(summary.holds.available, false);
    assert.equal(summary.receiptNote, 'demo, not a tax document');
  });
});

describe('per-fund accounting', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
    h.treasury.allowlist.add(VENDOR);
  });
  afterEach(() => h.cleanup());

  const bill = (billId: string, amount: string, fund: string) =>
    h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount, billId, memo: billId, fund });

  it('refuses an auto-pay bill larger than its fund, even when another fund has money', async () => {
    await h.fundGift('missions', '60000000');
    const r = await bill('bldg-1', '50000000', 'building');
    assert.equal(r.status, 422, r.text);
    assert.deepEqual(Object.keys(r.json), ['error']);
    assert.match(r.json.error, /insufficient fund balance: building has 0 available, bill needs 50000000/);

    const over = await bill('miss-1', '60000001', 'missions');
    assert.equal(over.status, 422);
    assert.match(over.json.error, /insufficient fund balance/);
    assert.equal(h.store.getPayout('miss-1'), undefined, 'a refused bill is not recorded');

    const ok = await bill('miss-2', '60000000', 'missions');
    assert.equal(ok.json.status, 'paid');
    assert.equal(h.treasury.available('missions'), 0n);
  });

  it('refuses to create a hold its fund already cannot cover', async () => {
    await h.fundGift('building', '200000000');
    const r = await bill('roof', '200000001', 'building');
    assert.equal(r.status, 422);
    assert.match(r.json.error, /insufficient fund balance/);
    assert.equal(h.treasury.holds.size, 0);
  });

  it('approve is blocked with a clear 4xx when another payout used the fund after the hold was created', async () => {
    await h.fundGift('building', '250000000');
    assert.equal((await bill('roof', '200000000', 'building')).json.status, 'held');
    assert.equal((await bill('gutter', '90000000', 'building')).json.status, 'paid'); // 160 left

    const r = await h.request('POST', '/api/holds/roof/approve');
    assert.equal(r.status, 422, r.text);
    assert.deepEqual(Object.keys(r.json), ['error']);
    assert.match(r.json.error, /insufficient fund balance: building has 160000000 available, bill needs 200000000/);
    assert.equal(h.treasury.holds.get('roof')!.status, 'held');
    assert.equal(h.store.getPayout('roof')!.status, 'held', 'local record not marked paid');

    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.giftsByFund.building, {
      count: 1,
      received: '250000000',
      paidOut: '90000000',
      held: '200000000',
      available: '160000000',
    });

    // A new building gift covers it; approval then succeeds.
    await h.fundGift('building', '40000000');
    const ok = await h.request('POST', '/api/holds/roof/approve');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(h.treasury.available('building'), 0n);
  });

  it('summary per fund: count, received, paidOut, held, available = received - paidOut', async () => {
    await h.fundGift('general', '100000000');
    await h.fundGift('general', '20000000');
    await h.fundGift('missions', '60000000');
    await h.fundGift('building', '250000000');
    // An unsettled gift does not count.
    await h.request('POST', '/api/gifts/quote', giftBody({ fund: 'building' }));

    assert.equal((await bill('elec', '80000000', 'general')).json.status, 'paid');
    assert.equal((await bill('trip', '60000000', 'missions')).json.status, 'paid');
    assert.equal((await bill('roof', '200000000', 'building')).json.status, 'held');
    assert.equal((await bill('nails', '10000000', 'building')).json.status, 'paid');
    assert.equal((await bill('big', '110000000', 'building')).json.status, 'held');
    assert.equal((await h.request('POST', '/api/holds/big/reject')).status, 200);

    const s = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(s.giftsByFund, {
      general: { count: 2, received: '120000000', paidOut: '80000000', held: '0', available: '40000000' },
      missions: { count: 1, received: '60000000', paidOut: '60000000', held: '0', available: '0' },
      building: { count: 1, received: '250000000', paidOut: '10000000', held: '200000000', available: '240000000' },
    });
    for (const f of ['general', 'missions', 'building'] as const) {
      const row = s.giftsByFund[f];
      assert.equal(BigInt(row.available), BigInt(row.received) - BigInt(row.paidOut));
      // The API's view agrees with the (fake) on-chain ledger.
      assert.equal(row.available, h.treasury.available(f).toString());
    }
    assert.deepEqual(s.payouts, { paidCount: 3, paidAmount: '150000000' });
    assert.deepEqual(s.holds, { heldCount: 1, heldAmount: '200000000' });

    const payouts = (await h.request('GET', '/api/payouts')).json.payouts;
    assert.deepEqual(payouts.map((p: any) => [p.bill_id, p.fund]), [
      ['elec', 'general'],
      ['trip', 'missions'],
      ['nails', 'building'],
    ]);
    const holds = (await h.request('GET', '/api/holds')).json.holds;
    assert.deepEqual(holds.map((x: any) => [x.bill_id, x.fund, x.status]), [
      ['roof', 'building', 'held'],
      ['big', 'building', 'rejected'],
    ]);
  });

  it('an approve whose transfer is rolled back is a 4xx and is not recorded as paid', async () => {
    await h.fundGift('general', '200000000');
    await bill('roof', '150000000', 'general');
    h.treasury.failNextTransfer = true;
    const r = await h.request('POST', '/api/holds/roof/approve');
    assert.equal(r.status, 422);
    assert.match(r.json.error, /rolled back/);
    assert.equal(h.store.getPayout('roof')!.status, 'held');
    assert.equal(h.treasury.available('general'), 200000000n, 'fund paid restored');
    assert.equal((await h.request('GET', '/api/summary')).json.giftsByFund.general.paidOut, '0');
  });
});

describe('near helpers', () => {
  it('classifies contract panics as rejections and leaves other errors alone', () => {
    const e = classifyNearError(new Error('Smart contract panicked: vendor is not on the allowlist\n    at ...'));
    assert.ok(e instanceof ContractRejectedError);
    assert.equal(e.message, 'vendor is not on the allowlist');
    const net = classifyNearError(new Error('fetch failed'));
    assert.ok(!(net instanceof ContractRejectedError));
  });

  it('loads a key string from a file path without needing a real key', async () => {
    // Dummy, non-functional placeholder strings generated for the test only.
    const dir = await mkdtemp(join(tmpdir(), 'openlid-keyfile-test-'));
    try {
      const plain = join(dir, 'agent.txt');
      await writeFile(plain, 'ed25519:FakeTestKeyStub\n');
      assert.equal(await loadKeyFromFile(plain), 'ed25519:FakeTestKeyStub');
      const json = join(dir, 'agent.json');
      await writeFile(json, JSON.stringify({ account_id: 'a.testnet', public_key: 'ed25519:PUB', private_key: 'ed25519:FakeTestKeyStub' }));
      assert.equal(await loadKeyFromFile(json), 'ed25519:FakeTestKeyStub');
      const junk = join(dir, 'junk.txt');
      await writeFile(junk, 'not a key');
      await assert.rejects(loadKeyFromFile(junk));

      // Error messages name the path, never the file contents.
      const broken = join(dir, 'broken.json');
      await writeFile(broken, '{"private_key": "ed25519:FakeTestKeyStub", oops');
      await assert.rejects(loadKeyFromFile(broken), (err: Error) => {
        assert.ok(!err.message.includes('FakeTestKeyStub'), err.message);
        assert.ok(err.message.includes(broken));
        return true;
      });
      const wrongShape = join(dir, 'wrong.txt');
      await writeFile(wrongShape, 'ed25519:Has0ForbiddenChars');
      await assert.rejects(loadKeyFromFile(wrongShape), (err: Error) => !err.message.includes('Has0Forbidden'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves key files from env paths or OPENLID_DEMO_KEYS_DIR/<accountId>.json only', () => {
    assert.equal(resolveKeyFile('/keys/agent.json', '/demo', 'agent.testnet'), '/keys/agent.json');
    assert.equal(resolveKeyFile(undefined, '/demo', 'agent.testnet'), '/demo/agent.testnet.json');
    assert.equal(resolveKeyFile(undefined, undefined, 'agent.testnet'), undefined);
    assert.equal(resolveKeyFile(undefined, '/demo', undefined), undefined);
  });
});
