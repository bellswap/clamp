import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Timeline, ticksUntil } from '../src/feed/timeline';
import type { Tf } from '../src/feed/types';
import { DAY } from '../src/replay';
import { D, harness, hm, sessions, tod } from './feed-harness';

const START = D + 10 * DAY;
const ceilHour = (t: number) => Math.ceil(t / 3600) * 3600;

describe('timeline candles', () => {
  for (const drift of [0, 2]) {
    test(`every posted non-close round equals its 5m candle close over 300 ticks with a wrap (drift ${drift} s)`, async () => {
      const h = harness({ start: START, core: ['NVDA'], drift });
      for (let k = 0; k < 300; k++) await h.tick(); // 234 bars: wraps once
      expect(h.replay.cursor).toBe(300 - 234);
      const candles = h.feed.candles('NVDA', '5m', 1000);
      const byT = new Map(candles.map((c) => [c.t, c]));
      const posts = h.chain.posts.filter((p) => p.symbol === 'NVDA' && !p.close);
      expect(posts.length).toBe(300);
      for (const p of posts) expect(byT.get(Math.floor(p.t / 300) * 300)?.c).toBe(Number(p.price8) / 1e8);
      expect(candles.at(-1)!.c).toBe(Number(posts.at(-1)!.price8) / 1e8);
      // the 21:00 re-post is not a candle
      const closes = h.chain.posts.filter((p) => p.symbol === 'NVDA' && p.close);
      expect(closes.length).toBeGreaterThanOrEqual(3);
      for (const c of closes) expect(byT.has(Math.floor(c.t / 300) * 300)).toBe(false);
      // o = previous close, h/l = max/min of the two, strictly increasing t
      for (let k = 1; k < candles.length; k++) {
        const c = candles[k]!;
        expect(c.t).toBeGreaterThan(candles[k - 1]!.t);
        expect(c.o).toBe(candles[k - 1]!.c);
        expect(c.h).toBe(Math.max(c.o, c.c));
        expect(c.l).toBe(Math.min(c.o, c.c));
      }
      // a symbol never printed still has candles on the same times, closes from its recorded bars
      const xyz = h.feed.candles('XYZ', '5m', 50);
      expect(xyz.map((c) => c.t)).toEqual(candles.slice(-50).map((c) => c.t));
      expect(xyz.at(-1)!.c).toBe(Number(posts.at(-1)!.price8) / 1e8 + 200); // XYZ = NVDA + 200 at every bar
    });
  }

  test('larger intervals aggregate the 5m candles; the last one carries the latest close', async () => {
    const h = harness({ start: START, core: ['NVDA'] });
    for (let k = 0; k < 100; k++) await h.tick();
    const last = Number(h.chain.posts.filter((p) => p.symbol === 'NVDA' && !p.close).at(-1)!.price8) / 1e8;
    for (const tf of ['15m', '1h', '4h', '1d'] as Tf[]) {
      const cs = h.feed.candles('NVDA', tf, 20);
      expect(cs.length).toBeGreaterThan(1);
      expect(cs.at(-1)!.c).toBe(last);
      for (const c of cs) {
        expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
        expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      }
    }
    const day = h.feed.candles('NVDA', '1d', 5);
    expect(day.length).toBe(5);
    for (const c of day) expect(tod(c.t)).toBe(0);
    const before = h.feed.candles('NVDA', '1h', 10, h.feed.candles('NVDA', '1h', 1)[0]!.t);
    expect(before.length).toBe(10);
    expect(before.at(-1)!.t).toBeLessThan(h.feed.candles('NVDA', '1h', 1)[0]!.t);
  });

  test('backfill before the first tick: 300 candles on the session grid, deterministic, ending at the bar before the cursor', () => {
    const h = harness({ start: START + hm(4, 0) }); // 17:30, off the bar-0 grid
    const a = h.feed.candles('NVDA', '5m', 300);
    expect(a.length).toBe(300);
    for (const c of a) expect(tod(c.t) >= hm(13, 30) && tod(c.t) <= hm(19, 55)).toBe(true);
    expect(a.at(-1)!.c).toBe(100 + 233); // bar n-1 (wrap before bar 0)
    expect(h.feed.candles('NVDA', '5m', 300)).toEqual(a);
    expect(h.feed.candles('NVDA', '1d', 30).length).toBe(30);
    expect(h.feed.candles('NODATA', '5m', 10)).toEqual([]);
  });
});

describe('nowAll', () => {
  test('price is the value the next print carries (contract 3.1); session stats through that bar; prevClose wraps', async () => {
    const h = harness({ start: START, core: ['NVDA'] });
    for (let k = 0; k < 5; k++) await h.tick(); // bars 0 to 4 printed, the cursor stands at bar 5
    const n = h.feed.now('NVDA')!;
    expect(n.price).toBe(105);
    expect(n.barT).toBe(h.chain.t);
    expect(n.sessionOpen).toBe(100);
    expect(n.sessionHigh).toBe(105);
    expect(n.sessionLow).toBe(100);
    expect(n.prevClose).toBe(100 + 233); // the bar before session 0 is the last bar of the series
    expect(n.spark).toEqual([100, 101, 102, 103, 104, 105]);
    expect(n.covered).toBe(true);
    expect(h.feed.now('nodata')).toEqual({ symbol: 'NODATA', covered: false, price: null, barT: h.chain.t, prevClose: null, sessionOpen: null, sessionHigh: null, sessionLow: null, spark: [] });
    expect(h.feed.nowAll().size).toBe(5);
    // the next print carries exactly that price, at that time
    await h.tick();
    const p = h.chain.posts.filter((x) => x.symbol === 'NVDA').at(-1)!;
    expect(Number(p.price8) / 1e8).toBe(n.price!);
    expect(p.t).toBe(n.barT);
    for (let k = 0; k < 80; k++) {
      const before = h.feed.now('NVDA')!;
      await h.tick();
      const q = h.chain.posts.filter((x) => x.symbol === 'NVDA' && !x.close).at(-1)!;
      expect(Number(q.price8) / 1e8).toBe(before.price!);
    }
    const m = h.feed.now('NVDA')!;
    expect(m.spark.length).toBeLessThanOrEqual(80);
    expect(m.prevClose).toBe(100 + 77);
    expect(m.spark.at(-1)).toBe(m.price!);
  });

  test('coverage from the recording: eligible at 0.90 or more', () => {
    const s = { ...sessions(), coverage: { NVDA: 1, AAPL: 0.9, XYZ: 0.8923, LATE: 0.95 } };
    const h = harness({ start: START, s });
    const c = h.feed.coverage();
    expect(c.eligible).toEqual(['NVDA', 'AAPL', 'LATE']);
    expect(c.missing).toEqual(['XYZ', 'NODATA']);
    expect(c.bars).toBe(234);
    expect(c.symbols).toBe(5);
    expect(h.feed.now('XYZ')!.covered).toBe(false);
    expect(h.feed.now('XYZ')!.price).not.toBeNull();
  });
});

describe('etaWall and nextClose', () => {
  test('etaWall is within 2 s of a simulated run for the close, a day and a week ahead', async () => {
    const h = harness({ start: START, core: ['NVDA'] });
    for (let k = 0; k < 7; k++) await h.tick(120);
    const clock = h.chain.t;
    const targets = [h.feed.nextClose(), ceilHour(clock + DAY), ceilHour(clock + 7 * DAY)];
    expect(targets[0]).toBe(START - hm(13, 30) + hm(21, 0));
    const at = h.wall.ms - 1000; // the snapshot is taken right after the last tick started
    h.wall.ms = at + 300; // a little later inside the tick interval
    const eta = targets.map((t) => h.feed.etaWall(t)!);
    const snap = h.wall.ms;
    h.wall.ms = at + 1000;
    const reached = new Map<number, number>();
    while (reached.size < targets.length) {
      const started = h.wall.ms;
      await h.tick(120);
      for (const t of targets) if (!reached.has(t) && h.chain.t >= t) reached.set(t, started + 120);
    }
    targets.forEach((t, k) => expect(Math.abs(snap + eta[k]! * 1000 - reached.get(t)!)).toBeLessThanOrEqual(2000));
    expect(eta[2]!).toBeGreaterThan(500); // about 9 wall minutes at speed 60
    expect(h.feed.etaWall(clock - 10)).toBe(0);
  });

  test('ticksUntil walks the night jump in one tick; nextClose at exactly 21:00 is the next day', () => {
    const s = sessions(2);
    expect(ticksUntil(s, D + hm(6, 25), 77, D + hm(7, 30))).toBe(1);
    const h = harness({ start: START - hm(13, 30) + hm(21, 0) });
    h.feed.setClock(START - hm(13, 30) + hm(21, 0));
    expect(h.feed.nextClose()).toBe(START - hm(13, 30) + hm(21, 0) + DAY);
  });
});

describe('timeline ring', () => {
  test('persists, reloads, caps, and drops entries from an older fork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feed-tl-'));
    const path = join(dir, 'feed-timeline.json');
    const h = harness({ start: START, timelinePath: path });
    for (let k = 0; k < 5; k++) await h.tick();
    h.feed.save(true);
    const t2 = new Timeline(path);
    expect(t2.entries).toEqual(h.feed.timeline.entries);
    expect(t2.key).toBe(h.feed.timeline.key);
    t2.record(START - 100, 3, false); // a fresh fork starts earlier
    expect(t2.entries).toEqual([{ t: START - 100, i: 3, c: false }]);
    const small = new Timeline(null, 3);
    for (let k = 0; k < 10; k++) small.record(1000 + k, k, false);
    expect(small.entries.map((e) => e.i)).toEqual([7, 8, 9]);
    small.useKey('other');
    expect(small.entries).toEqual([]);
  });

  test('a clock read far below the timeline (reseeded fork) drops the old entries before the first tick', async () => {
    const h = harness({ start: START + 100 * DAY });
    for (let k = 0; k < 5; k++) await h.tick();
    expect(h.feed.now('NVDA')!.barT).toBeGreaterThan(START + 100 * DAY - 1);
    h.feed.setClock(START);
    expect(h.feed.timeline.entries).toEqual([]);
    expect(h.feed.nextClose()).toBe(START - hm(13, 30) + hm(21, 0));
    expect(h.feed.candles('NVDA', '5m', 10).at(-1)!.t).toBeLessThan(START);
  });
});

describe('caches follow the series and the clock', () => {
  test('a refresh on the same axis that changes coverage or prices is picked up without a tick', () => {
    let s: ReturnType<typeof sessions> = { ...sessions(), coverage: { NVDA: 1, AAPL: 0.8, XYZ: 1, LATE: 1 } };
    const h = harness({ start: START, series: () => s });
    expect(h.feed.coverage().eligible).not.toContain('AAPL');
    expect(h.feed.now('AAPL')!.covered).toBe(false);
    const c1 = h.feed.candles('NVDA', '5m', 20).at(-1)!.c;
    // refreshed recording: identical axis length and endpoints, AAPL now fully covered, NVDA prices moved
    s = { ...s, coverage: { ...s.coverage!, AAPL: 1 }, prices: { ...s.prices, NVDA: s.prices.NVDA!.map((x) => x! + 1000) } };
    expect(h.feed.coverage().eligible).toContain('AAPL');
    expect(h.feed.now('AAPL')!.covered).toBe(true);
    expect(h.feed.candles('NVDA', '5m', 20).at(-1)!.c).toBe(c1 + 1000);
    expect(h.feed.now('NVDA')!.price).toBeGreaterThan(1000);
  });

  test('a clock rollback of ten minutes drops the later timeline entries; a read a tick overtook is ignored', async () => {
    const h = harness({ start: START });
    for (let k = 0; k < 6; k++) await h.tick();
    const last = h.feed.timeline.entries.at(-1)!.t;
    h.feed.setClock(last - 600); // snapshot restored ten minutes back, replay paused
    expect(h.feed.timeline.entries.every((e) => e.t <= last - 600)).toBe(true);
    expect(h.feed.candles('NVDA', '5m', 10).at(-1)!.t).toBeLessThanOrEqual(last - 600);
    expect(h.feed.now('NVDA')!.barT).toBe(last - 600);
    const n = h.feed.timeline.entries.length;
    const seq = h.feed.tickSeq();
    h.chain.t = last; // the replay moves on
    await h.tick();
    h.feed.setClock(START - 10 * DAY, seq); // a read that started before that tick
    expect(h.feed.timeline.entries.length).toBe(n + 1);
    expect(h.feed.clockNow()).toBe(h.chain.t);
  });

  test('backfilled candles follow a clock reset before the first tick', () => {
    const later = START + 50 * DAY;
    const h = harness({ start: later });
    h.feed.setClock(later);
    const a = h.feed.candles('NVDA', '5m', 300);
    expect(a.at(-1)!.t).toBeLessThan(later);
    expect(a.at(-1)!.t).toBeGreaterThan(later - DAY);
    h.feed.setClock(START); // fork reset far back
    const b = h.feed.candles('NVDA', '5m', 300);
    expect(b.length).toBe(300);
    expect(b.at(-1)!.t).toBeLessThan(START);
    expect(b.at(-1)!.t).toBeGreaterThan(START - DAY);
  });

  test('paging requests are not memoized; the memo stays bounded', async () => {
    const h = harness({ start: START });
    for (let k = 0; k < 3; k++) await h.tick();
    for (let b = 0; b < 400; b++) h.feed.candles('NVDA', '5m', 5, START - b * 300);
    for (let l = 1; l <= 400; l++) h.feed.candles('NVDA', '5m', l);
    expect((h.feed as unknown as { candleMemo: Map<string, unknown> }).candleMemo.size).toBeLessThanOrEqual(256);
  });
});
