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
  /** "dry_run" in the testnet demo: no real deposit address, settlement is simulated. */
  quoteMode?: string;
  receiptNote: string;
}

export interface PayoutView {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  fund: Fund;
  status: "paid";
}

export interface HoldView {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  fund: Fund;
  status: "held" | "approved" | "rejected";
}

/** Per-fund summary. `available = received - paidOut`; outstanding holds do not reduce it. */
export interface FundSummary {
  /** Settled gift count. */
  count: number;
  /** Settled gift amounts. */
  received: string;
  /** Paid payouts from this fund. */
  paidOut: string;
  /** Outstanding (held) holds on this fund. */
  held: string;
  available: string;
}

export interface Summary {
  giftsByFund: Record<Fund, FundSummary>;
  /** Live on-chain treasury balance; null when the API can't read it. */
  treasuryBalance?: string | null;
  payouts: { paidCount: number; paidAmount: string };
  holds: { heldCount: number; heldAmount: string };
  receiptNote: string;
}

export const RECEIPT_NOTE = "demo, not a tax document";

export const TESTNET_NOTICE =
  "NEAR testnet only. The cross-chain leg is a dry-run 1Click quote plus a simulated settlement on NEAR testnet. No real funds.";

/** Deposit addresses the API assigns when a dry-run quote has none. */
export const isSimulatedAddress = (addr: string) => addr.startsWith("sim:");
