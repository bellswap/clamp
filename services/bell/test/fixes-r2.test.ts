// Review round 2 of the feed module: interrupted replay steps across restarts and series changes, due rows the
// single-post budget never reached, the rotating budget, partial spark answers, and now() after a range switch.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, type Hex } from 'viem';
import { abis } from '../src/abi';
import { App } from '../src/app';
import { loadEnv } from '../src/config';
import { FeedService } from '../src/feed';
import { healthyFirst } from '../src/feed/post';
import { DAY, fetchRecording, price8Of, Replay, ReplaySource, seriesForRange, type PendingStep, type ReplaySeries, type RoundPost } from '../src/replay';

const D = 1791811800; // 2026-10-12 13:30 UTC, a recorded session open
const tod = (t: number) => ((t % DAY) + DAY) % DAY;
const hm = (h: number, m: number) => h * 3600 + m * 60;

/** `days` recorded sessions of 78 five-minute bars from day `from` (relative to D), prices base + bar index. */
function sessions(from: number, days: number, base: number): ReplaySeries {
  const t: number[] = [];
  const p: number[] = [];
  for (let day = 0; day < days; day++) for (let i = 0; i < 78; i++) {
    t.push(D + (from + day) * DAY + i * 300);
    p.push(base + day * 78 + i);
  }
  return { bar: 300, t, prices: { NVDA: p }, source: 'test', fetchedAt: 0 };
}

/** A fake fork with absolute moves; failAfterMove makes the next move land and then throw (a lost response). */
function fork(start: number) {
  const f = {
    t: start,
    posts: [] as RoundPost[],
    failAfterMove: false,
    now: async () => f.t,
    advance: async (s: number) => (f.t += s),
    advanceTo: async (target: number) => {
      f.t = Math.max(f.t, target);
      if (f.failAfterMove) {
        f.failAfterMove = false;
        throw new Error('read failed');
      }
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

const seen = (posts: RoundPost[]) => posts.map((p) => [tod(p.t) / 60, Number(p.price8) / 1e8]);

describe('an interrupted step survives a restart', () => {
  test('the persisted step completes the move after a restart; the next bar posts its own price', async () => {
    const s = sessions(0, 2, 100);
    const c = fork(D + 70 * DAY); // 13:30
    let saved: PendingStep | null = null;
    const deps = { ...c, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21, onPending: (p: PendingStep | null) => void (saved = p ? JSON.parse(JSON.stringify(p)) : null) };
    const r1 = new Replay(deps);
    c.failAfterMove = true;
    await expect(r1.step()).rejects.toThrow('read failed'); // bar 0 at 13:30, the clock reached 13:35
    expect(saved).not.toBeNull();
    const r2 = new Replay(deps); // restart: cursor 0 from the state file, plus the persisted step
    r2.cursor = 0;
    r2.restore(saved);
    const res = await r2.step();
    expect(res).toMatchObject({ bar: 0, cursor: 1, at: D + 70 * DAY + 300 });
    expect(saved).toBeNull();
    await r2.step();
    expect(seen(c.posts)).toEqual([[hm(13, 30) / 60, 100], [hm(13, 35) / 60, 101]]);
  });

  test('the app restores the persisted step from the state file and keeps it current', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feed-r2-'));
    const pending: PendingStep = { key: 'k', i: 5, next: 6, barT: D, nextT: D + 300, P: 1, d: 300, X: null, target: 301, posted: 1, closeAt: null, closePosted: 0, closeDone: true };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 2, replay: { cursor: 5, range: null, speed: null, pending } }));
    const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_REPLAY: 'off', BELL_ADMIN_TOKEN: 'test' }));
    expect(app.replay.pendingStep()).toEqual(pending);
    app.replay.deps.onPending!(null);
    expect(app.store.data.replay.pending).toBeNull();
  });
});

describe('a series replaced mid-step does not drop the step', () => {
  test('the move that landed is kept; the cursor goes to the new series bar of the next recorded time', async () => {
    let s = sessions(0, 2, 100);
    const c = fork(D + 70 * DAY);
    const r = new Replay({ ...c, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21 });
    c.failAfterMove = true;
    await expect(r.step()).rejects.toThrow('read failed'); // bar 0 (100) at 13:30, the clock reached 13:35
    s = sessions(-1, 3, 200); // a refresh with one more session in front: bar 1 of before is index 79 now
    const res = await r.step();
    expect(res).toMatchObject({ bar: 0, cursor: 79, at: D + 70 * DAY + 300 });
    await r.step();
    expect(seen(c.posts)).toEqual([[hm(13, 30) / 60, 100], [hm(13, 35) / 60, 279]]);
  });

  test('a pending close re-post posts the interrupted bar price, then the jump lands on the new series', async () => {
    let s = sessions(0, 2, 100);
    const c = fork(D + 80 * DAY + hm(6, 25)); // 19:55
    const r = new Replay({ ...c, markets: () => ['NVDA'], series: () => s, closeHourUtc: 21 });
    r.cursor = 77;
    c.failAfterMove = true;
    await expect(r.step()).rejects.toThrow('read failed'); // 177 at 19:55, the clock reached 21:00
    s = sessions(-1, 3, 900);
    const res = await r.step();
    expect(res.closePosted).toBe(1);
    expect(res.cursor).toBe(156);
    expect(tod(c.t)).toBe(hm(13, 30));
    await r.step();
    expect(seen(c.posts)).toEqual([[hm(19, 55) / 60, 177], [hm(21, 0) / 60, 177], [hm(13, 30) / 60, 900 + 156]]);
  });
});

/** An App without a chain: a stub broadcast in which a row with price 0 reverts (alone or in a postMany). */
function postApp() {
  const dir = mkdtempSync(join(tmpdir(), 'feed-r2-post-'));
  const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_REPLAY: 'off', BELL_ADMIN_TOKEN: 'test' }));
  app.book = { reference: '0x00000000000000000000000000000000000000aa' } as never;
  const sends = { n: 0, singles: [] as string[] };
  (app.chain as unknown as { send: unknown }).send = async (_: unknown, tx: { data: Hex }) => {
    sends.n++;
    const d = decodeFunctionData({ abi: abis.signer, data: tx.data });
    if (d.functionName === 'post') {
      const p = (d.args as unknown[])[1] as bigint;
      sends.singles.push(p === 0n ? 'bad' : 'ok');
      return { status: p > 0n ? 'success' : 'reverted', hash: '0x' };
    }
    const ps = (d.args as unknown[])[1] as bigint[];
    return { status: ps.every((p) => p > 0n) ? 'success' : 'reverted', hash: '0x' };
  };
  const post = (rows: RoundPost[]) => (app as unknown as { post: (r: RoundPost[]) => Promise<number> }).post(rows);
  const last = (app.feed as unknown as { last: { due: string[] } }).last;
  return { app, post, last, sends };
}

describe('due rows the single-post budget never reached keep the step retrying', () => {
  test('64 reverting due rows ahead of a healthy due row: the step retries until the healthy row lands', async () => {
    const { app, post, last } = postApp();
    const t = D + 90 * DAY;
    const rows: RoundPost[] = [...Array.from({ length: 64 }, (_, k) => ({ symbol: `R${k}`, price8: 0n, t })), { symbol: 'XYZ', price8: price8Of(5), t }];
    last.due = rows.map((r) => r.symbol);
    let throws = 0;
    let n = -1;
    for (let k = 0; k < 40 && n < 0; k++) {
      try {
        n = await post(rows);
      } catch (e) {
        expect((e as Error).message).toContain('due row(s) did not land');
        throws++;
      }
      if (n >= 0) expect(app.store.data.rounds.XYZ?.at(-1)?.t).toBe(t); // never moves on before XYZ landed
    }
    expect(n).toBe(1);
    expect(throws).toBeGreaterThan(3); // more than DUE_RETRIES: the first attempts never reached XYZ
    expect(app.store.data.rounds.XYZ?.at(-1)?.t).toBe(t);
  });
});

describe('the single-post budget rotates over reverting rows', () => {
  test('a recovered row behind eight persistent reverters lands', async () => {
    const { app, post, sends } = postApp();
    const t0 = D + 91 * DAY;
    await post([{ symbol: 'XYZ', price8: 0n, t: t0 }]); // XYZ reverts on its own: marked bad
    const at = (t: number): RoundPost[] => [...Array.from({ length: 8 }, (_, k) => ({ symbol: `R${k}`, price8: 0n, t })), { symbol: 'XYZ', price8: price8Of(5), t }];
    await post(at(t0 + 1)); // the eight spend the budget and are marked bad too
    expect(app.store.data.rounds.XYZ).toBeUndefined();
    sends.singles = [];
    expect(await post(at(t0 + 2))).toBe(1); // XYZ reverted least recently: it gets the first single post
    expect(app.store.data.rounds.XYZ?.at(-1)?.t).toBe(t0 + 2);
  });

  test('healthyFirst orders bad rows by their latest revert, oldest first', () => {
    const seq: Record<string, number> = { b: 3, d: 1 };
    expect(healthyFirst(['a', 'b', 'c', 'd', 'e'], (x) => seq[x])).toEqual(['a', 'c', 'e', 'd', 'b']);
    expect(healthyFirst([1, 2, 3, 4], (r) => r % 2 === 1)).toEqual([2, 4, 1, 3]);
  });
});

describe('a partial spark answer is not a complete recording', () => {
  const bars = (ys: string[]) => ({
    spark: {
      result: ys.map((y) => ({ symbol: y, response: [{ meta: {}, timestamp: sessions(0, 2, 1).t, indicators: { quote: [{ close: sessions(0, 2, 1).prices.NVDA }] } }] })),
    },
  });
  test('only symbols with valid bars count as answered; the recording is not frozen while one is missing', async () => {
    const fetch = async () => new Response(JSON.stringify(bars(['A'])), { status: 200 }); // B left out of a 200
    const cat = ['A', 'B'].map((x) => ({ symbol: x, yahoo: x }));
    const s = await fetchRecording(cat, { fetch: fetch as never, sleep: async () => undefined, now: () => D + 3 * DAY });
    expect(s.requested).toEqual(['A']);
    const empty = async () => new Response(JSON.stringify({ spark: { result: [...bars(['A']).spark.result, { symbol: 'B', response: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] }] } }), { status: 200 });
    expect((await fetchRecording(cat, { fetch: empty as never, sleep: async () => undefined, now: () => D + 3 * DAY })).requested).toEqual(['A']);
    const src = new ReplaySource({ dir: null, fetch: fetch as never, sleep: async () => undefined, now: () => D + 3 * DAY }, () => null);
    await src.ensure(cat);
    expect(src.recorded()).not.toBeNull();
    expect(src.frozen()).toBe(false);
  });
});

describe('now() shows the bar the next tick posts after a range switch', () => {
  test('switching from 1d to 5d at cursor 1 shows the remapped bar, the one the next step prints', async () => {
    const all = sessions(0, 2, 100);
    let range: '5d' | '1d' = '1d';
    const series = () => seriesForRange(all, range);
    const c = fork(D + 60 * DAY); // 13:30
    const r = new Replay({ ...c, markets: () => ['NVDA'], series, closeHourUtc: 21 });
    const feed = new FeedService({
      series,
      data: () => ({ tickets: {}, rounds: {}, markets: {} }),
      listed: () => ['NVDA'],
      core: () => ['NVDA'],
      catalog: () => ['NVDA'],
      cursor: (s, clock) => (s ? r.cursorIn(s, clock) : r.cursor),
      speed: () => 60,
      paused: () => true,
      frozen: () => true,
      closeHourUtc: 21,
      timelinePath: null,
    });
    feed.onTick(await r.step(), 0, 0); // 178 at 13:30, cursor 1
    expect(feed.now('NVDA')!.price).toBe(179);
    range = '5d';
    expect(feed.now('NVDA')!.price).toBe(179);
    await r.step();
    expect(c.posts.at(-1)!.price8).toBe(price8Of(179));
  });
});
