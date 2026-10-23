// Shared fake-chain harness for the feed tests: a Replay and a FeedService over an in-memory state, posts recorded
// as rounds the way App.post records them.
import { expect } from 'bun:test';
import { FeedService } from '../src/feed';
import { DAY, Replay, type ReplaySeries, type RoundPost, type TickResult } from '../src/replay';
import { emptyState, pushRound, type StateData, type TicketRec } from '../src/store';

export const D = 1791811800; // 2026-10-12 13:30 UTC, a recorded session open
export const tod = (t: number) => ((t % DAY) + DAY) % DAY;
export const hm = (h: number, m: number) => h * 3600 + m * 60;

/** `days` recorded sessions of 78 five-minute bars (13:30 to 19:55 UTC); price of symbol k at bar j is
 *  100 * (k + 1) + j, LATE has no trades in its first 10 bars (leading nulls). */
export function sessions(days = 3, syms = ['NVDA', 'AAPL', 'XYZ', 'LATE']): ReplaySeries {
  const t: number[] = [];
  for (let d = 0; d < days; d++) for (let i = 0; i < 78; i++) t.push(D + d * DAY + i * 300);
  const prices: Record<string, (number | null)[]> = {};
  syms.forEach((s, k) => {
    prices[s] = t.map((_, j) => (s === 'LATE' && j < 10 ? null : 100 * (k + 1) + j));
  });
  if (prices.LATE) {
    const last = prices.LATE[t.length - 1]!;
    prices.LATE = prices.LATE.map((x) => (x === null ? last : x));
  }
  return { bar: 300, t, prices, source: 'test', fetchedAt: 0 };
}

export interface Harness {
  s: ReplaySeries;
  data: StateData;
  feed: FeedService;
  replay: Replay;
  chain: { t: number; posts: (RoundPost & { close: boolean })[] };
  wall: { ms: number };
  core: string[];
  tick(durMs?: number): Promise<TickResult>;
  ticket(id: string, symbol: string, expiry: number, extra?: Partial<TicketRec>): TicketRec;
}

export function harness(o: { start: number; s?: ReplaySeries; series?: () => ReplaySeries; core?: string[]; listed?: string[]; drift?: number; speed?: number; timelinePath?: string | null } = { start: D }): Harness {
  const s = o.s ?? sessions();
  const series = o.series ?? (() => s);
  const data = emptyState();
  for (const sym of o.listed ?? Object.keys(s.prices)) data.markets[sym] = { symbol: sym, reference: '', maxLeverage: 20, maxStake: '1', oiCap: '1', maxStaleness: 86400, listedBlock: 1 };
  const chain = { t: o.start, posts: [] as (RoundPost & { close: boolean })[] };
  const wall = { ms: 1_000_000 };
  const core = o.core ?? ['NVDA'];
  let closing = false;
  const replay: Replay = new Replay({
    now: async () => chain.t,
    advance: async (sec) => {
      chain.t += sec + (o.drift ?? 0);
      return chain.t;
    },
    post: async (rows) => {
      for (const r of rows) {
        expect(r.t).toBe(chain.t);
        chain.posts.push({ ...r, close: closing });
        pushRound(data, r.symbol, { t: r.t, price8: r.price8.toString() });
      }
    },
    markets: () => Object.keys(data.markets),
    printSet: (at, close) => {
      closing = close;
      return feed.printSet(at, close);
    },
    series,
    closeHourUtc: 21,
  });
  const feed = new FeedService({
    series,
    data: () => data,
    listed: () => Object.keys(data.markets),
    core: () => core,
    catalog: () => [...Object.keys(s.prices), 'NODATA'],
    cursor: (x, clock) => (x ? replay.cursorIn(x, clock) : replay.cursor),
    speed: () => o.speed ?? 60,
    paused: () => false,
    frozen: () => true,
    closeHourUtc: 21,
    timelinePath: o.timelinePath ?? null,
    nowMs: () => wall.ms,
  });
  const ms = 60_000 / (o.speed ?? 60);
  return {
    s,
    data,
    feed,
    replay,
    chain,
    wall,
    core,
    async tick(durMs = 0) {
      const started = wall.ms;
      const r = await replay.step();
      feed.onTick(r, started, durMs);
      wall.ms += ms;
      return r;
    },
    ticket(id, symbol, expiry, extra = {}) {
      const t: TicketRec = { id, owner: '0xabc', symbol, long: true, leverage: 5, stake: '100000000', entryPrice8: '10000000000', expiry, openedAt: 0, openTx: '0x', openBlock: 1, status: 'open', ...extra };
      data.tickets[id] = t;
      return t;
    },
  };
}
