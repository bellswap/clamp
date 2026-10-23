// Feed against a real chain (test/feed-anvil-setup.ts): an ephemeral anvil with the real contracts and a real App
// driving replay ticks, the indexer and the settler. Skipped when anvil or forge is not installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DUE_RETRIES } from '../src/app';
import { DAY, price8Of, type RoundPost } from '../src/replay';
import { HAVE_FOUNDRY, startAnvilSystem, type AnvilSystem } from './feed-anvil-setup';

const SYMS = ['NVDA', 'XYZ', 'AAPL', ...Array.from({ length: 128 }, (_, i) => `S${i}`)];
type PostFn = (rows: RoundPost[]) => Promise<number>;

describe.skipIf(!HAVE_FOUNDRY)('feed on an ephemeral anvil', () => {
  let x: AnvilSystem;
  beforeAll(async () => {
    x = await startAnvilSystem(SYMS, ['NVDA']);
  }, 120_000);
  afterAll(() => x?.kill());

  test('core prints every tick; a cold session ticket prints only at the 21:00 re-post and settles there', async () => {
    const { app } = x;
    expect(Object.keys(app.store.data.markets).length).toBe(SYMS.length);
    expect(app.coreSymbols()).toEqual(['NVDA']);
    await app.replayTick();
    expect(await x.roundCount('NVDA')).toBeGreaterThanOrEqual(1);
    expect(await x.roundCount('XYZ')).toBe(0);
    expect(await x.open(x.traders[0]!, 'XYZ', true, 5, 100_000_000n, 0)).toBe('reverted'); // NoRound: cold
    expect(app.feed.warm('XYZ', 'test').ok).toBe(true);
    await app.replayTick();
    expect(await x.roundCount('XYZ')).toBe(1);
    expect(await x.open(x.traders[0]!, 'XYZ', true, 5, 100_000_000n, 0)).toBe('success');
    await app.indexTick();
    const t = Object.values(app.store.data.tickets)[0]!;
    expect(t.symbol).toBe('XYZ');
    expect(t.expiry % DAY).toBe(21 * 3600);
    (app.feed.warmSet as unknown as { m: Map<string, unknown> }).m.clear(); // the warm TTL has passed
    let guard = 0;
    while ((await app.clock()).clock < t.expiry && guard++ < 200) {
      await app.replayTick();
      await app.indexTick();
    }
    expect(await x.roundCount('XYZ')).toBe(2); // the warm print and the close re-post, nothing in between
    const [p8, ts] = await x.latest('XYZ');
    expect(Number(ts)).toBeGreaterThanOrEqual(t.expiry);
    expect(Number(ts) - t.expiry).toBeLessThan(5);
    expect(p8).toBe(price8Of(x.series.prices.XYZ![77]!)); // the session's last close
    await app.settleTick();
    await app.indexTick();
    expect(app.store.data.tickets[t.id]!.status).toBe('settled');
    expect(app.store.data.tickets[t.id]!.settlePrice8).toBe(p8.toString());
    // the chart: the last 5m candle close equals the latest on-chain NVDA round
    const [n8] = await x.latest('NVDA');
    expect(app.feed.candles('NVDA', '5m', 300).at(-1)!.c).toBe(Number(n8) / 1e8);
    expect(app.store.data.rounds.NVDA!.at(-1)!.price8).toBe(n8.toString());
  }, 120_000);

  test('a reverted postMany chunk is split until the bad row is alone; every other row lands', async () => {
    const { app } = x;
    const c = (await app.clock()).clock;
    const syms = SYMS.slice(3, 131);
    const before = await Promise.all(syms.map(x.roundCount));
    const post: PostFn = (rows) => (app as unknown as { post: PostFn }).post(rows);
    const rows = syms.map((sym, k) => ({ symbol: sym, price8: sym === 'S5' ? 0n : price8Of(10 + k), t: c })); // S5 reverts ZeroPrice
    const b0 = Number(await x.pub.getBlockNumber({ cacheTime: 0 }));
    expect(await post(rows)).toBe(127);
    const grew = (await Promise.all(syms.map(x.roundCount))).map((v, k) => v - before[k]!);
    expect(syms.length).toBe(128);
    expect(grew.filter((g) => g === 1).length).toBe(127);
    expect(grew[syms.indexOf('S5')]).toBe(0);
    expect(Number(await x.pub.getBlockNumber({ cacheTime: 0 })) - b0).toBeLessThanOrEqual(16); // 2 chunks, 6 halvings, 2 singles
    // the same rows again at the same time (a resumed step): what landed is not sent again
    const b1 = Number(await x.pub.getBlockNumber({ cacheTime: 0 }));
    expect(await post(rows.filter((r) => r.symbol !== 'S5'))).toBe(127);
    expect(Number(await x.pub.getBlockNumber({ cacheTime: 0 }))).toBe(b1);
    await app.chain.advance(1); // a replay tick never posts at a time it already used
  }, 60_000);

  test('a clock move is absolute: repeating it never moves the clock twice', async () => {
    const { app } = x;
    const T = (await app.chain.now()) + 300;
    expect(await app.chain.advanceTo(T)).toBe(T);
    expect(await app.chain.advanceTo(T)).toBe(T); // a resent move mines another block at the same time
    expect(await app.chain.advanceTo(T - 100)).toBe(T); // anvil refuses a time below the head; the clock read decides
    expect(await app.chain.now()).toBe(T);
  }, 30_000);

  test('a post whose broadcast fails throws; a due row that did not land throws up to DUE_RETRIES times', async () => {
    const { app } = x;
    const c = await app.chain.advance(1);
    const post: PostFn = (rows) => (app as unknown as { post: PostFn }).post(rows);
    const chain = app.chain as unknown as { send: unknown };
    const send = chain.send;
    chain.send = async () => {
      throw new Error('broadcast failed');
    };
    await expect(post([{ symbol: 'S9', price8: price8Of(9), t: c }])).rejects.toThrow('broadcast failed');
    chain.send = send;
    const last = (app.feed as unknown as { last: { due: string[] } }).last;
    last.due = ['S9']; // S9 is due in the print set this post belongs to, and its row reverts
    const bad = [{ symbol: 'S9', price8: 0n, t: c }];
    for (let k = 0; k < DUE_RETRIES; k++) await expect(post(bad)).rejects.toThrow('due row(s) did not land: S9');
    expect(await post(bad)).toBe(0); // then the replay moves on
    last.due = [];
    expect(await post([{ symbol: 'S9', price8: price8Of(9), t: c }])).toBe(1);
    await app.chain.advance(1);
  }, 60_000);

  test('a tick with 128 rows (64 core plus 64 warm) stays fast on a local anvil', async () => {
    const { app } = x;
    (app.env as { coreSymbols: string[] }).coreSymbols = SYMS.slice(3, 67);
    for (const sym of SYMS.slice(67, 131)) expect(app.feed.warm(sym, `ip-${sym}`).ok).toBe(true);
    const ms: number[] = [];
    for (let k = 0; k < 12; k++) {
      const t0 = performance.now();
      await app.replayTick();
      ms.push(performance.now() - t0);
      expect(app.feed.status().rowsLastPost).toBe(128);
    }
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(0.95 * ms.length)]!;
    console.log(`feed-anvil: 128-row tick ms p50 ${Math.round(ms[6]!)} p95 ${Math.round(p95)} max ${Math.round(ms.at(-1)!)}`);
    expect(p95).toBeLessThan(400); // budget: tick p95 under 400 ms with 128 rows
    (app.env as { coreSymbols: string[] }).coreSymbols = [];
  }, 120_000);
});
