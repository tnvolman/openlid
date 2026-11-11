export const RECEIPT_NOTE = 'demo, not a tax document' as const;

/**
 * Scope boundaries shown on the treasurer page; D2 and D3 are repeated in the CSV header.
 * Keep in sync with apps/web/src/types.ts BOUNDARY_LINES.
 */
export const BOUNDARY_PUB_1771 =
  'This is not a contemporaneous written acknowledgment or year-end giving statement under IRS Publication 1771.' as const;
export const BOUNDARY_NOT_GAAP =
  'This is not GAAP financial statements and not an audit, review, or compilation. Testnet only; no real funds.' as const;
export const BOUNDARY_UNAUTHENTICATED =
  'In this demo, approve/reject is unauthenticated and the server signs as owner; production would be a hardware wallet or multisig.' as const;
export const BOUNDARY_SCOPE =
  'This demo covers fund-tagged gifts and bills. It does not cover interfund transfers, budgets, pledges, or tax receipts.' as const;
/** D9: digital-asset gifts are noncash property; USD/USDC figures are book value at receipt, never a deductible value. */
export const BOUNDARY_NONCASH =
  "Gifts of USDC or other digital assets are noncash property, not cash. Amounts shown are book value at receipt (church books only, as of the date and time received), not a deductible value. This is not a noncash acknowledgment and does not state fair market value; Forms 8283 and 8282 and any appraisal are out of scope and are the donor's or church's later tax job if they apply. A CPA must confirm current rules." as const;
/** D10: no custody; legal review before real money. */
export const BOUNDARY_NO_CUSTODY =
  'OpenLid never holds or moves donor funds for someone else: gifts go to a treasury the church controls. A legal review is required before any real money. This demo is testnet only; no real funds.' as const;
/** Label for every USD/USDC amount: church books only, as of the date and time of receipt. */
export const BOOK_VALUE_LABEL = 'book value at receipt' as const;

/** Every quote is a 1Click dry run; no payable deposit address is ever requested. */
export const QUOTE_MODE = 'dry_run' as const;

/** Prefix for API-assigned deposit addresses when the dry quote has none. Not a real chain address. */
export const SIM_ADDRESS_PREFIX = 'sim:';

export function isSimulatedAddress(addr: string): boolean {
  return addr.startsWith(SIM_ADDRESS_PREFIX);
}

export const FUNDS = ['general', 'missions', 'building'] as const;
export type Fund = (typeof FUNDS)[number];

export function isFund(v: unknown): v is Fund {
  return typeof v === 'string' && (FUNDS as readonly string[]).includes(v);
}

/**
 * Net-asset class labels in current US GAAP wording (ASU 2016-14), matching the contract's
 * `fund_restriction`. A label only: every fund is siloed and pays only bills tagged to it, so
 * `general` cannot pay a missions or building bill (that would be an interfund transfer, not built).
 */
export type FundRestriction = 'with donor restrictions' | 'without donor restrictions';
export const FUND_RESTRICTION: Record<Fund, FundRestriction> = {
  general: 'without donor restrictions',
  missions: 'with donor restrictions',
  building: 'with donor restrictions',
};

export type GiftStatus = 'pending_deposit' | 'processing' | 'settled' | 'refunded' | 'failed';

export const ONECLICK_STATUSES = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
  'INCOMPLETE_DEPOSIT',
] as const;
export type OneClickStatus = (typeof ONECLICK_STATUSES)[number];

/** 1Click status -> OpenLid gift status. Failed and refunded are first-class. */
export const STATUS_MAP: Record<OneClickStatus, GiftStatus> = {
  PENDING_DEPOSIT: 'pending_deposit',
  KNOWN_DEPOSIT_TX: 'processing',
  PROCESSING: 'processing',
  INCOMPLETE_DEPOSIT: 'processing',
  SUCCESS: 'settled',
  REFUNDED: 'refunded',
  FAILED: 'failed',
};

/** Persisted gift record. One gift per 1Click quote and per deposit address. */
export interface GiftRecord {
  id: string;
  donor: string;
  fund: Fund;
  originAsset: string;
  refundTo: string;
  depositAddress: string;
  depositMemo: string | null;
  correlationId: string;
  quoteSignature: string;
  quoteTimestamp: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string | null;
  quoteDeadline: string | null;
  status: GiftStatus;
  oneClickStatus: OneClickStatus | null;
  /** USDC (test FT) atomic units credited, once settled. */
  settledAmount: string | null;
  /** Testnet tx hash of the simulated settlement (test FT mint), if any. */
  settlementTxHash?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Gift as returned over HTTP. Excludes internal quote fields and donor refund address. */
export interface GiftView {
  id: string;
  donor: string;
  fund: Fund;
  depositAddress: string;
  /** True when depositAddress is an API-assigned `sim:` address (dry quote had none). */
  depositAddressSimulated: boolean;
  depositMemo: string | null;
  correlationId: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string | null;
  quoteDeadline: string | null;
  originAsset: string;
  status: GiftStatus;
  oneClickStatus: OneClickStatus | null;
  settledAmount: string | null;
  settlementTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  quoteMode: typeof QUOTE_MODE;
  receiptNote: typeof RECEIPT_NOTE;
}

export function toGiftView(g: GiftRecord): GiftView {
  return {
    id: g.id,
    donor: g.donor,
    fund: g.fund,
    depositAddress: g.depositAddress,
    depositAddressSimulated: isSimulatedAddress(g.depositAddress),
    depositMemo: g.depositMemo,
    correlationId: g.correlationId,
    amountIn: g.amountIn,
    amountOut: g.amountOut,
    minAmountOut: g.minAmountOut,
    quoteDeadline: g.quoteDeadline,
    originAsset: g.originAsset,
    status: g.status,
    oneClickStatus: g.oneClickStatus,
    settledAmount: g.settledAmount,
    settlementTxHash: g.settlementTxHash ?? null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    quoteMode: QUOTE_MODE,
    receiptNote: RECEIPT_NOTE,
  };
}

/** Contract views (INTERFACES.md). */
export interface PayoutView {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  fund: Fund;
  status: 'paid';
}

export type HoldStatus = 'held' | 'approved' | 'rejected';
export const HOLD_STATUSES: readonly HoldStatus[] = ['held', 'approved', 'rejected'];

export interface HoldView {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  fund: Fund;
  status: HoldStatus;
}

/** Contract `FundView` (`get_fund_ledger`). `available = received - paid - held`. */
export interface FundLedgerView {
  fund: Fund;
  restriction: FundRestriction;
  received: string;
  paid: string;
  available: string;
  held: string;
}

/** GET /api/payouts row: the contract view plus this API's audit trail (null when unknown). */
export interface PayoutRow extends PayoutView {
  /** When the bill was submitted to POST /api/payouts/request (ISO 8601 UTC). */
  requestedAt: string | null;
  /** When the payment was recorded as paid by this API (ISO 8601 UTC). */
  paidAt: string | null;
  /** NEAR tx hash that paid it: the request_payout tx (auto-pay) or the approve_hold tx. */
  paymentTxHash: string | null;
  /** NEAR tx hash of the request_payout call. */
  requestTxHash: string | null;
}

/** GET /api/holds row: the contract view plus this API's audit trail (null when unknown). */
export interface HoldRow extends HoldView {
  requestedAt: string | null;
  requestTxHash: string | null;
  /** Set once approved: the approve_hold tx and when. */
  paidAt: string | null;
  paymentTxHash: string | null;
}

/** Local record of payout requests this API submitted to the contract. */
export interface PayoutRecord {
  billId: string;
  vendor: string;
  amount: string;
  memo: string;
  fund: Fund;
  status: 'paid' | 'held' | 'rejected';
  createdAt: string;
  updatedAt: string;
  requestTxHash?: string | null;
  paymentTxHash?: string | null;
  paidAt?: string | null;
}

/**
 * Per-fund row of GET /api/summary `giftsByFund`. Amounts are USDC atomic units.
 * `available = received - paidOut - held` (uncommitted): outstanding holds are reserved, as on-chain.
 */
export interface FundSummary {
  restriction: FundRestriction;
  /** Settled gift count. */
  count: number;
  /** Sum of settled gift amounts. */
  received: string;
  /** Sum of paid payouts from this fund. */
  paidOut: string;
  /** Sum of outstanding (`held`) holds on this fund. */
  held: string;
  available: string;
}

/**
 * Cash vs fund ledgers (GET /api/summary `reconciliation`). `cash` is the live on-chain NEP-141 balance of
 * the treasury; `ledgerTotal` is the sum over funds of (received - paid) = sum of (available + held), read
 * from the contract's `get_fund_ledger` when possible (`ledgerSource: "chain"`), else from this API's
 * records (`"api"`). `status` is `mismatch` whenever they differ, `unknown` if cash cannot be read.
 */
export interface Reconciliation {
  cash: string | null;
  ledgerTotal: string;
  ledgerSource: 'chain' | 'api';
  /** cash - ledgerTotal (may be negative), or null when cash is unknown. */
  difference: string | null;
  status: 'match' | 'mismatch' | 'unknown';
}
