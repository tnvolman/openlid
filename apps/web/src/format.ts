import { FUNDS } from "./types.ts";
import type { Fund, Gift } from "./types.ts";

const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;

/** Format a USDC atomic-unit integer string as "1,234.50 USDC" (2 decimal places). */
export function formatUsdc(atomic: string | undefined | null): string {
  if (atomic == null || !/^\d+$/.test(atomic)) return "—";
  const v = BigInt(atomic);
  const whole = (v / USDC_SCALE).toLocaleString("en-US");
  const frac = (v % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), "0").slice(0, 2);
  return `${whole}.${frac} USDC`;
}

/** Full 6-decimal precision, for title tooltips: "1,234.500000 USDC". */
export function formatUsdcPrecise(atomic: string | undefined | null): string {
  if (atomic == null || !/^\d+$/.test(atomic)) return "—";
  const v = BigInt(atomic);
  const whole = (v / USDC_SCALE).toLocaleString("en-US");
  const frac = (v % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), "0");
  return `${whole}.${frac} USDC`;
}

/** Title-case a fund tag: "missions" → "Missions". */
export function formatFund(fund: string | null | undefined): string {
  if (!fund) return "";
  return fund.charAt(0).toUpperCase() + fund.slice(1);
}

/**
 * Group gifts by fund, preserving API order (newest first) inside each fund.
 * All three funds are always present. Every status is kept, including
 * refunded and failed. Unknown fund tags land in `other` rather than vanish.
 */
export function groupGiftsByFund(gifts: Gift[]): Record<Fund, Gift[]> & { other: Gift[] } {
  const groups = { general: [], missions: [], building: [], other: [] } as Record<Fund, Gift[]> & {
    other: Gift[];
  };
  for (const g of gifts) {
    if ((FUNDS as readonly string[]).includes(g.fund)) groups[g.fund].push(g);
    else groups.other.push(g);
  }
  return groups;
}

/** Count gifts per status, e.g. { settled: 2, refunded: 1 }. */
export function countByStatus(gifts: Gift[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of gifts) out[g.status] = (out[g.status] ?? 0) + 1;
  return out;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO 8601 timestamp as a short UTC display, e.g. "11 Nov 14:05 UTC"; "—" when missing or unparseable. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = utcParts(iso);
  if (!parts) return "—";
  return `${parts.day} ${parts.mon} ${parts.hh}:${parts.mm} UTC`;
}

/** Date only in UTC, e.g. "11 Nov". Used in the Requested column at 1280; the time stays in a tooltip. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = utcParts(iso);
  if (!parts) return "—";
  return `${parts.day} ${parts.mon}`;
}

function utcParts(iso: string): { day: number; mon: string; hh: string; mm: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    day: d.getUTCDate(),
    mon: MONTHS[d.getUTCMonth()]!,
    hh: String(d.getUTCHours()).padStart(2, "0"),
    mm: String(d.getUTCMinutes()).padStart(2, "0"),
  };
}

/** Signed atomic-unit difference as USDC, e.g. "-9.95 USDC". */
export function formatSignedUsdc(atomic: string): string {
  return atomic.startsWith("-") ? `-${formatUsdc(atomic.slice(1))}` : formatUsdc(atomic);
}

const INSUFFICIENT_FUND = /insufficient fund balance: (\w+) has (\d+) available, bill needs (\d+)/;

/**
 * Turn an API error into treasurer-readable text. The contract's insufficient-fund panic carries
 * atomic units; show them as USDC and name the fund. Other messages pass through unchanged.
 */
export function friendlyError(message: string): string {
  const m = INSUFFICIENT_FUND.exec(message);
  if (!m) return message;
  const [, fund, avail, needed] = m;
  return `Not enough in the ${formatFund(fund)} fund: ${formatUsdc(avail)} available, this bill needs ${formatUsdc(needed)}. Other funds cannot pay it.`;
}
