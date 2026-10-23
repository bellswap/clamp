import { describe, expect, test } from 'bun:test';
import { breakEvenMove, DEFAULT_MULTIPLE, feeRaw, meterFill, MULTIPLES, parseStake, payoutAt, payoutRaw, preview, priceAtMove } from './payout';
import { expiryOf, horizonName } from './horizon';

const e8 = (v: number) => BigInt(Math.round(v * 1e8));
const u6 = (v: number) => BigInt(Math.round(v * 1e6));

describe('payoutRaw mirrors the contract', () => {
  test('flat price returns the net stake', () => {
    expect(payoutRaw(u6(19.8), 5, e8(100), e8(100), true)).toBe(u6(19.8));
  });
  test('long 5x, +2 % pays net * 1.1', () => {
    expect(payoutRaw(u6(20), 5, e8(100), e8(102), true)).toBe(u6(22));
  });
  test('short 5x, +2 % pays net * 0.9', () => {
    expect(payoutRaw(u6(20), 5, e8(100), e8(102), false)).toBe(u6(18));
  });
  test('loss stops at zero', () => {
    expect(payoutRaw(u6(20), 10, e8(100), e8(80), true)).toBe(0n);
  });
  test('win stops at net * L', () => {
    expect(payoutRaw(u6(20), 2, e8(100), e8(300), true)).toBe(u6(40));
    expect(payoutRaw(u6(20), 20, e8(100), e8(50), false)).toBe(u6(220));
    expect(payoutRaw(u6(20), 20, e8(100), e8(1), false)).toBe(u6(400));
  });
  test('zero entry pays nothing', () => {
    expect(payoutRaw(u6(20), 2, 0n, e8(1), true)).toBe(0n);
  });
  test('fee in raw units', () => {
    expect(feeRaw(u6(20), 100)).toBe(u6(0.2));
  });
});

describe('multiples', () => {
  test('the sheet offers 2x, 5x, 10x, 20x with 5x preselected (no 1x)', () => {
    expect([...MULTIPLES]).toEqual([2, 5, 10, 20]);
    expect(DEFAULT_MULTIPLE).toBe(5);
  });
  test('every offered multiple can pay more than the net stake', () => {
    for (const L of MULTIPLES) {
      expect(preview(20, L, 100).maxPayout).toBeGreaterThan(preview(20, L, 100).net);
      expect(payoutRaw(u6(19.8), L, e8(100), e8(200), true)).toBeGreaterThan(u6(19.8));
    }
  });
});

describe('preview', () => {
  test('the live line at 20 USDG, 5x, 1 % fee', () => {
    expect(preview(20, 5, 100)).toEqual({ stake: 20, fee: 0.2, net: 19.8, maxPayout: 99, maxLoss: 20 });
  });
  test('no fee', () => {
    expect(preview(50, 20, 0).maxPayout).toBe(1000);
  });
  test('a small stake keeps the fee to six decimals like feeRaw (0.009999 at 1 %: 99 raw units, break even 502.50 at 2x)', () => {
    const pv = preview(0.009999, 2, 100);
    expect(pv.fee).toBe(Number(feeRaw(u6(0.009999), 100)) / 1e6);
    expect(pv.fee).toBe(0.000099);
    expect(pv.net).toBe(0.0099);
    expect(priceAtMove(500, breakEvenMove(pv.stake, pv.net, 2, true))).toBeCloseTo(502.5, 9);
  });
  test('invalid stake is zero', () => {
    expect(preview(Number.NaN, 5, 100).maxLoss).toBe(0);
    expect(preview(-3, 5, 100).maxPayout).toBe(0);
  });
  test('float payout agrees with the raw math', () => {
    for (const [L, entry, price, long] of [[5, 182.4, 181.1, false], [20, 10, 10.37, true], [2, 50, 49, true]] as const) {
      const raw = Number(payoutRaw(u6(19.8), L, e8(entry), e8(price), long)) / 1e6;
      expect(Math.abs(payoutAt(19.8, L, entry, price, long) - raw)).toBeLessThan(2e-6);
    }
  });
  test('meter fill is clamped', () => {
    expect(meterFill(50, 100)).toBe(0.5);
    expect(meterFill(150, 100)).toBe(1);
    expect(meterFill(5, 0)).toBe(0);
  });
  test('stake parsing', () => {
    expect(parseStake('20')).toBe(20);
    expect(parseStake('1,000.5')).toBe(1000.5);
    expect(parseStake('1e3')).toBeNaN();
    expect(parseStake('0.1234567')).toBeNaN();
  });
});

describe('horizon label', () => {
  test('Session, Day, Week; hidden when absent or unknown', () => {
    expect([0, 1, 2].map(horizonName)).toEqual(["Today's close", 'In 24 h', 'In 7 d']);
    expect(horizonName(null)).toBeNull();
    expect(horizonName(3)).toBeNull();
  });
});

describe('horizon expiry', () => {
  const t = Date.UTC(2026, 9, 19, 20, 0, 0) / 1000;
  test('session closes at the next 21:00 UTC', () => {
    expect(expiryOf(0, t) - t).toBe(3600);
    expect(expiryOf(0, t + 3600) - (t + 3600)).toBe(86400);
  });
  test('day and week, on the hour: no rounding', () => {
    expect(expiryOf(1, t) - t).toBe(86400);
    expect(expiryOf(2, t) - t).toBe(604800);
  });
  test('day and week round up to the next full hour like TicketBook.expiryFor', () => {
    const open = t + 1800; // 20:30 UTC
    expect(expiryOf(1, open)).toBe(t + 86400 + 3600); // tomorrow 21:00, not 20:30
    expect(expiryOf(2, open)).toBe(t + 7 * 86400 + 3600);
  });
});
