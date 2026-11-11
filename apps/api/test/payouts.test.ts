import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { classifyNearError, ContractRejectedError, loadKeyFromFile, NearUnavailableError, resolveKeyFile, UnconfiguredNearClient } from '../src/near.js';
import { HttpOneClickClient } from '../src/oneclick.js';
import { BOUNDARY_NO_CUSTODY, BOUNDARY_NONCASH } from '../src/types.js';
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
    const { requestedAt, txHash, ...paidCore } = paid.json;
    assert.deepEqual(paidCore, { billId: 'bill-001', status: 'paid', vendor: VENDOR, amount: '50000000', fund: 'general' });
    assert.match(requestedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(txHash, 'fake-near-tx-1');
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
    assert.equal(held.json.status, 'held');
    assert.equal(held.json.fund, 'general');

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
      {
        bill_id: 'bill-001',
        vendor: VENDOR,
        amount: '50000000',
        memo: 'gutter repair',
        fund: 'general',
        status: 'paid',
        requestedAt,
        paidAt: requestedAt,
        paymentTxHash: 'fake-near-tx-1',
        requestTxHash: 'fake-near-tx-1',
      },
    ]);

    const holds = (await h.request('GET', '/api/holds?status=held')).json.holds;
    assert.deepEqual(holds, [
      {
        bill_id: 'bill-002',
        vendor: VENDOR,
        amount: '250000000',
        memo: 'new roof (unusual)',
        fund: 'general',
        status: 'held',
        requestedAt: held.json.requestedAt,
        requestTxHash: 'fake-near-tx-2',
        paidAt: null,
        paymentTxHash: null,
      },
    ]);

    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.payouts, { paidCount: 1, paidAmount: '50000000' });
    assert.deepEqual(summary.holds, { heldCount: 1, heldAmount: '250000000' });
    assert.deepEqual(summary.giftsByFund.general, {
      restriction: 'without donor restrictions',
      count: 1,
      received: '300000000',
      paidOut: '50000000',
      held: '250000000',
      // Uncommitted: received - paidOut - held.
      available: '0',
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
    assert.equal(approve.json.txHash, 'fake-near-tx-3');
    assert.equal(approve.json.hold.paymentTxHash, 'fake-near-tx-3');
    assert.ok(approve.json.hold.paidAt);

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
    assert.deepEqual(
      payouts.map((p: any) => [p.bill_id, p.fund, p.paymentTxHash, p.requestTxHash]),
      [['hold-a', 'building', 'fake-near-tx-3', 'fake-near-tx-1']],
    );
    assert.ok(payouts[0].requestedAt <= payouts[0].paidAt);
    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.payouts, { paidCount: 1, paidAmount: '150000000' });
    assert.deepEqual(summary.holds, { heldCount: 0, heldAmount: '0' });
    assert.deepEqual(summary.giftsByFund.building, {
      restriction: 'with donor restrictions',
      count: 1,
      received: '300000000',
      paidOut: '150000000',
      held: '0',
      available: '150000000',
    });
  });

  it('export.csv: disclaimers, fund/dates/references on every row, and a per-fund reconciliation section', async () => {
    h.oneClickMock.depositAddresses.push('addr-csv');
    await h.request('POST', '/api/gifts/quote', giftBody({ donor: '=HYPERLINK("x")' }));
    await h.fundGift('missions', '160000000');
    await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '1000000', billId: 'csv-1', memo: 'a, "b"', fund: 'missions' });
    await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '150000000', billId: 'csv-hold', memo: 'roof', fund: 'missions' });

    const r = await h.request('GET', '/api/export.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/csv/);
    const lines = r.text.trim().split('\n');
    assert.deepEqual(lines.slice(0, 5), [
      '# demo, not a tax document',
      '# This is not a contemporaneous written acknowledgment or year-end giving statement under IRS Publication 1771.',
      '# This is not GAAP financial statements and not an audit, review, or compilation. Testnet only; no real funds.',
      `# ${BOUNDARY_NONCASH}`,
      `# ${BOUNDARY_NO_CUSTODY}`,
    ]);
    assert.match(lines[5]!, /^type,id,/);
    const header = lines[5]!.split(',');
    // D9: amounts are book value at receipt, never a deductible value.
    assert.ok(header.includes('amount_usdc_book_value_at_receipt'));
    assert.ok(!header.includes('amount_usdc'));
    assert.match(lines[3]!, /noncash property, not cash/);
    assert.match(lines[3]!, /book value at receipt .*not a deductible value/);
    assert.match(lines[3]!, /Forms 8283 and 8282/);
    assert.match(lines[3]!, /A CPA must confirm current rules/);
    assert.ok(!/tax[- ]deductible|tax deduction/i.test(r.text), 'never calls an amount a tax deduction');
    // D10: no custody; legal review before real money.
    assert.match(lines[4]!, /never holds or moves donor funds for someone else/);
    assert.match(lines[4]!, /treasury the church controls/);
    assert.match(lines[4]!, /legal review is required before any real money/);
    for (const col of ['created_at', 'paid_at', 'fund', 'restriction', 'payment_ref', 'request_ref']) assert.ok(header.includes(col), col);
    const col = (row: string, name: string) => row.split(',')[header.indexOf(name)];

    const gift = lines.find((l) => l.startsWith('gift,') && l.includes('addr-csv'))!;
    assert.ok(gift.includes(`"'=HYPERLINK(""x"")"`), gift);
    // Fund on EVERY gift and payout row.
    const dataRows = lines.filter((l) => l.startsWith('gift,') || l.startsWith('payout,'));
    assert.equal(dataRows.length, 4);
    for (const row of dataRows) assert.ok(['general', 'missions', 'building'].includes(col(row, 'fund')!), row);
    const settledGift = dataRows.find((l) => l.startsWith('gift,') && l.includes(',settled,'))!;
    assert.equal(col(settledGift, 'payment_ref'), 'fake-tx-1', 'gift row carries the settlement tx');
    assert.equal(col(settledGift, 'restriction'), 'with donor restrictions');

    const payout = lines.find((l) => l.startsWith('payout,csv-1,'))!;
    assert.ok(payout.includes('"a, ""b"""'), payout);
    assert.equal(col(payout, 'fund'), 'missions');
    assert.match(col(payout, 'created_at')!, /^\d{4}-\d\d-\d\dT/);
    assert.match(col(payout, 'paid_at')!, /^\d{4}-\d\d-\d\dT/);
    assert.equal(col(payout, 'payment_ref'), 'fake-near-tx-1');
    const holdRow = lines.find((l) => l.startsWith('payout,csv-hold,'))!;
    assert.equal(col(holdRow, 'status'), 'held');
    assert.equal(col(holdRow, 'paid_at'), '');
    assert.equal(col(holdRow, 'request_ref'), 'fake-near-tx-2');

    // Reconciliation section ties out by fund.
    const i = lines.indexOf('fund,restriction,gifts,received,paid,held,available');
    assert.ok(i > 0, 'reconciliation header present');
    assert.match(lines[i - 1]!, /^# per-fund reconciliation/);
    assert.deepEqual(lines.slice(i + 1, i + 4), [
      'general,without donor restrictions,0,0,0,0,0',
      'missions,with donor restrictions,1,160000000,1000000,150000000,9000000',
      'building,with donor restrictions,0,0,0,0,0',
    ]);
    assert.equal(
      lines[i + 4],
      '# treasury cash (on-chain): 159000000; fund ledgers total (received - paid, from chain): 159000000; match',
    );
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

  it('general (without donor restrictions) still cannot pay a missions or building bill', async () => {
    await h.fundGift('general', '500000000');
    for (const fund of ['missions', 'building']) {
      const r = await bill(`x-${fund}`, '1000000', fund);
      assert.equal(r.status, 422);
      assert.match(r.json.error, new RegExp(`insufficient fund balance: ${fund} has 0 available`));
    }
    assert.equal(h.treasury.available('general'), 500000000n);
  });

  it('refuses to create a hold its fund already cannot cover', async () => {
    await h.fundGift('building', '200000000');
    const r = await bill('roof', '200000001', 'building');
    assert.equal(r.status, 422);
    assert.match(r.json.error, /insufficient fund balance/);
    assert.equal(h.treasury.holds.size, 0);
  });

  it('holds reserve: a second hold that would over-commit the same money is refused immediately', async () => {
    await h.fundGift('building', '250000000');
    assert.equal((await bill('roof', '200000000', 'building')).json.status, 'held');
    // Only 50 uncommitted remain. Both a second hold and a routine bill over 50 are refused now.
    const second = await bill('roof-2', '200000000', 'building');
    assert.equal(second.status, 422, second.text);
    assert.match(second.json.error, /insufficient fund balance: building has 50000000 available, bill needs 200000000/);
    const gutter = await bill('gutter', '90000000', 'building');
    assert.equal(gutter.status, 422);
    assert.equal(h.treasury.holds.size, 1);

    const summary = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(summary.giftsByFund.building, {
      restriction: 'with donor restrictions',
      count: 1,
      received: '250000000',
      paidOut: '0',
      held: '200000000',
      available: '50000000',
    });

    // Approving converts the reservation; it does not need the money twice.
    const ok = await h.request('POST', '/api/holds/roof/approve');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(h.treasury.available('building'), 50000000n);
    assert.deepEqual(h.treasury.ledger.get('building'), { received: 250000000n, paid: 200000000n, held: 0n });
  });

  it('reject frees the reservation', async () => {
    await h.fundGift('building', '200000000');
    await bill('roof', '200000000', 'building');
    assert.equal((await bill('nails', '1', 'building')).status, 422);
    assert.equal((await h.request('POST', '/api/holds/roof/reject')).status, 200);
    assert.equal(h.treasury.available('building'), 200000000n);
    assert.equal((await bill('nails', '1', 'building')).json.status, 'paid');
    const s = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual([s.giftsByFund.building.held, s.giftsByFund.building.available], ['0', '199999999']);
  });

  it('approve blocked by the fund is a clear 4xx and the hold stays held', async () => {
    await h.fundGift('building', '250000000');
    assert.equal((await bill('roof', '200000000', 'building')).json.status, 'held');
    // Reservation makes this unreachable through the API; simulate the chain ledger changing underneath
    // (e.g. another client) to prove the approve path re-checks and reports it clearly.
    h.treasury.ledger.get('building')!.paid += 90000000n;

    const r = await h.request('POST', '/api/holds/roof/approve');
    assert.equal(r.status, 422, r.text);
    assert.deepEqual(Object.keys(r.json), ['error']);
    assert.match(r.json.error, /insufficient fund balance: building has 160000000 available, bill needs 200000000/);
    assert.equal(h.treasury.holds.get('roof')!.status, 'held');
    assert.equal(h.store.getPayout('roof')!.status, 'held', 'local record not marked paid');
  });

  it('summary per fund: restriction, count, received, paidOut, held, available = received - paidOut - held', async () => {
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
    assert.equal((await bill('big', '110000000', 'building')).status, 422, 'would over-commit building');
    await h.fundGift('building', '110000000');
    assert.equal((await bill('big', '110000000', 'building')).json.status, 'held');
    assert.equal((await h.request('POST', '/api/holds/big/reject')).status, 200);

    const s = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(s.giftsByFund, {
      general: { restriction: 'without donor restrictions', count: 2, received: '120000000', paidOut: '80000000', held: '0', available: '40000000' },
      missions: { restriction: 'with donor restrictions', count: 1, received: '60000000', paidOut: '60000000', held: '0', available: '0' },
      building: { restriction: 'with donor restrictions', count: 2, received: '360000000', paidOut: '10000000', held: '200000000', available: '150000000' },
    });
    for (const f of ['general', 'missions', 'building'] as const) {
      const row = s.giftsByFund[f];
      assert.equal(BigInt(row.available), BigInt(row.received) - BigInt(row.paidOut) - BigInt(row.held));
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
    for (const x of holds) assert.match(x.requestedAt, /^\d{4}-/);
  });

  it('an approve whose transfer is rolled back is a 4xx, not recorded as paid, and the reservation returns', async () => {
    await h.fundGift('general', '200000000');
    await bill('roof', '150000000', 'general');
    h.treasury.failNextTransfer = true;
    const r = await h.request('POST', '/api/holds/roof/approve');
    assert.equal(r.status, 422);
    assert.match(r.json.error, /rolled back/);
    assert.equal(h.store.getPayout('roof')!.status, 'held');
    assert.deepEqual(h.treasury.ledger.get('general'), { received: 200000000n, paid: 0n, held: 150000000n });
    assert.equal(h.treasury.available('general'), 50000000n, 'reservation restored');
    const s = (await h.request('GET', '/api/summary')).json;
    assert.equal(s.giftsByFund.general.paidOut, '0');
    assert.equal(s.reconciliation.status, 'match');
  });
});

describe('cash vs fund ledgers (reconciliation)', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
    h.treasury.allowlist.add(VENDOR);
  });
  afterEach(() => h.cleanup());

  it('match: live cash equals the sum of fund ledgers (received - paid = available + held)', async () => {
    await h.fundGift('general', '100000000');
    await h.fundGift('building', '250000000');
    await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '80000000', billId: 'a', memo: '', fund: 'building' });
    await h.request('POST', '/api/payouts/request', { vendor: VENDOR, amount: '150000000', billId: 'b', memo: '', fund: 'building' });
    const s = (await h.request('GET', '/api/summary')).json;
    assert.equal(s.treasuryBalance, '270000000');
    assert.deepEqual(s.reconciliation, {
      cash: '270000000',
      ledgerTotal: '270000000',
      ledgerSource: 'chain',
      difference: '0',
      status: 'match',
    });
    const sumAvailHeld = (['general', 'missions', 'building'] as const).reduce(
      (acc, f) => acc + BigInt(s.giftsByFund[f].available) + BigInt(s.giftsByFund[f].held),
      0n,
    );
    assert.equal(sumAvailHeld.toString(), s.reconciliation.ledgerTotal);
  });

  it('mismatch: tokens minted without a fund credit are flagged, not hidden', async () => {
    await h.fundGift('missions', '60000000');
    const g = (await h.request('POST', '/api/gifts/quote', giftBody({ fund: 'missions' }))).json;
    h.settlement.failCredit = new ContractRejectedError('unauthorized: caller is not owner');
    assert.equal((await h.request('POST', `/api/gifts/${g.id}/simulate-settlement`)).status, 422);
    const s = (await h.request('GET', '/api/summary')).json;
    assert.deepEqual(s.reconciliation, {
      cash: '69950000',
      ledgerTotal: '60000000',
      ledgerSource: 'chain',
      difference: '9950000',
      status: 'mismatch',
    });
    const csv = (await h.request('GET', '/api/export.csv')).text;
    assert.match(csv, /fund ledgers total \(received - paid, from chain\): 60000000; mismatch \(cash - ledgers = 9950000\)/);
  });

  it('unknown when cash cannot be read; falls back to API figures for the ledger total', async () => {
    const app = createApp({
      store: h.store,
      oneClick: new HttpOneClickClient({ baseUrl: 'https://1click.mock.invalid', fetch: h.oneClickMock.fetch }),
      near: new UnconfiguredNearClient('NEAR is not configured'),
      settlement: h.settlement,
      network: 'testnet',
    });
    const s = (await (await app.request('/api/summary')).json()) as any;
    assert.deepEqual(s.reconciliation, { cash: null, ledgerTotal: '0', ledgerSource: 'api', difference: null, status: 'unknown' });
  });
});

describe('near helpers', () => {
  it('classifies contract panics as rejections and leaves other errors alone', () => {
    const e = classifyNearError(new Error('Smart contract panicked: vendor is not on the allowlist\n    at ...'));
    assert.ok(e instanceof ContractRejectedError);
    assert.equal(e.message, 'vendor is not on the allowlist');
    const net = classifyNearError(new Error('fetch failed'));
    assert.ok(!(net instanceof ContractRejectedError));
    assert.ok(!(net instanceof NearUnavailableError));
  });

  it('classifies JSON-RPC -429 and HTTP 429/5xx RPC failures as NearUnavailableError', () => {
    const soft = (err: unknown) => {
      const e = classifyNearError(err);
      assert.ok(e instanceof NearUnavailableError, `expected NearUnavailableError, got ${e.name}: ${e.message}`);
      assert.equal(e.message, 'NEAR RPC is unavailable');
    };

    soft({ code: -429, message: 'Please use a different RPC provider' });
    soft(Object.assign(new Error('JSON-RPC error code: -429'), { code: -429 }));
    soft(Object.assign(new Error('Too Many Requests'), { cause: 429 }));
    soft(Object.assign(new Error('Internal server error'), { cause: 500 }));
    soft(Object.assign(new Error('https://rpc.testnet.near.org Bad Gateway'), { cause: 502 }));
    soft(Object.assign(new Error('https://rpc.testnet.near.org unavailable'), { cause: 503 }));
    soft(Object.assign(new Error('Exceeded 12 attempts for https://rpc.testnet.fastnear.com.'), { type: 'RetriesExceeded' }));
    soft(new Error('The official RPC endpoint is deprecated; use a different RPC provider'));

    const panic = classifyNearError(new Error('Smart contract panicked: insufficient fund balance\n    at ...'));
    assert.ok(panic instanceof ContractRejectedError);
    assert.ok(!(panic instanceof NearUnavailableError));
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
