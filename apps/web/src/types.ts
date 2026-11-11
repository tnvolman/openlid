// Shapes from INTERFACES.md (HTTP API section). Amounts are USDC atomic
// units (6 decimals) as decimal integer strings.

export const FUNDS = ["general", "missions", "building"] as const;
export type Fund = (typeof FUNDS)[number];

export type GiftStatus = "pending_deposit" | "processing" | "settled" | "refunded" | "failed";

export interface Gift {
  id: string;
  donor: string;
  fund: Fund;
  depositAddress: string;
  depositMemo: string | null;
  correlationId: string;
  amountIn: string;
  amountOut: string;
  originAsset: string;
  status: GiftStatus;
  receiptNote: string;
}

export interface PayoutView {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  status: "paid";
}

export interface HoldView {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  status: "held" | "approved" | "rejected";
}

export interface FundSummary {
  settledAmount: string;
  count: number;
}

export interface Summary {
  giftsByFund: Record<Fund, FundSummary>;
  payouts: { paidCount: number; paidAmount: string };
  holds: { heldCount: number; heldAmount: string };
  receiptNote: string;
}

export const RECEIPT_NOTE = "demo, not a tax document";
