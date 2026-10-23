// Settlement integrity on an ephemeral anvil (local version): seeded-random tickets on every horizon,
// mostly on cold long-tail symbols, some opened one bar before 21:00 and some across the replay wrap, with a simulated
// wall clock (one tick per wall second at speed 60, indexer every 2 s, settler every 4 s, as in App.start). Every
// ticket must settle, none may stay due (clock past expiry) and unsettled for more than 30 wall seconds, and every
// session ticket settles on the daily-close print (no periodic index pass runs between a before-close open and the
// close: the re-post's own index pass must find it).
// FEED_INTEGRITY_TICKETS sets the count (default 300).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { abis } from '../src/abi';
import { symbolToBytes32 } from '../src/math';
import { DAY } from '../src/replay';
import { settleOnce } from '../src/settler';
import { HAVE_FOUNDRY, startAnvilSystem, type AnvilSystem } from './feed-anvil-setup';

const SYMS = ['NVDA', ...Array.from({ length: 24 }, (_, i) => `L${i}`)];
const TARGET = Number(process.env.FEED_INTEGRITY_TICKETS || 300);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!HAVE_FOUNDRY)('settlement integrity on an ephemeral anvil', () => {
  let x: AnvilSystem;
  beforeAll(async () => {
    x = await startAnvilSystem(SYMS, ['NVDA'], { traders: 8, days: 2 });
  }, 120_000);
  afterAll(() => x?.kill());

  test(`${TARGET} random tickets: all settle, none due and unsettled for more than 30 wall s`, async () => {
    const { app } = x;
    const data = app.store.data;
    const rand = rng(42);
    let w = 1_000_000;
    (app.feed.deps as { nowMs?: () => number }).nowMs = () => w;
    const backoff = new Map<string, number>();
    const recent = new Map<string, number>();
    const settledAt = new Map<string, number>();
    const hist: [number, number][] = []; // (wall ms after the tick, fork clock after the tick)
    const queued: { sym: string; horizon: number; trader: number; tag: string }[] = [];
    const opens: { tag: string; horizon: number; status: string }[] = [];
    const warm = (app.feed.warmSet as unknown as { m: Map<string, unknown> }).m;
    let rowsMax = 0;
    let tick = 0;
    let lastBar = -1;
    let wrapAt = -1;
    const open = async (q: (typeof queued)[number]) => {
      const lev = [2, 5, 10, 20][Math.floor(rand() * 4)]!;
      const stake = BigInt(5 + Math.floor(rand() * 45)) * 1_000_000n;
      const before = Object.keys(data.tickets).length;
      const status = await x.open(x.traders[q.trader]!, q.sym, rand() < 0.5, lev, stake, q.horizon);
      opens.push({ tag: q.tag, horizon: q.horizon, status });
      return { status, before };
    };
    while (tick < 3000) {
      await app.replayTick();
      tick++;
      w += 1000;
      const clock = await app.chain.now();
      hist.push([w, clock]);
      rowsMax = Math.max(rowsMax, app.feed.status().rowsLastPost);
      if (app.replay.cursor < lastBar && wrapAt < 0) wrapAt = tick;
      lastBar = app.replay.cursor;
      // opens queued at the previous tick: their warm print has landed
      for (const q of queued.splice(0)) await open(q);
      const placed = opens.length + queued.length;
      let openedBeforeClose = false;
      if (placed < TARGET) {
        const tod = clock % DAY;
        const beforeClose = tod === 19 * 3600 + 55 * 60; // one bar before 21:00: the next tick crosses the close
        const rate = TARGET / 240; // spread over 240 ticks: two daily closes and the wrap at bar 156
        const n = beforeClose ? 3 : Math.floor(rate) + (rand() < rate % 1 ? 1 : 0);
        for (let k = 0; k < n && opens.length + queued.length < TARGET; k++) {
          const sym = rand() < 0.15 ? 'NVDA' : SYMS[1 + Math.floor(rand() * (SYMS.length - 1))]!;
          const r = rand();
          const horizon = beforeClose ? 0 : r < 0.5 ? 0 : r < 0.85 ? 1 : 2;
          const tag = wrapAt < 0 && app.replay.cursor > 140 ? 'across-wrap' : 'plain';
          const last = data.rounds[sym]?.at(-1);
          if (beforeClose && sym !== 'NVDA' && last && clock - last.t < DAY - 600) {
            await open({ sym, horizon, trader: Math.floor(rand() * 8), tag: 'before-close' });
            openedBeforeClose = true;
            warm.delete(sym); // its warm TTL ran out: only the due rule can print it at the close
          } else {
            if (sym !== 'NVDA') app.feed.warm(sym, `trader-${k}`, 30);
            // queued at the bar before the close, the open itself lands after the close (next session's expiry)
            queued.push({ sym, horizon, trader: Math.floor(rand() * 8), tag: beforeClose ? 'after-close' : tag });
          }
        }
      }
      if (tick % 2 === 0 && !openedBeforeClose) await app.indexTick();
      if (tick % 4 === 0) {
        for (const [id, at] of recent) if (w - at > 30_000 || data.tickets[id]?.status !== 'open') recent.delete(id);
        const ids = await settleOnce(data, app.chain, app.book!.book!, abis.book, () => undefined, new Set(recent.keys()), backoff, w, (id, sym) => app.feed.watch(id, sym));
        for (const id of ids) {
          recent.set(id, w);
          settledAt.set(id, w);
        }
      }
      const all = Object.values(data.tickets);
      if (opens.length >= TARGET && all.length >= opens.filter((o) => o.status === 'success').length && all.every((t) => t.status === 'settled')) break;
    }
    await app.indexTick();
    const tickets = Object.values(data.tickets);
    const ok = opens.filter((o) => o.status === 'success');
    // due time: the first tick after which the fork clock is at or past the expiry
    const delays = tickets.map((t) => {
      const due = hist.find(([, c]) => c >= t.expiry)?.[0] ?? Number.POSITIVE_INFINITY;
      return (settledAt.get(t.id) ?? Number.POSITIVE_INFINITY) - due;
    });
    const sorted = delays.slice().sort((a, b) => a - b);
    const byH = [0, 1, 2].map((h) => tickets.filter((t) => t.horizon === h).length);
    const byTag = Object.fromEntries(['plain', 'before-close', 'after-close', 'across-wrap'].map((g) => [g, ok.filter((o) => o.tag === g).length]));
    // session tickets settle on the daily-close print: the first on-chain round at or after the expiry is the re-post
    const ref = app.book!.reference!;
    const late: string[] = [];
    for (const t of tickets.filter((t) => t.horizon === 0)) {
      const [p8, ts] = (await app.chain.pub.readContract({ address: ref, abi: abis.signer, functionName: 'priceAtOrAfter', args: [symbolToBytes32(t.symbol), BigInt(t.expiry), '0x'] })) as [bigint, bigint];
      if (Number(ts) - t.expiry >= 300 || t.settlePrice8 !== p8.toString()) late.push(`${t.id} ${t.symbol} expiry ${t.expiry} round ${ts}`);
    }
    console.log(
      `feed-integrity: ${tickets.length} tickets (session/day/week ${byH.join('/')}, ${JSON.stringify(byTag)}), opens reverted ${opens.length - ok.length}, settled ${tickets.filter((t) => t.status === 'settled').length}, ticks ${tick}, wrap at tick ${wrapAt}, due-to-settle wall s p50 ${(sorted[Math.floor(sorted.length / 2)]! / 1000).toFixed(0)} p95 ${(sorted[Math.floor(sorted.length * 0.95)]! / 1000).toFixed(0)} max ${(sorted.at(-1)! / 1000).toFixed(0)}, over 30 s: ${delays.filter((d) => d > 30_000).length}, session tickets off the close print: ${late.length}, rows per post max ${rowsMax}`,
    );
    expect(ok.length).toBeGreaterThanOrEqual(Math.floor(TARGET * 0.95));
    expect(tickets.length).toBe(ok.length);
    expect(tickets.every((t) => t.status === 'settled')).toBe(true);
    expect(delays.filter((d) => d > 30_000).length).toBe(0);
    expect(late).toEqual([]);
    expect(byTag['before-close']).toBeGreaterThan(0);
    expect(byTag['across-wrap']).toBeGreaterThan(0);
    expect(wrapAt).toBeGreaterThan(0);
  }, 900_000);
});
