// GET /markets rows: one per catalog symbol, the playground price and session from the feed, the on-chain market
// parameters, and the open interest, exposure and 24 h volume from the ticket index. USDG amounts are raw 6-decimal
// integer strings (Raw suffix), prices numbers, times fork unix seconds.
import type { SymbolNow } from '../feed/types';
import { DAY_S, expiryFor } from '../math';
import type { MarketRec, Round, StateData } from '../store';
import type { TicketIndex } from './ticket-index';

export interface MarketRow {
  symbol: string;
  listed: boolean;
  covered: boolean;
  /** Listed on chain and priced by the feed: a ticket can be opened (after a warm print when not hot). */
  tradable: boolean;
  /** In the feed's print set right now (core or warm): posted every tick. */
  hot: boolean;
  price: number | null;
  prevClose: number | null;
  /** Move since the session open as a fraction (price / sessionOpen - 1); prevClose when there is no open. */
  chg: number | null;
  sessionOpen: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  spark: number[];
  openCount: number;
  /** Gross stake of the open tickets (TicketBook markets(symbol).oi). */
  oiRaw: string;
  longOpenRaw: string;
  shortOpenRaw: string;
  oiCapRaw: string;
  maxStakeRaw: string;
  maxLeverage: number;
  /** Gross stake opened in the last 86,400 fork seconds. */
  volume24hRaw: string;
  lastRound: { t: number; price8: string } | null;
}

/** One bar of the recording on the playground clock. */
export const BAR_S = 300;

export function chgOf(n: SymbolNow | null): number | null {
  if (!n || n.price === null) return null;
  const base = n.sessionOpen ?? n.prevClose;
  return base ? n.price / base - 1 : null;
}

export function lastRoundOf(d: StateData, symbol: string): Round | null {
  const r = d.rounds[symbol];
  return r?.length ? r[r.length - 1]! : null;
}

export function marketRow(d: StateData, ix: TicketIndex, symbol: string, n: SymbolNow | null, clock: number | null, hot: Set<string>): MarketRow {
  const m: MarketRec | undefined = d.markets[symbol];
  const s = ix.bySymbol.get(symbol);
  const covered = !!n?.covered && n.price !== null;
  const lr = lastRoundOf(d, symbol);
  const longOpen = s?.longOpen ?? 0n;
  const shortOpen = s?.shortOpen ?? 0n;
  return {
    symbol,
    listed: !!m,
    covered,
    tradable: !!m && covered,
    hot: hot.has(symbol),
    price: n?.price ?? null,
    prevClose: n?.prevClose ?? null,
    chg: chgOf(n),
    sessionOpen: n?.sessionOpen ?? null,
    sessionHigh: n?.sessionHigh ?? null,
    sessionLow: n?.sessionLow ?? null,
    spark: n?.spark ?? [],
    openCount: s?.open.size ?? 0,
    oiRaw: (longOpen + shortOpen).toString(),
    longOpenRaw: longOpen.toString(),
    shortOpenRaw: shortOpen.toString(),
    oiCapRaw: m?.oiCap ?? '0',
    maxStakeRaw: m?.maxStake ?? '0',
    maxLeverage: m?.maxLeverage ?? 0,
    volume24hRaw: clock === null ? '0' : ix.volumeSince(symbol, clock - DAY_S).toString(),
    lastRound: lr ? { t: lr.t, price8: lr.price8 } : null,
  };
}

/** Expiries a ticket opened at `clock` gets per horizon (TicketBook.expiryFor). */
export function expiriesAt(clock: number): { session: number; day: number; week: number } {
  return { session: expiryFor(0, clock), day: expiryFor(1, clock), week: expiryFor(2, clock) };
}

/** lastRound within one bar of the clock: the symbol is being printed and an open is priced at the playground price. */
export function isFresh(lr: { t: number } | null, clock: number | null): boolean {
  return !!lr && clock !== null && clock - lr.t <= BAR_S;
}
