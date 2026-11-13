import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { APPROVAL_HEADER, CORS_ORIGINS } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { APPROVAL, makeHarness, TEST_APPROVAL_SECRET } from './helpers.js';

const VENDOR = 'roofer.testnet';
type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** Funds `building`, files two over-limit bills (held), and counts approve/reject calls reaching the contract. */
async function setup(opts: Parameters<typeof makeHarness>[0] = {}) {
  const h = await makeHarness(opts);
  h.treasury.allowlist.add(VENDOR);
  await h.fundGift('building', '400000000');
  for (const billId of ['hold-a', 'hold-b']) {
    const r = await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '150000000', billId, memo: 'big', fund: 'building' });
    assert.equal(r.json.status, 'held', r.text);
  }
  const calls = { approve: 0, reject: 0 };
  const approve = h.treasury.approveHold.bind(h.treasury);
  const reject = h.treasury.rejectHold.bind(h.treasury);
  h.treasury.approveHold = (billId) => (calls.approve++, approve(billId));
  h.treasury.rejectHold = (billId) => (calls.reject++, reject(billId));
  return { h, calls };
}

const WRONG_SAME_LENGTH = 'x'.repeat(TEST_APPROVAL_SECRET.length);
const ACTIONS = [
  { action: 'approve', billId: 'hold-a', status: 'approved' },
  { action: 'reject', billId: 'hold-b', status: 'rejected' },
] as const;

describe('approve/reject require the treasurer approval secret', () => {
  let h: Harness | undefined;
  afterEach(() => h?.cleanup());

  for (const { action, billId, status } of ACTIONS) {
    it(`${action}: missing, wrong (same and different length) header -> 401; nothing reaches the contract`, async () => {
      const s = await setup();
      h = s.h;
      const path = `/api/holds/${billId}/${action}`;
      const cases: Array<[string, Record<string, string>]> = [
        ['missing', {}],
        ['empty', { [APPROVAL_HEADER]: '' }],
        ['wrong, same length', { [APPROVAL_HEADER]: WRONG_SAME_LENGTH }],
        ['wrong, shorter', { [APPROVAL_HEADER]: 'nope' }],
        ['wrong, longer', { [APPROVAL_HEADER]: `${TEST_APPROVAL_SECRET}-extra` }],
        ['secret as a prefix', { [APPROVAL_HEADER]: TEST_APPROVAL_SECRET.slice(0, -1) }],
      ];
      for (const [label, headers] of cases) {
        const r = await h.request('POST', path, undefined, headers);
        assert.equal(r.status, 401, `${label}: ${r.text}`);
        assert.deepEqual(Object.keys(r.json), ['error'], label);
        assert.match(r.json.error, /X-OpenLid-Approval/, label);
        assert.ok(!r.text.includes(TEST_APPROVAL_SECRET), `${label}: secret echoed`);
        for (const v of Object.values(headers)) if (v) assert.ok(!r.text.includes(v), `${label}: header echoed`);
      }
      assert.deepEqual(s.calls, { approve: 0, reject: 0 });
      assert.equal((await h.request('GET', '/api/holds?status=held')).json.holds.length, 2);
    });

    it(`${action}: correct header -> 200 and the contract is called once`, async () => {
      const s = await setup();
      h = s.h;
      const r = await h.request('POST', `/api/holds/${billId}/${action}`, undefined, APPROVAL);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.status, status);
      assert.ok(!r.text.includes(TEST_APPROVAL_SECRET));
      assert.deepEqual(s.calls, { approve: action === 'approve' ? 1 : 0, reject: action === 'reject' ? 1 : 0 });
      // Header name is case-insensitive.
      const lower = await h.request('POST', `/api/holds/${billId}/${action}`, undefined, { 'x-openlid-approval': TEST_APPROVAL_SECRET });
      assert.equal(lower.status, 422, lower.text); // passed auth; the hold is no longer held
    });

    it(`${action}: secret unset -> 503 "approval secret not configured", even with a header`, async () => {
      for (const approvalSecret of [null, '', '   ']) {
        const s = await setup({ approvalSecret });
        h = s.h;
        for (const headers of [{}, APPROVAL]) {
          const r = await h.request('POST', `/api/holds/${billId}/${action}`, undefined, headers);
          assert.equal(r.status, 503, r.text);
          assert.deepEqual(Object.keys(r.json), ['error']);
          assert.match(r.json.error, /approval secret not configured/);
          assert.ok(!r.text.includes(TEST_APPROVAL_SECRET));
        }
        assert.deepEqual(s.calls, { approve: 0, reject: 0 });
        await h.cleanup();
        h = undefined;
      }
    });
  }

  it('agent and read paths need no header, work with the secret unset, and never return the secret', async () => {
    for (const approvalSecret of [undefined, null]) {
      h = await makeHarness({ approvalSecret });
      h.treasury.allowlist.add(VENDOR);
      await h.fundGift('general', '300000000');
      const responses = [
        await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '50000000', billId: 'small', memo: '', fund: 'general' }),
        await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '150000000', billId: 'big', memo: '', fund: 'general' }),
        await h.request('GET', '/api/holds'),
        await h.request('GET', '/api/holds?status=held'),
        await h.request('GET', '/api/payouts'),
        await h.request('GET', '/api/summary'),
        await h.request('GET', '/api/gifts'),
        await h.request('GET', '/api/export.csv'),
        await h.request('GET', '/api/health'),
      ];
      for (const r of responses) {
        assert.equal(r.status, 200, r.text);
        assert.ok(!r.text.includes(TEST_APPROVAL_SECRET), 'secret leaked in a response');
        for (const v of r.headers.values()) assert.ok(!v.includes(TEST_APPROVAL_SECRET), 'secret leaked in a header');
      }
      assert.equal(responses[0].json.status, 'paid');
      assert.equal(responses[1].json.status, 'held');
      assert.equal(responses[3].json.holds.length, 1);
      assert.equal(responses[5].json.holds.heldCount, 1);
      // The secret never reaches the contract client (the agent path's only input is the bill).
      assert.ok(!JSON.stringify(h.treasury.requests).includes(TEST_APPROVAL_SECRET));
      await h.cleanup();
      h = undefined;
    }
  });

  it('CORS preflight from the treasurer page allows the X-OpenLid-Approval header', async () => {
    h = await makeHarness();
    const res = await h.app.request('/api/holds/hold-a/approve', {
      method: 'OPTIONS',
      headers: {
        origin: CORS_ORIGINS[0],
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-openlid-approval',
      },
    });
    assert.ok(res.status === 204 || res.status === 200, `preflight ${res.status}`);
    assert.equal(res.headers.get('access-control-allow-origin'), CORS_ORIGINS[0]);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
    assert.ok(allowed.includes('x-openlid-approval'), `allow-headers: ${allowed}`);
    assert.ok(allowed.includes('content-type'));
  });

  it('config reads OPENLID_APPROVAL_SECRET; empty or blank means unset', () => {
    assert.equal(loadConfig({ OPENLID_APPROVAL_SECRET: 'abc123' }).approvalSecret, 'abc123');
    assert.equal(loadConfig({ OPENLID_APPROVAL_SECRET: '' }).approvalSecret, undefined);
    assert.equal(loadConfig({ OPENLID_APPROVAL_SECRET: '   ' }).approvalSecret, undefined);
    assert.equal(loadConfig({}).approvalSecret, undefined);
  });
});
