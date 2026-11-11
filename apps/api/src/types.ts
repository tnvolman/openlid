export const RECEIPT_NOTE = 'demo, not a tax document' as const;

/** Every quote is a 1Click dry run; no payable deposit address is ever requested. */
export const QUOTE_MODE = 'dry_run' as const;

/** Prefix for API-assigned deposit addresses when the dry quote has none. Not a real chain address. */
export const SIM_ADDRESS_PREFIX = 'sim:';

export function isSimulatedAddress(addr: string): boolean {
  return addr.startsWith(SIM_ADDRESS_PREFIX);
}

export const FUNDS = ['general', 'missions', 'building'] as const;
export type Fund = (typeof FUNDS)[number];

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
  status: 'paid';
}

export type HoldStatus = 'held' | 'approved' | 'rejected';
export const HOLD_STATUSES: readonly HoldStatus[] = ['held', 'approved', 'rejected'];

export interface HoldView {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  status: HoldStatus;
}

/** Local record of payout requests this API submitted to the contract. */
export interface PayoutRecord {
  billId: string;
  vendor: string;
  amount: string;
  memo: string;
  status: 'paid' | 'held' | 'rejected';
  createdAt: string;
  updatedAt: string;
}
