// The ticket's payout math, mirrored from the TicketBook (docs/INTERFACES.md): fee = stake * feeBps / 10000 to the
// vault, net = stake - fee, r = (settle - entry) / entry signed by side, payout = net * clamp(1 + L * r, 0, L) in 1e18
// fixed point. The loss stops at the stake; the win stops at net * L. Pure: bun test drives it.
// The site's only leverage constants. No 1x: at L = 1 the cap clamp(1 + r, 0, 1) is 1, so a 1x ticket can never pay
// more than its net stake (docs/DECISIONS.md, contracts line of 2026-10-18).
export const MULTIPLES = [2, 5, 10, 20] as const;
export type Multiple = (typeof MULTIPLES)[number];
export const QUICK_STAKES = [5, 20, 50, 100] as const;
export const DEFAULT_STAKE = 20;
export const DEFAULT_MULTIPLE: Multiple = 5;

const E18 = 10n ** 18n;

/** The contract's arithmetic on raw units (USDG 6 decimals, prices 8 decimals). */
export function payoutRaw(net: bigint, leverage: number, entry8: bigint, settle8: bigint, long: boolean): bigint {
  if (entry8 <= 0n || net <= 0n) return 0n;
  let r = ((settle8 - entry8) * E18) / entry8;
  if (!long) r = -r;
  const L = BigInt(leverage);
  let f = E18 + L * r;
  if (f < 0n) f = 0n;
  if (f > L * E18) f = L * E18;
  return (net * f) / E18;
}

export function feeRaw(stake: bigint, feeBps: number): bigint {
  return (stake * BigInt(feeBps)) / 10000n;
}

export interface Preview {
  stake: number;
  fee: number;
  net: number;
  /** net * L, the cap. */
  maxPayout: number;
  /** The whole stake (fee included). */
  maxLoss: number;
}

/** The live line of the ticket sheet, in USDG: the fee and the net in the contract's raw units (feeRaw on the 6-decimal
 * stake), so a small stake's fee is not truncated to four decimals. */
export function preview(stake: number, leverage: number, feeBps: number): Preview {
  const s = Number.isFinite(stake) && stake > 0 ? stake : 0;
  const raw = BigInt(Math.round(s * 1e6));
  const feeR = feeRaw(raw, Number.isFinite(feeBps) && feeBps > 0 ? Math.floor(feeBps) : 0);
  const fee = Number(feeR) / 1e6;
  const net = Number(raw - feeR) / 1e6;
  return { stake: s, fee: round6(fee), net: round6(net), maxPayout: round6(net * leverage), maxLoss: round6(s) };
}

/** Payout at a reference price, in USDG (float mirror of payoutRaw for the meter). */
export function payoutAt(net: number, leverage: number, entry: number, price: number, long: boolean): number {
  if (!(entry > 0) || !(net > 0) || !Number.isFinite(price)) return 0;
  const r = ((price - entry) / entry) * (long ? 1 : -1);
  return round6(net * Math.min(leverage, Math.max(0, 1 + leverage * r)));
}

/** Move of the reference from entry in percent, signed by price (not by side). */
export function movePct(entry: number, price: number): number {
  return entry > 0 ? (price / entry - 1) * 100 : 0;
}

/** Fill of the payout meter, 0 to 1 of the cap. */
export function meterFill(payout: number, cap: number): number {
  return cap > 0 ? Math.min(1, Math.max(0, payout / cap)) : 0;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Parse a stake field: digits and one decimal point, at most 6 decimals; NaN otherwise. */
export function parseStake(s: string): number {
  const t = s.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return NaN;
  return Number(t);
}

// ---------- price levels of a ticket (the ticker page's summary rows and chart preview lines) ----------
// Moves are fractions of the entry price, signed by price (not by side): a long breaks even above its entry, a short
// below. From payout = net * clamp(1 + L * r, 0, L) with r the side-signed move.

/** Move at which the payout equals the stake (fee included): r = (stake / net - 1) / L. */
export function breakEvenMove(stake: number, net: number, leverage: number, long: boolean): number {
  if (!(net > 0) || !(leverage > 0)) return 0;
  const r = (stake / net - 1) / leverage;
  return long ? r : -r;
}

/** Move at which the payout reaches 0 and stays there: r = -1 / L (the liquidation-price analogue). */
export function paysNothingMove(leverage: number, long: boolean): number {
  if (!(leverage > 0)) return 0;
  return long ? -1 / leverage : 1 / leverage;
}

/** Move at which the payout reaches the cap net * L: r = (L - 1) / L. */
export function maxPayoutMove(leverage: number, long: boolean): number {
  if (!(leverage > 0)) return 0;
  const r = (leverage - 1) / leverage;
  return long ? r : -r;
}

/** The reference price at a move from entry. */
export function priceAtMove(entry: number, move: number): number {
  return entry * (1 + move);
}
