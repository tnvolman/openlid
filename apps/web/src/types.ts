// Shapes from INTERFACES.md (HTTP API section). Amounts are USDC atomic
// units (6 decimals) as decimal integer strings.

export const FUNDS = ["general", "missions", "building"] as const;
export type Fund = (typeof FUNDS)[number];

/**
 * Net-asset class labels in current US GAAP wording. A label only: every fund is siloed and pays only bills
 * tagged to it; general money cannot pay a missions or building bill (that would be an interfund transfer,
 * which this demo does not have).
 */
export type FundRestriction = "with donor restrictions" | "without donor restrictions";
export const FUND_RESTRICTION: Record<Fund, FundRestriction> = {
  general: "without donor restrictions",
  missions: "with donor restrictions",
  building: "with donor restrictions",
};

export const FUND_SILO_NOTE =
  "Each fund pays only the bills tagged to it. General is without donor restrictions, but it still cannot pay a missions or building bill: that would be an interfund transfer, which this demo does not have.";

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

/** Audit-trail fields the API adds to payout and hold rows (null when unknown). ISO 8601 UTC times. */
export interface AuditFields {
  requestedAt?: string | null;
  paidAt?: string | null;
  /** NEAR tx that paid the bill (request_payout for auto-pay, approve_hold for a hold). */
  paymentTxHash?: string | null;
  requestTxHash?: string | null;
}

export interface PayoutView extends AuditFields {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  fund: Fund;
  status: "paid";
}

export interface HoldView extends AuditFields {
  bill_id: string;
  vendor: string;
  amount: string;
  memo: string;
  fund: Fund;
  status: "held" | "approved" | "rejected";
}

/** Per-fund summary. `available = received - paidOut - held` (uncommitted); outstanding holds are reserved. */
export interface FundSummary {
  restriction: FundRestriction;
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

/** Live cash vs the sum of fund ledgers (received - paid = available + held). */
export interface Reconciliation {
  cash: string | null;
  ledgerTotal: string;
  ledgerSource: "chain" | "api";
  difference: string | null;
  status: "match" | "mismatch" | "unknown";
}

export interface Summary {
  giftsByFund: Record<Fund, FundSummary>;
  /** Live on-chain treasury balance; null when the API can't read it. */
  treasuryBalance?: string | null;
  reconciliation?: Reconciliation;
  payouts: { paidCount: number; paidAmount: string };
  holds: { heldCount: number; heldAmount: string };
  receiptNote: string;
}

export const RECEIPT_NOTE = "demo, not a tax document";

/** Scope boundaries, visible on the page (index.html). The CSV header repeats all but the 3rd and 4th. */
export const BOUNDARY_LINES = [
  "This is not a contemporaneous written acknowledgment or year-end giving statement under IRS Publication 1771.",
  "This is not GAAP financial statements and not an audit, review, or compilation. Testnet only; no real funds.",
  "In this demo, approve/reject is unauthenticated and the server signs as owner; production would be a hardware wallet or multisig.",
  "This demo covers fund-tagged gifts and bills. It does not cover interfund transfers, budgets, pledges, or tax receipts.",
  // D9: noncash property; book value at receipt, not a deductible value.
  "Gifts of USDC or other digital assets are noncash property, not cash. Amounts shown are book value at receipt (church books only, as of the date and time received), not a deductible value. This is not a noncash acknowledgment and does not state fair market value; Forms 8283 and 8282 and any appraisal are out of scope and are the donor's or church's later tax job if they apply. A CPA must confirm current rules.",
  // D10: no custody; legal review before real money.
  "OpenLid never holds or moves donor funds for someone else: gifts go to a treasury the church controls. A legal review is required before any real money. This demo is testnet only; no real funds.",
] as const;

/** Shown under the cash-vs-ledger line, always. */
export const RECON_NOTE =
  "Fund credits are entered by the owner and are not checked against the tokens received on NEAR testnet; this cash-vs-ledger line is the check.";

/** Label for every USD/USDC amount on the page and in the CSV. */
export const BOOK_VALUE_LABEL = "book value at receipt";
export const AMOUNT_CAPTION = "USDC amounts are book value at receipt (church books only), not a deductible value.";

export const TESTNET_NOTICE =
  "NEAR testnet only. The cross-chain leg is a dry-run 1Click quote plus a simulated settlement on NEAR testnet. No real funds.";

/** Deposit addresses the API assigns when a dry-run quote has none. */
export const isSimulatedAddress = (addr: string) => addr.startsWith("sim:");
