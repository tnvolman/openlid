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
    const paid = await h.request('POST', '/api/payouts/request', {
      vendor: VENDOR,
      amount: '50000000',
      billId: 'bill-001',
      memo: 'gutter repair',
    });
    assert.equal(paid.status, 200, paid.text);
    assert.deepEqual(paid.json, { billId: 'bill-001', status: 'paid', vendor: VENDOR, amount: '50000000' });
    assert.deepEqual(h.treasury.requests[0], { vendor: VENDOR, amount: '50000000', billId: 'bill-001', memo: 'gutter repair' });

    const held = await h.request('POST', '/api/payouts/request', {
      vendor: VENDOR,
      amount: '250000000',
      billId: 'bill-002',
      memo: 'new roof (unusual)',
    });
    assert.equal(held.status, 200, held.text);
    assert.deepEqual(held.json, { billId: 'bill-002', status: 'held', vendor: VENDOR, amount: '250000000' });

    const rejected = await h.request('POST', '/api/payouts/request', {
      vendor: 'stranger.testnet',
      amount: '1000000',
      billId: 'bill-003',
      memo: 'not allowlisted',
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
    });
    assert.ok(capExceeded.status >= 400 && capExceeded.status < 500);
    assert.match(capExceeded.json.error, /cap/);

    const payouts = (await h.request('GET', '/api/payouts')).json.payouts;
    assert.deepEqual(payouts, [{ bill_id: 'bill-001', vendor: VENDOR, amount: '50000000', memo: 'gutter repair', status: 'paid' }]);

    const holds = (await h.request('GET', '/api/holds?status=held')).json.holds;
    assert.deepEqual(holds, [{ bill_id: 'bill-002', vendor: VENDOR, amount: '250000000', memo: 'new roof (unusual)', status: 'held' }]);

    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.payouts, { paidCount: 1, paidAmount: '50000000' });
    assert.deepEqual(summary.holds, { heldCount: 1, heldAmount: '250000000' });
    assert.equal(summary.receiptNote, 'demo, not a tax document');
  });

  it('duplicate billId is rejected', async () => {
    const body = { vendor: VENDOR, amount: '1000000', billId: 'dup', memo: '' };
    assert.equal((await h.request('POST', '/api/payouts/request', body)).status, 200);
    const again = await h.request('POST', '/api/payouts/request', body);
    assert.equal(again.status, 409);
    assert.ok(again.json.error);
  });

  it('validates payout requests before calling the contract', async () => {
    const bad = [
      { vendor: 'Not A Near Id', amount: '1', billId: 'b', memo: '' },
      { vendor: VENDOR, amount: '-5', billId: 'b', memo: '' },
      { vendor: VENDOR, amount: '1', billId: '', memo: '' },
      { vendor: VENDOR, amount: '1', billId: 'b', memo: 7 },
    ];
    for (const body of bad) {
      const r = await h.request('POST', '/api/payouts/request', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error);
    }
    assert.equal(h.treasury.requests.length, 0);
  });

  it('treasurer approve / reject holds', async () => {
    for (const billId of ['hold-a', 'hold-b']) {
      const r = await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '150000000', billId, memo: 'big' });
      assert.equal(r.json.status, 'held');
    }
    const approve = await h.request('POST', '/api/holds/hold-a/approve');
    assert.equal(approve.status, 200, approve.text);
    assert.equal(approve.json.status, 'approved');

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
    assert.deepEqual(payouts.map((p: any) => p.bill_id), ['hold-a']);
    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.payouts, { paidCount: 1, paidAmount: '150000000' });
    assert.deepEqual(summary.holds, { heldCount: 0, heldAmount: '0' });
  });

  it('export.csv includes gifts, payouts and the demo note; guards against formula injection', async () => {
    h.oneClickMock.depositAddresses.push('addr-csv');
    await h.request('POST', '/api/gifts/quote', giftBody({ donor: '=HYPERLINK("x")' }));
    await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '1000000', billId: 'csv-1', memo: 'a, "b"' });

    const r = await h.request('GET', '/api/export.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/csv/);
    const lines = r.text.trim().split('\n');
    assert.equal(lines[0], '# demo, not a tax document');
    assert.match(lines[1]!, /^type,id,/);
    const gift = lines.find((l) => l.startsWith('gift,'))!;
    assert.ok(gift.includes('addr-csv'));
    assert.ok(gift.includes(`"'=HYPERLINK(""x"")"`), gift);
    const payout = lines.find((l) => l.startsWith('payout,'))!;
    assert.ok(payout.includes('csv-1') && payout.includes('"a, ""b"""'), payout);
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
      body: JSON.stringify({ vendor: VENDOR, amount: '1', billId: 'x', memo: '' }),
    });
    assert.equal(res.status, 503);
    const summary = (await (await app.request('/api/summary')).json()) as any;
    assert.equal(summary.holds.available, false);
    assert.equal(summary.receiptNote, 'demo, not a tax document');
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
