// React hooks of the ticker page: the market row (polled), the ticket lists of the tabs, the warm keep-alive, a media
// query, and the ticket draft shared by the desktop panel, the phone sheet and the chart's preview lines.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_MULTIPLE, DEFAULT_STAKE } from '../payout';
import { printFresh, tickerApi, type TickerMarket, type TickerTicket } from './ticker-api';

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Run `fn` now and every `ms` while the page is visible (and once more when it becomes visible again). */
function useVisibleInterval(fn: () => void, ms: number, deps: readonly unknown[]): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const t = setInterval(() => visible() && ref.current(), ms);
    const on = () => visible() && ref.current();
    document.addEventListener('visibilitychange', on);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', on);
    };
  }, [ms, ...deps]);
}

export interface MarketState { market: TickerMarket | null; loaded: boolean; failed: boolean; reload: () => void }

/** A market that was ready this recently (wall ms) stays ready: the replay's nightly jump leaves the last print at the
 * 21:00 re-post until the next session's first print lands about one tick later. */
export const READY_GRACE_MS = 8000;

/** Whether a ticket can open on `m`: its print is fresh, or it was within READY_GRACE_MS of `nowMs`. */
export function readyOf(m: TickerMarket, lastReadyMs: number | null, nowMs: number): boolean {
  return printFresh(m) || (lastReadyMs !== null && nowMs - lastReadyMs < READY_GRACE_MS);
}

/** GET /markets/:symbol every `ms` (the answer also marks the symbol warm); `epoch` forces a reload after writes. */
export function useTickerMarket(symbol: string | null, epoch = 0, ms = 3000): MarketState {
  const [market, setMarket] = useState<TickerMarket | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const cur = useRef(symbol);
  cur.current = symbol;
  const lastReady = useRef<number | null>(null);
  useEffect(() => {
    setMarket(null);
    setLoaded(false);
    setFailed(false);
    lastReady.current = null;
  }, [symbol]);
  const load = useCallback(() => {
    const s = symbol;
    if (!s) return;
    tickerApi.market(s).then(
      (m) => {
        if (cur.current !== s) return;
        const t = Date.now();
        const ready = m !== null && readyOf(m, lastReady.current, t);
        if (m !== null && printFresh(m)) lastReady.current = t;
        setMarket(m && { ...m, ready });
        setLoaded(true);
        setFailed(false);
      },
      () => {
        if (cur.current !== s) return;
        setLoaded(true);
        setFailed(true);
      },
    );
  }, [symbol]);
  // While the market waits for its first fresh print (a warm), poll every second so Open appears promptly.
  useVisibleInterval(load, market && market.tradable && !market.ready ? 1000 : ms, [load, epoch]);
  return { market, loaded, failed, reload: load };
}

export interface TabsData { yours: TickerTicket[] | null; recent: TickerTicket[] | null; settled: TickerTicket[] | null }

/** The three tab lists: the viewer's tickets on the symbol, recent open tickets, recent settlements. */
export function useTickerTickets(symbol: string | null, owner: string, epoch = 0, ms = 6000): TabsData {
  const [d, setD] = useState<TabsData>({ yours: null, recent: null, settled: null });
  const cur = useRef(`${symbol}|${owner}`);
  cur.current = `${symbol}|${owner}`;
  useEffect(() => setD({ yours: null, recent: null, settled: null }), [symbol, owner]);
  const load = useCallback(() => {
    if (!symbol) return;
    // Answers for a previous symbol or owner arrive after the reset; drop them.
    const key = `${symbol}|${owner}`;
    const keep = (k: keyof TabsData) => (v: TickerTicket[]) => cur.current === key && setD((p) => ({ ...p, [k]: v }));
    const empty = (k: keyof TabsData) => () => cur.current === key && setD((p) => ({ ...p, [k]: p[k] ?? [] }));
    tickerApi.tickets({ symbol, owner, limit: 50 }).then(keep('yours'), empty('yours'));
    tickerApi.tickets({ symbol, status: 'open', limit: 15 }).then(keep('recent'), empty('recent'));
    tickerApi.tickets({ symbol, status: 'settled', limit: 15 }).then(keep('settled'), empty('settled'));
  }, [symbol, owner]);
  useVisibleInterval(load, ms, [load, epoch]);
  return d;
}

/** POST /warm/:symbol on mount and every 30 s while the page is visible, so the symbol stays in the print set. */
export function useWarm(symbol: string | null, enabled: boolean): () => Promise<void> {
  const warm = useCallback(async () => {
    if (!symbol || !enabled) return;
    await tickerApi.warm(symbol).catch(() => undefined);
  }, [symbol, enabled]);
  useVisibleInterval(() => void warm(), 30_000, [warm]);
  return warm;
}

export function useMedia(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(query);
    const h = () => setOn(m.matches);
    h();
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, [query]);
  return on;
}

/** The ticket being drafted: side, multiple, stake text and the chosen settlement (null: follow the default rule). */
export interface Draft {
  long: boolean;
  lev: number;
  stakeStr: string;
  horizon: number | null;
  setLong: (v: boolean) => void;
  setLev: (v: number) => void;
  setStakeStr: (v: string) => void;
  setHorizon: (v: number | null) => void;
}

export function useDraft(side: 'long' | 'short' | null): Draft {
  const [long, setLong] = useState(side !== 'short');
  const [lev, setLev] = useState<number>(DEFAULT_MULTIPLE);
  const [stakeStr, setStakeStr] = useState(String(DEFAULT_STAKE));
  const [horizon, setHorizon] = useState<number | null>(null);
  useEffect(() => {
    if (side) setLong(side === 'long');
  }, [side]);
  return { long, lev, stakeStr, horizon, setLong, setLev, setStakeStr, setHorizon };
}
