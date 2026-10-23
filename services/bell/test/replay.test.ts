import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpark } from '../src/charts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { RawSeries } from '../src/charts';
import { coverageMinOf } from '../src/config';
import { buildSeries, closeBetween, COVERAGE_MIN, coversAll, DAY, deltaTo, eligibleOf, fetchRecording, fillLeading, nextDue, price8Of, Replay, ReplaySource, RETRY_PARTIAL_S, seriesFromBulk, tickMs, type ReplaySeries, type RoundPost } from '../src/replay';

const D = 1791811800; // 2026-10-12 13:30 UTC, a recorded session open
const tod = (t: number) => ((t % DAY) + DAY) % DAY;
const hm = (h: number, m: number) => h * 3600 + m * 60;

/** Two recorded sessions of 78 five-minute bars (13:30 to 19:55 UTC), prices 100 + bar index. */
function twoSessions(): ReplaySeries {
  const t: number[] = [];
  const p: number[] = [];
  for (const day of [0, 1]) for (let i = 0; i < 78; i++) {
    t.push(D + day * DAY + i * 300);
    p.push(100 + day * 78 + i);
  }
  return { bar: 300, t, prices: { NVDA: p, AAPL: p.map((x, i) => (i === 0 ? null : x * 2)) }, source: 'test', fetchedAt: 0 };
}

/** A fake fork: the clock only moves by advance(); every post lands at the current clock. */
function fakeChain(start: number, drift = 0) {
  const f = {
    t: start,
    posts: [] as RoundPost[],
    advances: [] as number[],
    now: async () => f.t,
    advance: async (s: number) => {
      f.advances.push(s);
      f.t += s + drift;
      return f.t;
    },
    post: async (rows: RoundPost[]) => {
      for (const r of rows) {
        expect(r.t).toBe(f.t);
        f.posts.push(r);
      }
    },
  };
  return f;
}

describe('replay scheduling', () => {
  test('deltaTo: bar gap inside a session, jump to the next open overnight, one second on drift', () => {
    const P = D + 10 * DAY; // 13:30 on a later day
    expect(deltaTo(P, D + 300, 300)).toBe(300);
    expect(deltaTo(P + hm(6, 25), D + DAY, 300)).toBe(DAY - hm(6, 25)); // 19:55 to 13:30: 17 h 35 min
    expect(deltaTo(P + 2, D + 0, 300)).toBe(1); // clock ran 2 s past the bar: no day-long jump
    expect(deltaTo(P, D, 300)).toBe(1);
  });
  test('closeBetween finds the 21:00 UTC instant strictly inside the jump', () => {
    const P = D + 10 * DAY + hm(6, 25); // 19:55
    const x = closeBetween(P, P + DAY - hm(6, 25), 21);
    expect(x).not.toBeNull();
    expect(tod(x!)).toBe(hm(21, 0));
    expect(closeBetween(P, P + 300, 21)).toBeNull();
    expect(closeBetween(P - hm(19, 55) + hm(21, 0), P + DAY, 21)).toBeNull(); // starts exactly at a close: the next one is after the end
    expect(closeBetween(P - hm(19, 55) + hm(21, 0), P + 2 * DAY, 21)).toBe(P - hm(19, 55) + hm(21, 0) + DAY);
  });
  test('tickMs and nextDue: speed is bars per wall minute; no catch-up burst after a stall', () => {
    expect(tickMs(60)).toBe(1000);
    expect(tickMs(120)).toBe(500);
    expect(nextDue(0, 500, 60)).toBe(1000);
    expect(nextDue(1000, 1200, 60)).toBe(2000);
    expect(nextDue(1000, 9000, 60)).toBe(10_000);
  });
  test('fake wall clock: one recorded session (78 bars) passes in 78 s at speed 60', async () => {
    const s = twoSessions();
    const chain = fakeChain(D + 30 * DAY + hm(13, 30) - hm(13, 30)); // a later 13:30
    const r = new Replay({ ...chain, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21 });
    let wall = 0;
    let due = 0;
    const timeline: number[] = [];
    while (wall < 78_000) {
      await r.step();
      timeline.push(wall);
      due = nextDue(due, wall, 60);
      wall = due;
    }
    expect(timeline.length).toBe(78);
    expect(r.cursor).toBe(78);
    // after 78 ticks the clock sits at the next session's open, one 21:00 close round on the way
    expect(tod(chain.t)).toBe(hm(13, 30));
    const closes = chain.posts.filter((p) => tod(p.t) === hm(21, 0));
    expect(closes.length).toBe(1);
    expect(closes[0]!.price8).toBe(price8Of(177)); // the session's last close (bar 77)
  });
  test('first tick aligns the clock to the recorded time of day, posts the close round, then every bar', async () => {
    const s = twoSessions();
    const start = D + 40 * DAY + hm(5, 0); // 18:30 UTC
    const chain = fakeChain(start);
    const r = new Replay({ ...chain, markets: () => ['NVDA', 'AAPL'], series: () => s, closeHourUtc: 21 });
    const a = await r.step();
    expect(a.posted).toBe(1); // AAPL has no price at bar 0
    expect(a.close).not.toBeNull();
    expect(tod(chain.t)).toBe(hm(13, 35));
    expect(chain.posts.map((p) => [p.symbol, tod(p.t)])).toEqual([
      ['NVDA', hm(18, 30)],
      ['NVDA', hm(21, 0)],
    ]);
    const b = await r.step();
    expect(b.delta).toBe(300);
    expect(b.posted).toBe(2);
    expect(chain.posts.at(-1)!.price8).toBe(price8Of(202));
  });
  test('wall-time drift of the fork clock self-corrects to the bar grid', async () => {
    const s = twoSessions();
    const chain = fakeChain(D + 50 * DAY, 2); // every advance lands 2 s late
    const r = new Replay({ ...chain, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21 });
    for (let i = 0; i < 10; i++) await r.step();
    expect(chain.advances.slice(1, 4)).toEqual([298, 298, 298]);
    expect(tod(chain.t)).toBe(hm(13, 30) + 10 * 300 + 2);
  });
  test('wraps to the start of the series after the last bar', async () => {
    const s = twoSessions();
    const chain = fakeChain(D + 60 * DAY + hm(6, 25) + DAY); // a 19:55
    const r = new Replay({ ...chain, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21 });
    r.cursor = s.t.length - 1;
    const x = await r.step();
    expect(x.cursor).toBe(0);
    expect(tod(chain.t)).toBe(hm(13, 30));
  });
  test('idle without markets or series', async () => {
    const chain = fakeChain(D);
    expect((await new Replay({ ...chain, markets: () => [], series: () => twoSessions(), closeHourUtc: 21 }).step()).idle).toBe('no listed markets');
    expect((await new Replay({ ...chain, markets: () => ['NVDA'], series: () => null, closeHourUtc: 21 }).step()).idle).toBe('no recorded series');
    expect(chain.advances.length).toBe(0);
  });
  test('buildSeries from a recorded spark answer', () => {
    const doc = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/spark-5d.json'), 'utf8'));
    const s = buildSeries(parseSpark(doc), [{ symbol: 'AAL', yahoo: 'AAL' }, { symbol: 'NFLX', yahoo: 'NFLX' }, { symbol: 'NOPE', yahoo: 'NOPE' }], 900, 'fixture', 1);
    expect(s).not.toBeNull();
    expect(Object.keys(s!.prices).sort()).toEqual(['AAL', 'NFLX']);
    expect(s!.t.length).toBeGreaterThan(100);
    expect(s!.prices.AAL!.length).toBe(s!.t.length);
  });
});

// ---------------------------------------------------------------- recording
/** Raw spark series: `days` sessions of 78 bars from D; `skip` drops bars (no trade), `from` starts later. */
function raw(days: number, o: { skip?: (j: number) => boolean; from?: number; partialLast?: number; price?: number } = {}): RawSeries {
  const t: number[] = [];
  const c: (number | null)[] = [];
  for (let d = 0; d < days; d++) {
    const bars = d === days - 1 && o.partialLast ? o.partialLast : 78;
    for (let i = 0; i < bars; i++) {
      const j = d * 78 + i;
      if (j < (o.from ?? 0) || o.skip?.(j)) continue;
      t.push(D + d * DAY + i * 300);
      c.push((o.price ?? 100) + j);
    }
  }
  return { t, c, base: null, last: c.at(-1) ?? null };
}

describe('recording: coverage, leading fill, sessions', () => {
  test('fillLeading takes the last value of the series (wrap continuity)', () => {
    expect(fillLeading([null, null, 1, 2, 3])).toEqual([3, 3, 1, 2, 3]);
    expect(fillLeading([null, null])).toEqual([null, null]);
    expect(fillLeading([1, null, 2])).toEqual([1, null, 2]);
  });

  test('coverage = raw bars on the axis / axis length; eligible at 0.90; leading gap filled', () => {
    const parsed = new Map<string, RawSeries>([
      ['FULL', raw(5)],
      ['FULL2', raw(5, { price: 50 })],
      ['GAPPY', raw(5, { skip: (j) => j % 10 === 0 })], // 90 percent exactly
      ['THIN', raw(5, { skip: (j) => j % 5 === 0 })], // 80 percent
      ['LATE', raw(5, { from: 30 })],
    ]);
    const syms = ['FULL', 'FULL2', 'GAPPY', 'THIN', 'LATE', 'NONE'].map((x) => ({ symbol: x, yahoo: x }));
    const s = buildSeries(parsed, syms, 300, 'test', 1)!;
    expect(s.t.length).toBe(390);
    expect(s.coverage).toEqual({ FULL: 1, FULL2: 1, GAPPY: 0.9, THIN: 0.8, LATE: 0.9231 });
    expect(eligibleOf(s, syms.map((x) => x.symbol))).toEqual({ eligible: ['FULL', 'FULL2', 'GAPPY', 'LATE'], missing: ['THIN', 'NONE'] });
    expect(COVERAGE_MIN).toBe(0.9);
    expect(s.prices.LATE!.slice(0, 30).every((x) => x === s.prices.LATE!.at(-1))).toBe(true);
    expect(s.prices.LATE![30]).toBe(130);
    expect(s.prices.GAPPY![10]).toBe(109); // a bar without a trade carries the last close
  });

  test('a trailing session still trading is dropped; the last N complete sessions are kept', () => {
    const parsed = new Map<string, RawSeries>([['A', raw(7, { partialLast: 37 })], ['B', raw(7, { partialLast: 37, price: 10 })]]);
    const s = buildSeries(parsed, [{ symbol: 'A', yahoo: 'A' }, { symbol: 'B', yahoo: 'B' }], 300, 'test', 1, { sessions: 5, dropPartial: true })!;
    expect(s.sessions).toBe(5);
    expect(s.t.length).toBe(390);
    expect(s.t[0]).toBe(D + DAY);
    expect(s.t.at(-1)).toBe(D + 5 * DAY + 77 * 300);
    expect(s.prices.A![0]).toBe(100 + 78); // as-of join keeps the trimmed sessions out
  });

  test('fetchRecording: batches of 20, UA Mozilla/5.0, doubling waits on 429', async () => {
    const syms = Array.from({ length: 45 }, (_, i) => ({ symbol: `S${i}`, yahoo: `S${i}` }));
    const urls: string[] = [];
    const uas: string[] = [];
    const waits: number[] = [];
    let n429 = 2;
    const doc = (ys: string[]) => ({ spark: { result: ys.map((y) => { const r = raw(6, { partialLast: 20 }); return { symbol: y, response: [{ meta: {}, timestamp: r.t, indicators: { quote: [{ close: r.c }] } }] }; }) } });
    const f = async (u: string, init?: RequestInit) => {
      urls.push(u);
      uas.push(new Headers(init?.headers).get('user-agent') ?? '');
      if (n429-- > 0) return new Response('{}', { status: 429 });
      const ys = decodeURIComponent(new URL(u).searchParams.get('symbols')!).split(',');
      return new Response(JSON.stringify(doc(ys)), { status: 200 });
    };
    const s = await fetchRecording(syms, { fetch: f as never, sleep: async (ms) => void waits.push(ms), backoffMs: 1000, gapMs: 400, now: () => 7 });
    expect(urls.length).toBe(5); // 2 x 429, then 3 batches
    expect(urls.every((u) => u.includes('range=7d') && u.includes('interval=5m'))).toBe(true);
    expect(urls.map((u) => new URL(u).searchParams.get('symbols')!.split(',').length)).toEqual([20, 20, 20, 20, 5]);
    expect(new Set(uas)).toEqual(new Set(['Mozilla/5.0']));
    expect(waits).toEqual([1000, 2000, 400, 400]);
    expect(s.sessions).toBe(5);
    expect(Object.keys(s.prices).length).toBe(45);
    expect(s.fetchedAt).toBe(7);
  });

  test('ReplaySource: frozen for refreshS; a refetch that drops a covered symbol is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-src-'));
    const cur: ReplaySeries = { bar: 300, t: [1, 2, 3], prices: { A: [1, 2, 3], B: [1, 2, 3] }, source: 'disk', fetchedAt: 1000, coverage: { A: 1, B: 0.95 }, requested: ['A', 'B', 'C'] }; // C asked, no data
    writeFileSync(join(dir, 'replay-5d-5m.json'), JSON.stringify(cur));
    let now = 1000 + 3600;
    let fetches = 0;
    const answer = (bcov: boolean) => async (u: string) => {
      fetches++;
      const ys = decodeURIComponent(new URL(u).searchParams.get('symbols')!).split(',');
      const r = (y: string) => (y === 'B' && !bcov ? raw(5, { skip: (j) => j % 5 === 0 }) : raw(5));
      return new Response(JSON.stringify({ spark: { result: ys.map((y) => ({ symbol: y, response: [{ meta: {}, timestamp: r(y).t, indicators: { quote: [{ close: r(y).c }] } }] })) } }), { status: 200 });
    };
    const syms = [{ symbol: 'A', yahoo: 'A' }, { symbol: 'B', yahoo: 'B' }, { symbol: 'C', yahoo: 'C' }]; // C keeps B's gaps on the axis
    const src = new ReplaySource({ dir, refreshS: 604_800, now: () => now, fetch: answer(false) as never, sleep: async () => undefined }, () => null);
    expect(src.frozen()).toBe(true);
    await src.ensure(syms);
    expect(fetches).toBe(0);
    now = 1000 + 604_800;
    expect(src.frozen()).toBe(false);
    await src.ensure(syms);
    expect(fetches).toBe(1);
    expect(src.get()!.source).toBe('disk'); // B fell to 0.8: rejected
    const src2 = new ReplaySource({ dir, refreshS: 604_800, now: () => now, fetch: answer(true) as never, sleep: async () => undefined }, () => null);
    await src2.ensure(syms);
    expect(src2.get()!.t.length).toBe(390);
    expect(coversAll(cur, src2.get()!)).toBe(true);
  });
});

// ---------------------------------------------------------------- interrupted steps
/** A fake fork with absolute clock moves and injectable failures: a move that lands and then throws (lost response), a
 *  move that throws before landing, a post that throws (broadcast failed). */
function absChain(start: number) {
  const f = {
    t: start,
    posts: [] as RoundPost[],
    moves: [] as number[],
    failMoveAfter: false,
    failMoveBefore: false,
    failPost: null as null | ((rows: RoundPost[]) => boolean),
    now: async () => f.t,
    advance: async (): Promise<number> => {
      throw new Error('relative move used');
    },
    advanceTo: async (target: number) => {
      if (f.failMoveBefore) {
        f.failMoveBefore = false;
        throw new Error('rpc down');
      }
      f.moves.push(target);
      f.t = Math.max(f.t, target);
      if (f.failMoveAfter) {
        f.failMoveAfter = false;
        throw new Error('response lost');
      }
      return f.t;
    },
    post: async (rows: RoundPost[]) => {
      if (f.failPost?.(rows)) {
        f.failPost = null;
        throw new Error('broadcast failed');
      }
      for (const r of rows) {
        expect(r.t).toBe(f.t);
        f.posts.push(r);
      }
    },
  };
  return f;
}

describe('interrupted steps resume where they stopped', () => {
  test('a move that landed before its call failed is not repeated; the next bar posts at its own time and price', async () => {
    const s = twoSessions();
    const P0 = D + 70 * DAY; // 13:30
    const c = absChain(P0);
    const r = new Replay({ ...c, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21 });
    await r.step(); // bar 0 at 13:30
    c.failMoveAfter = true;
    await expect(r.step()).rejects.toThrow('response lost'); // bar 1 at 13:35, the clock reached 13:40
    expect(c.t).toBe(P0 + 600);
    expect(r.cursor).toBe(1);
    const res = await r.step(); // completes the step: no post, no move
    expect(res).toMatchObject({ bar: 1, postedAt: P0 + 300, at: P0 + 600, cursor: 2, posted: 1 });
    expect(c.posts.length).toBe(2);
    await r.step();
    expect(c.posts.at(-1)).toEqual({ symbol: 'NVDA', price8: price8Of(102), t: P0 + 600 });
    c.failMoveBefore = true;
    await expect(r.step()).rejects.toThrow('rpc down'); // bar 3 posted at 13:45, the move did not land
    await r.step(); // moves to 13:50 without posting bar 3 again
    expect(c.posts.filter((p) => p.t === P0 + 900).length).toBe(1);
    expect(c.t).toBe(P0 + 1200);
    await r.step();
    expect(c.posts.at(-1)).toEqual({ symbol: 'NVDA', price8: price8Of(104), t: P0 + 1200 });
    expect(c.moves).toEqual([P0 + 300, P0 + 600, P0 + 900, P0 + 1200, P0 + 1500]); // absolute targets, each once
  });

  test('a failed close re-post stops the step at 21:00; the next step posts the close there, then jumps', async () => {
    const s = twoSessions();
    const c = absChain(D + 80 * DAY + hm(6, 25)); // 19:55
    const r = new Replay({ ...c, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21 });
    r.cursor = 77;
    c.failPost = (rows) => rows.length > 0 && tod(rows[0]!.t) === hm(21, 0);
    await expect(r.step()).rejects.toThrow('broadcast failed');
    expect(tod(c.t)).toBe(hm(21, 0)); // stopped at the close, not past it
    expect(r.cursor).toBe(77);
    const res = await r.step();
    expect(res.closePosted).toBe(1);
    expect(tod(res.closeAt!)).toBe(hm(21, 0));
    expect(tod(c.t)).toBe(hm(13, 30));
    expect(r.cursor).toBe(78);
    expect(c.posts.map((p) => [tod(p.t), Number(p.price8) / 1e8])).toEqual([
      [hm(19, 55), 177],
      [hm(21, 0), 177],
    ]);
  });

  test('beforeClose runs after the move to 21:00 and before the close rows are picked; landed counts are reported', async () => {
    const s = twoSessions();
    const c = absChain(D + 90 * DAY + hm(6, 25));
    const order: string[] = [];
    const r = new Replay({
      ...c,
      post: async () => 0, // nothing landed
      markets: () => ['NVDA'],
      series: () => s,
      closeHourUtc: 21,
      printSet: (at, close) => {
        order.push(`${close ? 'close' : 'tick'} ${tod(at) / 60}`);
        return ['NVDA'];
      },
      beforeClose: async () => void order.push(`index ${tod(c.t) / 60}`),
    });
    r.cursor = 77;
    const res = await r.step();
    expect(order).toEqual([`tick ${hm(19, 55) / 60}`, `index ${hm(21, 0) / 60}`, `close ${hm(21, 0) / 60}`]);
    expect(res.posted).toBe(0);
    expect(res.closePosted).toBe(0);
  });
});

describe('recording source: frozen only when it covers the catalog', () => {
  const doc = (ys: string[], fail?: string) => ({ spark: { result: ys.filter((y) => y !== fail).map((y) => ({ symbol: y, response: [{ meta: {}, timestamp: raw(5).t, indicators: { quote: [{ close: raw(5).c }] } }] })) } });
  const answer = (o: { fail?: string; count: { n: number } }) => async (u: string) => {
    o.count.n++;
    const ys = decodeURIComponent(new URL(u).searchParams.get('symbols')!).split(',');
    if (o.fail && ys.includes(o.fail)) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(doc(ys)), { status: 200 });
  };

  test('a recent recording from before the coverage rule (listed markets only) is refetched for the whole catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-legacy-'));
    const legacy: ReplaySeries = { bar: 300, t: raw(5).t, prices: { A: raw(5).c, B: raw(5).c }, source: 'legacy', fetchedAt: 1000 };
    writeFileSync(join(dir, 'replay-5d-5m.json'), JSON.stringify(legacy));
    const count = { n: 0 };
    const src = new ReplaySource({ dir, refreshS: 604_800, now: () => 2000, fetch: answer({ count }) as never, sleep: async () => undefined }, () => null);
    expect(src.frozen()).toBe(false);
    const cat = ['A', 'B', 'C', 'D'].map((x) => ({ symbol: x, yahoo: x }));
    await src.ensure(cat);
    expect(count.n).toBe(1);
    expect(Object.keys(src.get()!.prices).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(src.get()!.requested).toEqual(['A', 'B', 'C', 'D']);
    expect(src.frozen()).toBe(true);
    await src.ensure(cat);
    expect(count.n).toBe(1);
  });

  test('a recording that misses catalog symbols is not frozen; a batch that did not answer is asked again later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-partial-'));
    let now = 5000;
    const count = { n: 0 };
    const cat = Array.from({ length: 21 }, (_, i) => ({ symbol: `S${i}`, yahoo: `S${i}` }));
    const src = new ReplaySource({ dir, refreshS: 604_800, now: () => now, fetch: answer({ fail: 'S20', count }) as never, sleep: async () => undefined, retries: 0 }, () => null);
    await src.ensure(cat); // batch 1 (S0 to S19) answers, batch 2 (S20) fails
    expect(Object.keys(src.get()!.prices).length).toBe(20);
    expect(src.frozen()).toBe(false);
    const n = count.n;
    await src.ensure(cat);
    expect(count.n).toBe(n); // not before RETRY_PARTIAL_S
    now += RETRY_PARTIAL_S;
    await src.ensure(cat);
    expect(count.n).toBeGreaterThan(n);
    const part: ReplaySeries = { bar: 300, t: [1, 2], prices: { A: [1, 2] }, source: 'x', fetchedAt: now, coverage: { A: 1 } };
    writeFileSync(join(dir, 'replay-5d-5m.json'), JSON.stringify(part));
    const src2 = new ReplaySource({ dir, refreshS: 604_800, now: () => now, fetch: answer({ fail: 'B', count }) as never, sleep: async () => undefined }, () => null);
    expect(src2.frozen()).toBe(true); // no catalog known yet
    await src2.ensure([{ symbol: 'A', yahoo: 'A' }, { symbol: 'B', yahoo: 'B' }]);
    expect(src2.frozen()).toBe(false); // B was never asked for
  });

  test('coversAll uses the configured coverage minimum; BELL_COVERAGE_MIN=0 is 0', () => {
    const cur: ReplaySeries = { bar: 300, t: [1, 2], prices: { A: [1, 2], B: [1, 2] }, source: 'x', fetchedAt: 0, coverage: { A: 1, B: 0.6 } };
    const onlyA: ReplaySeries = { ...cur, prices: { A: [1, 2] }, coverage: { A: 1 } };
    expect(coversAll(cur, onlyA)).toBe(true); // at 0.90 B was never covered
    expect(coversAll(cur, onlyA, 0.5)).toBe(false); // at 0.50 B is tradable: the refetch would drop it
    expect(coversAll(cur, { ...cur, coverage: { A: 1, B: 0.55 } }, 0.5)).toBe(true);
    expect(coverageMinOf('0')).toBe(0);
    expect(coverageMinOf('0.5')).toBe(0.5);
    expect(coverageMinOf(undefined)).toBe(0.9);
    expect(coverageMinOf('')).toBe(0.9);
    expect(coverageMinOf('x')).toBe(0.9);
    expect(coverageMinOf('2')).toBe(1);
  });

  test('the charts fallback fills leading gaps like a recording', () => {
    const b = { asOf: 0, fetchedAt: 0, range: '5d', interval: 900, source: 'charts', delayMin: 0, stale: false, count: 3, t: [1, 2, 3], series: { A: { p: [null, 100, 101] } }, missing: [] };
    expect(seriesFromBulk(b as never)!.prices.A).toEqual([101, 100, 101]);
  });
});
