// Payout and points math (mirrors TicketBook.settle in docs/INTERFACES.md) and symbol encoding.
import { hexToString, stringToHex, type Hex } from 'viem';

export const ONE = 10n ** 18n;

/** Symbols are bytes32 of the catalog ticker, ASCII, right padded with zeros. */
export function symbolToBytes32(s: string): Hex {
  if (!/^[\x20-\x7e]{1,32}$/.test(s)) throw new Error(`bad symbol ${s}`);
  return stringToHex(s, { size: 32 });
}
export function bytes32ToSymbol(h: Hex): string {
  return hexToString(h, { size: 32 }).replace(/\0+$/, '');
}

export function feeOf(stake: bigint, feeBps: bigint): bigint {
  return (stake * feeBps) / 10_000n;
}

/** Multiplier in 1e18: clamp(1 + leverage * r, 0, leverage), r = (settle - entry) / entry signed by side.
 *  Mirrors TicketBook.multiplierFor: the leverage is applied before the division, a gain is floored, a loss is ceiled. */
export function multiplier(long: boolean, leverage: number, entry8: bigint, settle8: bigint): bigint {
  if (entry8 <= 0n) throw new Error('entry price must be positive');
  const cap = BigInt(leverage) * ONE;
  const up = settle8 >= entry8;
  const diff = up ? settle8 - entry8 : entry8 - settle8;
  if (up === long || diff === 0n) {
    const m = ONE + (diff * cap) / entry8;
    return m > cap ? cap : m;
  }
  const loss = (diff * cap + entry8 - 1n) / entry8;
  return loss >= ONE ? 0n : ONE - loss;
}

/** Payout of a ticket: net stake (stake minus fee) times the clamped multiplier. */
export function payoutOf(netStake: bigint, long: boolean, leverage: number, entry8: bigint, settle8: bigint): bigint {
  return (netStake * multiplier(long, leverage, entry8, settle8)) / ONE;
}

/** Worst case booked against the vault at open: net stake times leverage. */
export function reserveOf(netStake: bigint, leverage: number): bigint {
  return netStake * BigInt(leverage);
}

export const POINTS_PER_SETTLED = 10;
export const POINTS_PER_WIN = 25;

export interface SettledTicketLike {
  owner: string;
  stake: bigint;
  payout: bigint;
}
export interface LeaderRow {
  address: string;
  points: number;
  settled: number;
  wins: number;
  /** Net pnl in raw USDG (6 decimals), payouts minus stakes, as a string. */
  pnlRaw: string;
  pnl: number;
  /** Sum of the gross stakes of the settled tickets, raw (6 decimals) and in USDG; the site ranks by pnl / staked. */
  stakedRaw: string;
  staked: number;
}

/** A win is a payout above the stake paid in (the fee counts as cost). */
export function isWin(t: { stake: bigint; payout: bigint }): boolean {
  return t.payout > t.stake;
}

/** Per-address settled totals behind a leaderboard row. */
export interface LeaderAgg {
  points: number;
  settled: number;
  wins: number;
  pnl: bigint;
  staked: bigint;
}

/** Adds (sign 1) or removes (sign -1) one settled ticket to an address's totals. */
export function addSettled(e: LeaderAgg, t: { stake: bigint; payout: bigint }, sign: 1 | -1 = 1): void {
  e.settled += sign;
  e.points += sign * POINTS_PER_SETTLED;
  if (isWin(t)) {
    e.wins += sign;
    e.points += sign * POINTS_PER_WIN;
  }
  e.pnl += BigInt(sign) * (t.payout - t.stake);
  e.staked += BigInt(sign) * t.stake;
}

/** Leaderboard rows from per-address totals, in points order (then pnl, then address). */
export function leaderRows(m: Iterable<[string, LeaderAgg]>, decimals = 6): LeaderRow[] {
  const scale = 10 ** decimals;
  const out: LeaderRow[] = [];
  for (const [address, e] of m) {
    if (e.settled <= 0) continue;
    out.push({ address, points: e.points, settled: e.settled, wins: e.wins, pnlRaw: e.pnl.toString(), pnl: Number(e.pnl) / scale, stakedRaw: e.staked.toString(), staked: Number(e.staked) / scale });
  }
  return out.sort((a, b) => b.points - a.points || (BigInt(b.pnlRaw) > BigInt(a.pnlRaw) ? 1 : BigInt(b.pnlRaw) < BigInt(a.pnlRaw) ? -1 : 0) || a.address.localeCompare(b.address));
}

export function leaderboard(settled: SettledTicketLike[], decimals = 6): LeaderRow[] {
  const m = new Map<string, LeaderAgg>();
  for (const t of settled) {
    const k = t.owner.toLowerCase();
    const e = m.get(k) ?? { points: 0, settled: 0, wins: 0, pnl: 0n, staked: 0n };
    addSettled(e, t);
    m.set(k, e);
  }
  return leaderRows(m, decimals);
}

/** Minimum settled gross stake to be ranked (100 USDG raw, 6 decimals); the site shows the same floor. */
export const LEADER_MIN_STAKED_RAW = 100_000_000n;

/** Leaderboard order: addresses at or above the minimum settled stake by realized ROI (pnl / staked) descending,
 *  then the rest in points order, so a cap taken afterwards never drops a ranked address for a busier one. */
export function rankByRoi(rows: LeaderRow[], minStakedRaw: bigint): LeaderRow[] {
  const ok = (r: LeaderRow) => BigInt(r.stakedRaw) >= minStakedRaw && BigInt(r.stakedRaw) > 0n;
  const ranked = rows.filter(ok).sort((a, b) => {
    // pnlA / stakedA vs pnlB / stakedB without division (both stakes positive)
    const l = BigInt(b.pnlRaw) * BigInt(a.stakedRaw);
    const r = BigInt(a.pnlRaw) * BigInt(b.stakedRaw);
    return l > r ? 1 : l < r ? -1 : b.points - a.points || a.address.localeCompare(b.address);
  });
  return [...ranked, ...rows.filter((r) => !ok(r))];
}

// ---------------------------------------------------------------- horizons (TicketBook.expiryFor)
export const HOUR = 3600;
export const DAY_S = 86_400;
/** TicketBook.SESSION_CLOSE: the session horizon ends at 21:00 UTC. */
export const SESSION_CLOSE_S = 21 * HOUR;
export type HorizonName = 'session' | 'day' | 'week';
export const HORIZONS: readonly HorizonName[] = ['session', 'day', 'week'];

const ceilHour = (x: number) => Math.ceil(x / HOUR) * HOUR;

/** Expiry of a ticket opened at `nowTs` with horizon 0 (session), 1 (day) or 2 (week); mirrors TicketBook.expiryFor. */
export function expiryFor(horizon: 0 | 1 | 2, nowTs: number): number {
  if (horizon === 0) {
    const e = nowTs - (nowTs % DAY_S) + SESSION_CLOSE_S;
    return e > nowTs ? e : e + DAY_S;
  }
  return ceilHour(nowTs + (horizon === 1 ? DAY_S : 7 * DAY_S));
}

/** A replay price (a number) as the 8-decimal integer the signer posts. */
export function toPrice8(price: number): bigint {
  return BigInt(Math.round(price * 1e8));
}
