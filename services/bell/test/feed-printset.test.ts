import { describe, expect, test } from 'bun:test';
import { dueSymbols, mergePrintSet, WarmSet, WARM_EVICT_IDLE_MS } from '../src/feed/printset';
import { DAY } from '../src/replay';
import { D, harness, hm, tod } from './feed-harness';

const START = D + 10 * DAY; // a later 13:30 UTC, aligned with bar 0
const CLOSE = START - hm(13, 30) + hm(21, 0); // 21:00 of the first playground day

describe('print set: due', () => {
  test('a cold symbol prints once, at the first tick at or after its expiry', async () => {
    const h = harness({ start: START, core: ['NVDA'] });
    h.ticket('1', 'XYZ', START + 3 * 300 + 100);
    for (let k = 0; k < 10; k++) await h.tick();
    const xyz = h.chain.posts.filter((p) => p.symbol === 'XYZ');
    expect(xyz.map((p) => p.t)).toEqual([START + 4 * 300]);
    expect(xyz[0]!.close).toBe(false);
    expect(h.chain.posts.filter((p) => p.symbol === 'AAPL').length).toBe(0); // never asked for
    expect(h.chain.posts.filter((p) => p.symbol === 'NVDA' && !p.close).length).toBe(10); // core every tick
  });

  test('a session ticket prints at the daily-close re-post, at 21:00 exactly', async () => {
    const h = harness({ start: START, core: [] });
    h.ticket('1', 'AAPL', CLOSE);
    for (let k = 0; k < 78; k++) await h.tick();
    const aapl = h.chain.posts.filter((p) => p.symbol === 'AAPL');
    expect(aapl.length).toBe(1);
    expect(aapl[0]!.t).toBe(CLOSE);
    expect(aapl[0]!.close).toBe(true);
    expect(aapl[0]!.price8).toBe(BigInt((200 + 77) * 1e8)); // the session's last close (bar 77)
    expect(tod(h.chain.t)).toBe(hm(13, 30)); // next session open
  });

  test('an expiry inside the night jump prints at the next tick after the jump', async () => {
    const h = harness({ start: START, core: [] });
    h.ticket('1', 'XYZ', CLOSE + 3600); // 22:00
    for (let k = 0; k < 79; k++) await h.tick();
    const xyz = h.chain.posts.filter((p) => p.symbol === 'XYZ');
    expect(xyz.length).toBe(1);
    expect(xyz[0]!.close).toBe(false);
    expect(xyz[0]!.t).toBe(START + DAY); // the next 13:30
    expect(xyz[0]!.t).toBeGreaterThanOrEqual(CLOSE + 3600);
  });

  test('a stored round dated after the post time (older fork) counts as none', () => {
    const d = { tickets: {} as Record<string, any>, rounds: { XYZ: [{ t: START + 10 * DAY, price8: '1' }] } as Record<string, { t: number; price8: string }[]> };
    d.tickets['1'] = { id: '1', symbol: 'XYZ', status: 'open', expiry: START };
    expect(dueSymbols(d as never, START + 300)).toEqual(['XYZ']);
    d.rounds.XYZ = [{ t: START + 10, price8: '1' }];
    expect(dueSymbols(d as never, START + 300)).toEqual([]);
    d.tickets['1'].status = 'settled';
    d.rounds.XYZ = [];
    expect(dueSymbols(d as never, START + 300)).toEqual([]);
  });
});

describe('print set: cap and priority', () => {
  const syms = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  test('due is never dropped, even past the cap', () => {
    const due = syms('D', 130);
    const r = mergePrintSet(new Set([...due, 'C0']), due, [], ['C0'], [], 128);
    expect(r.symbols.length).toBe(130);
    expect(r.core).toEqual([]);
  });
  test('due, then watchdog, then core, then warm; unlisted and duplicates dropped; capped at 128', () => {
    const due = syms('D', 10);
    const wd = syms('W', 20);
    const core = syms('C', 14);
    const warm = syms('H', 200);
    const listed = new Set([...due, ...wd, ...core, ...warm]);
    const r = mergePrintSet(listed, due, [...wd, 'D0', 'UNLISTED'], core, warm, 128);
    expect(r.symbols.length).toBe(128);
    expect(r.symbols.slice(0, 10)).toEqual(due);
    expect(r.symbols.slice(10, 30)).toEqual(wd);
    expect(r.symbols.slice(30, 44)).toEqual(core);
    expect(r.warm.length).toBe(84);
    expect(r.symbols).not.toContain('UNLISTED');
  });
  test('a log line every 60 ticks carries rows per post and tick ms', async () => {
    const h = harness({ start: START, core: ['NVDA', 'AAPL'] });
    const lines: string[] = [];
    (h.feed.deps as { log?: (...a: unknown[]) => void }).log = (...a) => lines.push(a.join(' '));
    for (let k = 0; k < 120; k++) await h.tick(k % 10 === 0 ? 300 : 50);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^feed: rows per post last 2 avg 2\.\d max \d+; tick ms p50 50 p95 300 max 300; core 2 warm 0 due 0 watchdog 0$/);
  });

  test('rows per post at idle are the core markets only', async () => {
    const h = harness({ start: START, core: ['NVDA', 'AAPL'] });
    const r = await h.tick();
    expect(r.posted).toBe(2);
    expect(h.feed.status().rowsLastPost).toBe(2);
  });
});

describe('print set: warm', () => {
  test('feed.warm: not-listed, no-series, core, ttl clamp, then printed until the TTL passes', async () => {
    const h = harness({ start: START, core: ['NVDA'] });
    h.data.markets.NOPE = { ...h.data.markets.NVDA!, symbol: 'NOPE' };
    expect(h.feed.warm('ZZZ', 'ip').reason).toBe('not-listed');
    expect(h.feed.warm('NOPE', 'ip').reason).toBe('no-series');
    expect(h.feed.warm('nvda', 'ip')).toEqual({ ok: true, warmUntil: Math.floor((h.wall.ms + 90_000) / 1000) });
    expect(h.feed.status().warm).toEqual([]); // core needs no entry
    const w = h.feed.warm('XYZ', 'ip', 999);
    expect(w.ok).toBe(true);
    expect(w.warmUntil).toBe(Math.floor((h.wall.ms + 120_000) / 1000));
    await h.tick();
    expect(h.chain.posts.some((p) => p.symbol === 'XYZ')).toBe(true);
    h.wall.ms += 121_000;
    const before = h.chain.posts.length;
    await h.tick();
    expect(h.chain.posts.slice(before).map((p) => p.symbol)).toEqual(['NVDA']);
  });

  test('60 new warms per client key per minute; refreshes do not count; full at 64 while all are active', () => {
    const w = new WarmSet(64);
    let now = 0;
    for (let i = 0; i < 60; i++) expect(w.touch(`S${i}`, 'ip', 90, now, false).ok).toBe(true);
    expect(w.touch('S60', 'ip', 90, now, false).reason).toBe('rate');
    expect(w.touch('S5', 'ip', 90, now, false).ok).toBe(true); // refresh
    for (let i = 60; i < 64; i++) expect(w.touch(`S${i}`, 'other', 90, now, false).ok).toBe(true);
    expect(w.touch('S64', 'other', 90, now + 1000, false).reason).toBe('full');
    now += WARM_EVICT_IDLE_MS + 1;
    expect(w.touch('S64', 'other', 90, now, false).ok).toBe(true); // the least recently touched (S0) is evicted
    expect(w.active(now)).not.toContain('S0');
    expect(w.active(now)[0]).toBe('S64');
    expect(w.active(now + 200_000)).toEqual([]);
  });
});
