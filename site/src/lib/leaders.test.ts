import { describe, expect, test } from 'bun:test';
import { LEADER_LIMIT, LEADER_MIN_STAKED, leaderOrder, rankLeaders } from './leaders';
import { toLeaderboard } from './normalize';
import type { LeaderRow } from './types';

const row = (address: string, staked: number, pnl: number, points = 10): LeaderRow => ({ address, settled: 1, wins: 0, staked, pnl, roiPct: (pnl / staked) * 100, points });

describe('leaderboard ranking', () => {
  test('the minimum filter runs before the 100-row cap', () => {
    // 101 eligible addresses ahead by points; the best ROI belongs to the one with the fewest points
    const busy = Array.from({ length: 101 }, (_, i) => row(`0x${String(i).padStart(3, '0')}`, 200, 10, 1000 - i));
    const best = row('0xbest', 100, 90, 1);
    const small = row('0xsmall', 99.999999, 500, 5000);
    const ranked = rankLeaders([...busy, small, best]);
    expect(ranked.length).toBe(LEADER_LIMIT);
    expect(ranked[0]!.address).toBe('0xbest');
    expect(ranked.some((r) => r.address === '0xsmall')).toBe(false);
  });
  test('exactly the minimum is ranked; zero stake never', () => {
    expect(rankLeaders([row('0xa', LEADER_MIN_STAKED, -5)]).map((r) => r.address)).toEqual(['0xa']);
    expect(rankLeaders([row('0xz', 0, 0)], 0)).toEqual([]);
  });
  test('ties fall back to points, then address, like the bell', () => {
    const r = rankLeaders([row('0xc', 200, 20, 5), row('0xb', 100, 10, 5), row('0xa', 100, 10, 9)]);
    expect(r.map((x) => x.address)).toEqual(['0xa', '0xb', '0xc']);
  });
  test('the whole order keeps unranked rows after the ranked ones', () => {
    const o = leaderOrder([row('0xlow', 50, 40), row('0xa', 100, 1), row('0xb', 100, 2)]);
    expect(o.map((x) => x.address)).toEqual(['0xb', '0xa', '0xlow']);
  });
  test('the bell answer: raw units and its floor are read', () => {
    const b = toLeaderboard({ minStakedRaw: '100000000', rows: [{ address: '0xa', points: 15, settled: 1, wins: 1, pnlRaw: '5000000', pnl: 5, stakedRaw: '100000000', staked: 100 }] });
    expect(b.minStaked).toBe(100);
    expect(b.rows[0]).toMatchObject({ address: '0xa', staked: 100, pnl: 5, roiPct: 5, points: 15 });
    expect(toLeaderboard({ rows: [] }).minStaked).toBe(LEADER_MIN_STAKED);
    expect(toLeaderboard([]).rows).toEqual([]);
  });
});
