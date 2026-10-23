// The routes read prices, candles and the print set from App.feed (services/bell/src/feed, FEED). Until that is
// wired (and in tests that build an App without one) they get a feed that knows no prices: every symbol uncovered,
// no candles, warm refused with no-series, no ETA.
import type { App } from '../app';
import type { Feed } from '../feed/types';
import { DAY_S, SESSION_CLOSE_S } from '../math';

/** Fork ts of the first 21:00 UTC strictly after `ts`. */
export function nextCloseAfter(ts: number, closeS = SESSION_CLOSE_S): number {
  const e = ts - (((ts % DAY_S) + DAY_S) % DAY_S) + closeS;
  return e > ts ? e : e + DAY_S;
}

export function nullFeed(clock: () => number): Feed {
  const empty = new Map();
  return {
    nowAll: () => empty,
    now: () => null,
    candles: () => [],
    warm: () => ({ ok: false, reason: 'no-series' }),
    coverage: () => ({ bars: 0, symbols: 0, eligible: [], missing: [], rule: 'no feed' }),
    etaWall: () => null,
    nextClose: () => nextCloseAfter(clock()),
    status: () => ({ core: [], warm: [], due: [], watchdog: [], rowsLastPost: 0, tickMs: 0, tickP95Ms: 0, source: 'none', frozen: false, lastTickAt: 0 }),
  };
}

const NULL_FEEDS = new WeakMap<App, Feed>();

/** App.feed, or the no-price feed when the app has none. `clock` is the last known fork time. */
export function feedOf(app: App, clock: () => number = () => Math.floor(Date.now() / 1000)): Feed {
  const f = (app as unknown as { feed?: Feed | null }).feed;
  if (f) return f;
  let n = NULL_FEEDS.get(app);
  if (!n) NULL_FEEDS.set(app, (n = nullFeed(clock)));
  return n;
}

export function hasFeed(app: App): boolean {
  return !!(app as unknown as { feed?: Feed | null }).feed;
}
