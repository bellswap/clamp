import { describe, expect, test } from 'bun:test';
import {
  expDelay,
  guardReason,
  LIMITS,
  lpFirstDepositRaw,
  lpNextMs,
  lpRebalance,
  pickAmountRaw,
  pickHorizon,
  pickMultiple,
  pickSide,
  pickSymbol,
  RevertTracker,
  seeded,
  tickAgeMs,
  USDG,
  type GuardIn,
} from '../src/strategy';

const N = 40_000;
const share = <T>(xs: T[], v: T) => xs.filter((x) => x === v).length / xs.length;

describe('picks', () => {
  test('multiples 2/5/10/20 at 25/35/25/15 %', () => {
    const r = seeded(1);
    const xs = Array.from({ length: N }, () => pickMultiple(r));
    expect(share(xs, 2)).toBeCloseTo(0.25, 1);
    expect(share(xs, 5)).toBeCloseTo(0.35, 1);
    expect(share(xs, 10)).toBeCloseTo(0.25, 1);
    expect(share(xs, 20)).toBeCloseTo(0.15, 1);
    expect(Math.abs(share(xs, 20) - 0.15)).toBeLessThan(0.01);
  });
  test('multiple never above maxLeverage', () => {
    const r = seeded(2);
    for (let i = 0; i < 2000; i++) expect(pickMultiple(r, 10)).toBeLessThanOrEqual(10);
    for (let i = 0; i < 200; i++) expect(pickMultiple(r, 3)).toBe(2);
    expect(pickMultiple(r, 1)).toBe(1);
  });
  test('horizons session/day/week at 55/30/15 %', () => {
    const r = seeded(3);
    const xs = Array.from({ length: N }, () => pickHorizon(r));
    expect(Math.abs(share(xs, 0) - 0.55)).toBeLessThan(0.01);
    expect(Math.abs(share(xs, 1) - 0.3)).toBeLessThan(0.01);
    expect(Math.abs(share(xs, 2) - 0.15)).toBeLessThan(0.01);
  });
  test('amounts 5 to 250 USDG, whole USDG, skewed small, capped by maxStake', () => {
    const r = seeded(4);
    const xs = Array.from({ length: N }, () => pickAmountRaw(r));
    for (const x of xs) {
      expect(x >= 5n * USDG && x <= 250n * USDG).toBe(true);
      expect(x % USDG).toBe(0n);
    }
    const sorted = xs.map((x) => Number(x / USDG)).sort((a, b) => a - b);
    expect(sorted[Math.floor(N / 2)]!).toBeLessThan(80);
    expect(sorted[Math.floor(N * 0.95)]!).toBeGreaterThan(150);
    expect(pickAmountRaw(() => 0.999, 100n * USDG)).toBe(100n * USDG);
  });
  test('side: half momentum, half reversal on a rising tape; coin flip when flat', () => {
    const r = seeded(5);
    const up = Array.from({ length: N }, () => pickSide(r, [100, 101, 102]));
    expect(Math.abs(share(up, true) - 0.5)).toBeLessThan(0.015);
    const det = (u: number) => () => u;
    expect(pickSide(det(0.1), [100, 101, 102])).toBe(true); // momentum on up
    expect(pickSide(det(0.9), [100, 101, 102])).toBe(false); // reversal on up
    expect(pickSide(det(0.1), [102, 101, 100])).toBe(false); // momentum on down
    expect(pickSide(det(0.9), [102, 101, 100])).toBe(true); // reversal on down
    const flat = Array.from({ length: 4000 }, () => pickSide(r, [100, 100, 100]));
    expect(Math.abs(share(flat, true) - 0.5)).toBeLessThan(0.04);
    expect(typeof pickSide(r, [])).toBe('boolean');
  });
  test('symbols: 40 % core, 60 % uniform over non-core', () => {
    const r = seeded(6);
    const core = ['NVDA', 'SPY'];
    const non = ['AAA', 'BBB', 'CCC', 'DDD'];
    const xs = Array.from({ length: N }, () => pickSymbol(r, core, non)!);
    expect(Math.abs(xs.filter((x) => x.core).length / N - 0.4)).toBeLessThan(0.01);
    const nonPicks = xs.filter((x) => !x.core).map((x) => x.symbol);
    for (const s of non) expect(Math.abs(share(nonPicks, s) - 0.25)).toBeLessThan(0.015);
    expect(pickSymbol(r, core, [])!.core).toBe(true);
    expect(pickSymbol(r, [], non)!.core).toBe(false);
    expect(pickSymbol(r, [], [])).toBeNull();
  });
  test('Poisson inter-arrival mean', () => {
    const r = seeded(7);
    const xs = Array.from({ length: N }, () => expDelay(3000, r));
    const mean = xs.reduce((a, b) => a + b, 0) / N;
    expect(Math.abs(mean - 3000)).toBeLessThan(90);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });
});

describe('guards', () => {
  const base: GuardIn = { vaultFree: 600n, vaultAssets: 1000n, oi: 0n, oiCap: 20_000n * USDG, amount: 100n * USDG, botOpen: 0, fleetOpen: 0, tickAgeMs: 1000, backoffUntil: 0, now: 10_000 };
  test('passes a normal open', () => expect(guardReason(base)).toBeNull());
  test('vault free at least 40 % of assets', () => {
    expect(guardReason({ ...base, vaultFree: 400n })).toBeNull();
    expect(guardReason({ ...base, vaultFree: 399n })).toBe('vault-free');
    expect(guardReason({ ...base, vaultAssets: 0n, vaultFree: 0n })).toBe('vault-free');
  });
  test('market oi plus amount at most 80 % of oiCap', () => {
    expect(guardReason({ ...base, oi: 15_900n * USDG })).toBeNull();
    expect(guardReason({ ...base, oi: 15_901n * USDG })).toBe('oi-cap');
  });
  test('at most 6 per bot and 150 overall', () => {
    expect(guardReason({ ...base, botOpen: 5 })).toBeNull();
    expect(guardReason({ ...base, botOpen: 6 })).toBe('bot-cap');
    expect(guardReason({ ...base, fleetOpen: 149 })).toBeNull();
    expect(guardReason({ ...base, fleetOpen: 150 })).toBe('fleet-cap');
  });
  test('pause while the bell tick is older than 20 s', () => {
    expect(guardReason({ ...base, tickAgeMs: 20_000 })).toBeNull();
    expect(guardReason({ ...base, tickAgeMs: 20_001 })).toBe('bell-stalled');
    expect(guardReason({ ...base, tickAgeMs: Infinity })).toBe('bell-stalled');
  });
  test('back-off window', () => expect(guardReason({ ...base, backoffUntil: 10_001 })).toBe('backoff'));
  test('tick age accepts ms and s timestamps', () => {
    expect(tickAgeMs(1_700_000_000_000, 1_700_000_005_000)).toBe(5000);
    expect(tickAgeMs(1_700_000_000, 1_700_000_005_000)).toBe(5000);
    expect(tickAgeMs(null, 1)).toBe(Infinity);
    expect(tickAgeMs(0, 1)).toBe(Infinity);
  });
  test('60 s back-off after 5 consecutive reverts; a success resets the streak', () => {
    const t = new RevertTracker();
    for (let i = 0; i < 4; i++) t.revert('sim:Stale', 1000);
    expect(t.backoffUntil).toBe(0);
    t.ok();
    for (let i = 0; i < 4; i++) t.revert('sim:Stale', 1000);
    expect(t.backoffUntil).toBe(0);
    t.revert('tx:reverted', 2000);
    expect(t.backoffUntil).toBe(2000 + LIMITS.backoffMs);
    expect(t.byReason).toEqual({ 'sim:Stale': 8, 'tx:reverted': 1 });
    expect(t.total).toBe(9);
  });
});

describe('LP plan', () => {
  test('first deposit 25k to 150k in whole thousands', () => {
    const r = seeded(8);
    for (let i = 0; i < 5000; i++) {
      const x = lpFirstDepositRaw(r);
      expect(x >= 25_000n * USDG && x <= 150_000n * USDG).toBe(true);
      expect(x % (1000n * USDG)).toBe(0n);
    }
  });
  test('rebalance at most 10 % of the position, withdraw capped by maxWithdraw', () => {
    const r = seeded(9);
    const pos = 100_000n * USDG;
    let deposits = 0;
    for (let i = 0; i < 4000; i++) {
      const p = lpRebalance(r, pos, 3_000n * USDG)!;
      expect(p.amount <= pos / 10n).toBe(true);
      expect(p.amount >= 2_000n * USDG || p.kind === 'withdraw').toBe(true);
      if (p.kind === 'withdraw') expect(p.amount <= 3_000n * USDG).toBe(true);
      else deposits += 1;
    }
    expect(Math.abs(deposits / 4000 - 0.5)).toBeLessThan(0.04);
    expect(lpRebalance(r, 0n, 0n)).toBeNull();
  });
  test('about every 20 minutes', () => {
    const r = seeded(10);
    for (let i = 0; i < 1000; i++) {
      const ms = lpNextMs(r);
      expect(ms >= 15 * 60_000 && ms <= 25 * 60_000).toBe(true);
    }
  });
});
