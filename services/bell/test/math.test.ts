import { describe, expect, test } from 'bun:test';
import { bytes32ToSymbol, feeOf, isWin, leaderboard, multiplier, ONE, payoutOf, POINTS_PER_SETTLED, POINTS_PER_WIN, reserveOf, symbolToBytes32 } from '../src/math';

const P = (x: number) => BigInt(Math.round(x * 1e8));

describe('payout math', () => {
  test('flat move pays the net stake back', () => {
    expect(payoutOf(99_000_000n, true, 5, P(100), P(100))).toBe(99_000_000n);
  });
  test('long 5x on +2 percent pays 1.10x', () => {
    expect(multiplier(true, 5, P(100), P(102))).toBe((ONE * 110n) / 100n);
    expect(payoutOf(99_000_000n, true, 5, P(100), P(102))).toBe(108_900_000n);
  });
  test('short 5x on -2 percent pays 1.10x, on +2 percent 0.90x', () => {
    expect(payoutOf(99_000_000n, false, 5, P(180), P(176.4))).toBe(108_900_000n);
    expect(payoutOf(99_000_000n, false, 5, P(100), P(102))).toBe(89_100_000n);
  });
  test('loss clamps at zero (no liquidation, at most the stake)', () => {
    expect(payoutOf(1_000_000n, true, 20, P(100), P(90))).toBe(0n);
    expect(payoutOf(1_000_000n, false, 20, P(100), P(200))).toBe(0n);
  });
  test('gain clamps at leverage times the net stake', () => {
    expect(payoutOf(1_000_000n, true, 10, P(100), P(500))).toBe(10_000_000n);
    expect(payoutOf(1_000_000n, true, 10, P(100), P(500))).toBe(reserveOf(1_000_000n, 10));
    expect(payoutOf(1_000_000n, false, 3, P(100), P(1))).toBe(3_000_000n);
  });
  test('fee in basis points', () => {
    expect(feeOf(100_000_000n, 100n)).toBe(1_000_000n);
    expect(feeOf(33n, 100n)).toBe(0n);
  });
  test('entry price zero throws', () => {
    expect(() => multiplier(true, 2, 0n, 1n)).toThrow();
  });
  test('symbol bytes32 round trip, right padded', () => {
    const h = symbolToBytes32('BRK.B');
    expect(h).toBe('0x42524b2e42000000000000000000000000000000000000000000000000000000');
    expect(bytes32ToSymbol(h)).toBe('BRK.B');
  });
});

describe('points', () => {
  test('10 per settled ticket, 25 more per win, net pnl per address', () => {
    const a = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    const b = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
    const rows = leaderboard([
      { owner: a, stake: 100_000_000n, payout: 150_000_000n },
      { owner: a, stake: 100_000_000n, payout: 0n },
      { owner: b, stake: 50_000_000n, payout: 60_000_000n },
      { owner: b.toLowerCase(), stake: 50_000_000n, payout: 70_000_000n },
    ]);
    expect(rows[0]!.address).toBe(b.toLowerCase());
    expect(rows[0]!.points).toBe(2 * POINTS_PER_SETTLED + 2 * POINTS_PER_WIN);
    expect(rows[0]!.pnlRaw).toBe('30000000');
    expect(rows[0]!.pnl).toBe(30);
    expect(rows[1]!.points).toBe(2 * POINTS_PER_SETTLED + POINTS_PER_WIN);
    expect(rows[1]!.pnlRaw).toBe('-50000000');
    expect(rows[1]!.wins).toBe(1);
  });
  test('a payout equal to the stake is not a win; ties sort by pnl', () => {
    expect(isWin({ stake: 10n, payout: 10n })).toBe(false);
    const rows = leaderboard([
      { owner: '0x01', stake: 10n, payout: 5n },
      { owner: '0x02', stake: 10n, payout: 9n },
    ]);
    expect(rows.map((r) => r.address)).toEqual(['0x02', '0x01']);
  });
});
