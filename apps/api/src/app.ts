import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ContractRejectedError, NearUnavailableError, type NearContractClient, type TestnetSettlement } from './near.js';
import { OneClickError, type OneClickClient } from './oneclick.js';
import { DuplicateBillIdError, DuplicateDepositAddressError, type JsonStore } from './store.js';
import {
  FUNDS,
  HOLD_STATUSES,
  RECEIPT_NOTE,
  SIM_ADDRESS_PREFIX,
  STATUS_MAP,
  isSimulatedAddress,
  toGiftView,
  type Fund,
  type GiftRecord,
  type HoldStatus,
  type HoldView,
  type PayoutRecord,
  type PayoutView,
} from './types.js';

export interface AppDeps {
  store: JsonStore;
  oneClick: OneClickClient;
  near: NearContractClient;
  /** Simulated cross-chain settlement (test FT mint into the treasury). Testnet only. */
  settlement: TestnetSettlement;
  /** OPENLID_NETWORK. simulate-settlement is refused unless this is `testnet`. */
  network: string;
  /** Treasury contract account that receives USDC (1Click `recipient`). */
  contractId?: string;
  /** NEP-141 USDC token account; the 1Click destination asset is `nep141:<id>`. */
  usdcTokenId?: string;
  /** Quote deadline window. */
  quoteTtlMs?: number;
  now?: () => Date;
}

export const CORS_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

const POSITIVE_INT = /^[1-9][0-9]*$/;
// NEAR account id rules: 2-64 chars, lowercase alnum separated by single - _ or .
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function reqString(body: Record<string, unknown>, key: string, max = 256): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `${key} is required`);
  if (v.length > max) throw new HttpError(400, `${key} is too long`);
  return v.trim();
}

function reqAmount(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !POSITIVE_INT.test(v) || v.length > 39) {
    throw new HttpError(400, `${key} must be a positive integer string in atomic units`);
  }
  return v;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, 'request body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'request body must be a JSON object');
  return body as Record<string, unknown>;
}

function sumAmounts(xs: Array<string | null | undefined>): string {
  return xs.reduce<bigint>((acc, x) => acc + (x && POSITIVE_INT.test(x) ? BigInt(x) : 0n), 0n).toString();
}

function payoutView(p: PayoutRecord): PayoutView {
  return { bill_id: p.billId, vendor: p.vendor, amount: p.amount, memo: p.memo, status: 'paid' };
}

const CSV_INJECTION = /^[=+\-@\t\r]/;
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (CSV_INJECTION.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createApp(deps: AppDeps): Hono {
  const { store, oneClick, near } = deps;
  const now = deps.now ?? (() => new Date());
  const quoteTtlMs = deps.quoteTtlMs ?? 60 * 60 * 1000;

  const app = new Hono();

  app.use('/api/*', cors({ origin: CORS_ORIGINS, allowMethods: ['GET', 'POST', 'OPTIONS'] }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof DuplicateDepositAddressError) return c.json({ error: err.message }, 409);
    if (err instanceof DuplicateBillIdError) return c.json({ error: err.message }, 409);
    if (err instanceof ContractRejectedError) return c.json({ error: `contract rejected: ${err.message}` }, 422);
    if (err instanceof NearUnavailableError) return c.json({ error: err.message }, 503);
    if (err instanceof OneClickError) return c.json({ error: err.message }, 502);
    console.error('unhandled error:', err instanceof Error ? err.message : 'unknown');
    return c.json({ error: 'internal error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---- Gifts ---------------------------------------------------------------

  app.post('/api/gifts/quote', async (c) => {
    const body = await jsonBody(c);
    const donor = reqString(body, 'donor', 200);
    const fund = body.fund;
    if (typeof fund !== 'string' || !(FUNDS as readonly string[]).includes(fund)) {
      throw new HttpError(400, `fund must be one of ${FUNDS.join(', ')}`);
    }
    const originAsset = reqString(body, 'originAsset');
    const amount = reqAmount(body, 'amount');
    const refundTo = reqString(body, 'refundTo');
    const refundType = body.refundType ?? 'ORIGIN_CHAIN';
    if (refundType !== 'ORIGIN_CHAIN') throw new HttpError(400, 'refundType must be ORIGIN_CHAIN');
    const slippageTolerance = body.slippageTolerance ?? 100;
    if (typeof slippageTolerance !== 'number' || !Number.isInteger(slippageTolerance) || slippageTolerance < 0 || slippageTolerance > 10_000) {
      throw new HttpError(400, 'slippageTolerance must be an integer in basis points (0-10000)');
    }
    if (!deps.contractId || !deps.usdcTokenId) {
      throw new HttpError(503, 'OPENLID_CONTRACT_ID and OPENLID_USDC_TOKEN_ID must be configured to request quotes');
    }

    const quote = await oneClick.quote({
      // Dry run only: no payable deposit address is requested and no deposit is ever sent.
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance,
      originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${deps.usdcTokenId}`,
      amount,
      refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: deps.contractId,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(now().getTime() + quoteTtlMs).toISOString(),
    });

    // Official dry quotes carry no depositAddress, so the gift gets a unique simulated `sim:<id>` address.
    // A real address is still accepted (non-dry fixtures in tests) and matched the same way: by address only.
    const id = randomUUID();
    const quoted = quote.quote.depositAddress?.trim();
    if (quoted && isSimulatedAddress(quoted)) throw new OneClickError('1Click returned a reserved sim: deposit address');
    const depositAddress = quoted || `${SIM_ADDRESS_PREFIX}${id}`;

    const ts = now().toISOString();
    const gift: GiftRecord = {
      id,
      donor,
      fund: fund as Fund,
      originAsset,
      refundTo,
      depositAddress,
      depositMemo: quote.quote.depositMemo ?? null,
      correlationId: quote.correlationId,
      quoteSignature: quote.signature,
      quoteTimestamp: quote.timestamp,
      amountIn: quote.quote.amountIn,
      amountOut: quote.quote.amountOut,
      minAmountOut: quote.quote.minAmountOut ?? null,
      quoteDeadline: quote.quote.deadline ?? null,
      status: 'pending_deposit',
      oneClickStatus: null,
      settledAmount: null,
      settlementTxHash: null,
      createdAt: ts,
      updatedAt: ts,
    };
    // Throws DuplicateDepositAddressError (409) if an address (real or simulated) is already assigned.
    await store.insertGift(gift);
    return c.json(toGiftView(gift), 201);
  });

  app.get('/api/gifts', (c) => {
    const fund = c.req.query('fund');
    if (fund !== undefined && !(FUNDS as readonly string[]).includes(fund)) {
      throw new HttpError(400, `fund must be one of ${FUNDS.join(', ')}`);
    }
    const gifts = store.listGifts().filter((g) => !fund || g.fund === fund);
    return c.json({ gifts: gifts.map(toGiftView) });
  });

  app.get('/api/gifts/:id', (c) => {
    const gift = store.getGift(c.req.param('id'));
    if (!gift) throw new HttpError(404, 'gift not found');
    return c.json(toGiftView(gift));
  });

  app.post('/api/gifts/:id/sync', async (c) => {
    const gift = store.getGift(c.req.param('id'));
    if (!gift) throw new HttpError(404, 'gift not found');

    // Simulated addresses have nothing to poll at 1Click; status only changes via simulate-settlement.
    if (isSimulatedAddress(gift.depositAddress)) return c.json(toGiftView(gift));

    // Status is looked up by this gift's deposit address only; never by amount.
    const st = await oneClick.status(gift.depositAddress, gift.depositMemo);
    const echoed = st.quoteResponse?.quote?.depositAddress;
    if (echoed && echoed.trim().toLowerCase() !== gift.depositAddress.toLowerCase()) {
      throw new OneClickError('1Click status response is for a different deposit address');
    }
    const status = STATUS_MAP[st.status];
    const updated = await store.updateGift(gift.id, {
      status,
      oneClickStatus: st.status,
      settledAmount: status === 'settled' ? (st.swapDetails?.amountOut ?? gift.amountOut) : null,
      updatedAt: now().toISOString(),
    });
    return c.json(toGiftView(updated));
  });

  const settling = new Set<string>();

  app.post('/api/gifts/:id/simulate-settlement', async (c) => {
    if (deps.network === 'mainnet') {
      throw new HttpError(403, 'simulate-settlement is refused on mainnet; it is a NEAR testnet demo only');
    }
    if (deps.network !== 'testnet') {
      throw new HttpError(403, `simulate-settlement runs on NEAR testnet only (OPENLID_NETWORK=${deps.network})`);
    }
    const gift = store.getGift(c.req.param('id'));
    if (!gift) throw new HttpError(404, 'gift not found');
    if (!isSimulatedAddress(gift.depositAddress)) {
      throw new HttpError(409, 'gift has a real 1Click deposit address; only sim: gifts can be settled by simulation');
    }
    if (gift.status !== 'pending_deposit' && gift.status !== 'processing') {
      throw new HttpError(409, `gift is already ${gift.status}`);
    }
    if (settling.has(gift.id)) throw new HttpError(409, 'settlement already in progress for this gift');
    settling.add(gift.id);
    try {
      const amount = gift.amountOut;
      // Mints the test FT into the treasury contract. No 1Click deposit is involved.
      const { txHash } = await deps.settlement.creditTreasury({ giftId: gift.id, amount });
      const updated = await store.updateGift(gift.id, {
        status: 'settled',
        settledAmount: amount,
        settlementTxHash: txHash,
        updatedAt: now().toISOString(),
      });
      return c.json(toGiftView(updated));
    } finally {
      settling.delete(gift.id);
    }
  });

  // ---- Payouts and holds ---------------------------------------------------

  app.post('/api/payouts/request', async (c) => {
    const body = await jsonBody(c);
    const vendor = reqString(body, 'vendor', 64);
    if (!NEAR_ACCOUNT.test(vendor)) throw new HttpError(400, 'vendor must be a valid NEAR account id');
    const amount = reqAmount(body, 'amount');
    const billId = reqString(body, 'billId', 128);
    const memoRaw = body.memo ?? '';
    if (typeof memoRaw !== 'string' || memoRaw.length > 512) throw new HttpError(400, 'memo must be a string (max 512)');
    const memo = memoRaw;

    if (store.getPayout(billId)) throw new DuplicateBillIdError(billId);
    // Signed with the agent's function-call key (request_payout only). The contract enforces policy.
    const result = await near.requestPayout({ vendor, amount, billId, memo });
    const ts = now().toISOString();
    await store.upsertPayout({ billId, vendor, amount, memo, status: result.status, createdAt: ts, updatedAt: ts });
    return c.json({ billId, status: result.status, vendor, amount });
  });

  app.get('/api/payouts', (c) => {
    const payouts = store.listPayouts().filter((p) => p.status === 'paid').map(payoutView);
    return c.json({ payouts });
  });

  app.get('/api/holds', async (c) => {
    const status = c.req.query('status');
    if (status !== undefined && !HOLD_STATUSES.includes(status as HoldStatus)) {
      throw new HttpError(400, `status must be one of ${HOLD_STATUSES.join(', ')}`);
    }
    const holds = await near.listHolds(status as HoldStatus | undefined);
    return c.json({ holds });
  });

  async function resolveHold(c: Context, action: 'approve' | 'reject') {
    const billId = c.req.param('billId');
    if (!billId) throw new HttpError(400, 'billId is required');
    if (action === 'approve') await near.approveHold(billId);
    else await near.rejectHold(billId);

    const hold = await near.getHold(billId).catch(() => null);
    const local = store.getPayout(billId);
    const ts = now().toISOString();
    const base = local ?? (hold ? { billId, vendor: hold.vendor, amount: hold.amount, memo: hold.memo, createdAt: ts } : null);
    if (base) {
      await store.upsertPayout({ ...base, status: action === 'approve' ? 'paid' : 'rejected', updatedAt: ts });
    }
    return c.json({ billId, status: action === 'approve' ? 'approved' : 'rejected', hold });
  }

  app.post('/api/holds/:billId/approve', (c) => resolveHold(c, 'approve'));
  app.post('/api/holds/:billId/reject', (c) => resolveHold(c, 'reject'));

  // ---- Summary and export --------------------------------------------------

  app.get('/api/summary', async (c) => {
    const gifts = store.listGifts();
    const giftsByFund = Object.fromEntries(
      FUNDS.map((f) => {
        const settled = gifts.filter((g) => g.fund === f && g.status === 'settled');
        return [f, { settledAmount: sumAmounts(settled.map((g) => g.settledAmount)), count: settled.length }];
      }),
    );
    const paid = store.listPayouts().filter((p) => p.status === 'paid');
    let holds: { heldCount: number; heldAmount: string; available?: false };
    try {
      const held: HoldView[] = await near.listHolds('held');
      holds = { heldCount: held.length, heldAmount: sumAmounts(held.map((h) => h.amount)) };
    } catch (err) {
      if (!(err instanceof NearUnavailableError)) throw err;
      holds = { heldCount: 0, heldAmount: '0', available: false };
    }
    return c.json({
      giftsByFund,
      payouts: { paidCount: paid.length, paidAmount: sumAmounts(paid.map((p) => p.amount)) },
      holds,
      receiptNote: RECEIPT_NOTE,
    });
  });

  app.get('/api/export.csv', (c) => {
    const header = ['type', 'id', 'created_at', 'updated_at', 'fund', 'donor', 'vendor', 'amount_in', 'origin_asset', 'amount_usdc', 'status', 'deposit_address', 'memo'];
    const rows: unknown[][] = [];
    for (const g of store.listGifts()) {
      rows.push(['gift', g.id, g.createdAt, g.updatedAt, g.fund, g.donor, '', g.amountIn, g.originAsset, g.settledAmount ?? g.amountOut, g.status, g.depositAddress, '']);
    }
    for (const p of store.listPayouts()) {
      rows.push(['payout', p.billId, p.createdAt, p.updatedAt, '', '', p.vendor, '', '', p.amount, p.status, '', p.memo]);
    }
    const lines = [`# ${RECEIPT_NOTE}`, header.join(','), ...rows.map((r) => r.map(csvCell).join(','))];
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', 'attachment; filename="openlid-export.csv"');
    return c.body(lines.join('\n') + '\n');
  });

  return app;
}
