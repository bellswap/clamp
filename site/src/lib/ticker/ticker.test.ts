import { describe, expect, test } from 'bun:test';
import { expiryOf } from '../horizon';
import { breakEvenMove, maxPayoutMove, paysNothingMove, payoutAt, preview, priceAtMove } from '../payout';
import { aggregate, fromCloses, legendOf, mergeTail, rebaseRange, type Candle } from './candles';
import { anchorsOf, DAY_SWITCH_WALL_S, defaultHorizon, etaWall, fmtCountdownWall, fmtEta, fmtSettleTime, marketNow, settleOptions, settlesName } from './settles-at';
import { readyOf, READY_GRACE_MS } from './hooks';
import { FRESH_WINDOW_S, printFresh, toMarket } from './ticker-api';

const k = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c });

describe('candles', () => {
  test('5-minute candles open at the previous close, high and low span open and close', () => {
    const c = fromCloses([{ t: 0, c: 10 }, { t: 300, c: 12 }, { t: 600, c: 11 }], 9);
    expect(c).toEqual([k(0, 9, 10, 9, 10), k(300, 10, 12, 10, 12), k(600, 12, 12, 11, 11)]);
    expect(fromCloses([{ t: 0, c: 5 }])[0]).toEqual(k(0, 5, 5, 5, 5));
  });
  test('15m aggregates three 5m candles; the forming bucket carries what it has', () => {
    const c5 = fromCloses([10, 12, 9, 11, 13].map((c, i) => ({ t: 900 + i * 300, c })), 10);
    expect(aggregate(c5, '15m')).toEqual([k(900, 10, 12, 9, 9), k(1800, 9, 13, 9, 13)]);
    expect(aggregate(c5, '5m')).toEqual(c5);
  });
  test('1h buckets align to the hour', () => {
    const c5 = fromCloses(Array.from({ length: 14 }, (_, i) => ({ t: 3600 + 2700 + i * 300, c: 100 + i })), 100);
    const h = aggregate(c5, '1h');
    expect(h.map((x) => x.t)).toEqual([3600, 7200]);
    expect(h[0]).toEqual(k(3600, 100, 102, 100, 102));
    expect(h[1]!.o).toBe(102);
    expect(h[1]!.c).toBe(113);
  });
});

describe('mergeTail (the 1.5 s poll of the last three candles)', () => {
  const win = [k(0, 1, 2, 1, 2), k(300, 2, 3, 2, 3), k(600, 3, 4, 3, 3.5)];
  test('the forming candle updates in place and a new one appends, in time order', () => {
    const m = mergeTail(win, [k(300, 2, 3, 2, 3), k(600, 3, 4, 3, 3.8), k(900, 3.8, 3.9, 3.7, 3.7)]);
    expect(m.reset).toBe(false);
    expect(m.updates).toEqual([k(600, 3, 4, 3, 3.8), k(900, 3.8, 3.9, 3.7, 3.7)]);
    expect(m.candles.length).toBe(4);
    expect(m.candles[2]!.c).toBe(3.8);
  });
  test('an unchanged tail is no update', () => {
    const m = mergeTail(win, win.slice(1));
    expect(m).toEqual({ candles: win, updates: [], reset: false });
  });
  test('a tail with no overlap asks for a reload (candles may be missing)', () => {
    expect(mergeTail(win, [k(1200, 1, 1, 1, 1), k(1500, 1, 1, 1, 1)]).reset).toBe(true);
    expect(mergeTail([], [k(0, 1, 1, 1, 1)]).reset).toBe(true);
  });
  test('a closed candle that changed asks for a reload', () => {
    expect(mergeTail(win, [k(300, 2, 3, 2, 2.9), k(600, 3, 4, 3, 3.5)]).reset).toBe(true);
  });
  test('the input arrays are not mutated, and an unsorted tail is sorted', () => {
    const copy = JSON.parse(JSON.stringify(win)) as Candle[];
    const m = mergeTail(win, [k(900, 3.5, 3.6, 3.5, 3.6), k(600, 3, 4, 3, 3.5)]);
    expect(win).toEqual(copy);
    expect(m.updates.map((x) => x.t)).toEqual([900]);
  });
  test('legend: the candle under the crosshair, else the last', () => {
    expect(legendOf(win, 300)?.c).toBe(3);
    expect(legendOf(win, null)?.t).toBe(600);
    expect(legendOf(win, 999)?.t).toBe(600);
    expect(legendOf([], null)).toBeNull();
    expect(legendOf(win, 0)?.movePct).toBeCloseTo(100, 9);
  });
});

describe('rebaseRange (the chart keeps its view when the candle window is replaced or trimmed)', () => {
  const win = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: (from + i) * 300 }));
  test('recovery: 400 accumulated candles viewed at the newest edge, reloaded as the last 300, stay on the newest', () => {
    expect(rebaseRange({ from: 290, to: 403 }, win(0, 400), win(100, 300))).toEqual({ from: 190, to: 303 });
  });
  test('recovery on older candles moves to the same candles by time', () => {
    expect(rebaseRange({ from: 200, to: 250 }, win(0, 400), win(100, 300))).toEqual({ from: 100, to: 150 });
  });
  test('trim: 600 candles viewed at 0 to 110, one append drops 301; the oldest kept candles fill the same width', () => {
    expect(rebaseRange({ from: 0, to: 110 }, win(0, 600), win(301, 300))).toEqual({ from: 0, to: 110 });
  });
  test('trim at the newest edge follows the new candle; empty windows give the default view', () => {
    expect(rebaseRange({ from: 490, to: 602 }, win(0, 600), win(301, 300))).toEqual({ from: 190, to: 302 });
    expect(rebaseRange({ from: 0, to: 10 }, [], win(0, 3))).toBeNull();
    expect(rebaseRange({ from: 0, to: 10 }, win(0, 3), [])).toBeNull();
  });
});

describe('Settles at', () => {
  const day = Date.UTC(2026, 9, 23) / 1000;
  const close = day + 21 * 3600;
  test("Today's close is the default while the close is 15 wall seconds or more away", () => {
    expect(defaultHorizon(close - 60 * 60, 60)).toBe(0);
    expect(defaultHorizon(close - DAY_SWITCH_WALL_S * 60, 60)).toBe(0); // exactly 15 wall s at 60x
  });
  test('In 24 h becomes the default under 15 wall seconds', () => {
    expect(defaultHorizon(close - 14 * 60, 60)).toBe(1);
    expect(defaultHorizon(close - 1, 300)).toBe(1);
  });
  test('a held clock (rate 0) keeps the close as the default', () => {
    expect(defaultHorizon(close - 1, 0)).toBe(0);
    expect(etaWall(close, close - 10, 0)).toBeNull();
  });
  test('after the close, Today\'s close is the next day\'s 21:00', () => {
    expect(expiryOf(0, close)).toBe(close + 86400);
    expect(defaultHorizon(close + 1, 60)).toBe(0);
  });
  test('options carry fork time and wall ETA in the C0 format', () => {
    const now = close - 52 * 60; // 20:08 fork time, 52 wall s at 60x
    const o = settleOptions(now, 60);
    expect(o.map((x) => x.horizon)).toEqual([0, 1, 2]);
    expect(o[0]!.label).toBe("Today's close, 21:00 (52 s)");
    expect(o[1]!.expiry).toBe(close + 86400);
    expect(o[1]!.label).toBe('In 24 h, Sat 21:00 (24 min 52 s)');
    expect(o[2]!.label).toBe('In 7 d, Oct 30 21:00 (2 h 48 min)');
    expect(settleOptions(now, 0)[0]!.label).toBe("Today's close, 21:00");
  });
  test('ETA and countdown formats', () => {
    expect(fmtEta(0.2)).toBe('1 s');
    expect(fmtEta(187)).toBe('3 min 7 s');
    expect(fmtEta(8040)).toBe('2 h 14 min');
    expect(fmtCountdownWall(42)).toBe('Settles in 42 s');
    expect(fmtCountdownWall(187)).toBe('Settles in 3 min 7 s');
    expect(fmtCountdownWall(0)).toBe('Settling');
    expect(fmtCountdownWall(null)).toBe('');
    expect(fmtSettleTime(close, close - 100)).toBe('21:00');
  });
  test('short names replace Session, Day and Week', () => {
    expect([0, 1, 2, 3, null].map(settlesName)).toEqual(["Today's close", 'In 24 h', 'In 7 d', null, null]);
  });
});

describe("Settles at follows the bell's tick-counted ETAs (the replay jumps each night)", () => {
  const day = Date.UTC(2026, 9, 23) / 1000;
  const close = day + 21 * 3600;
  const at = 1_000_000;
  // Fork 15:00 at rate 300: linear says 72 s, 288 s and 2016 s; the bell counts the recorded bars to 19:55 plus the jump.
  const clock = day + 15 * 3600;
  const m = { clockUnix: clock, atMs: at, expiries: { session: close, day: expiryOf(1, clock), week: expiryOf(2, clock) }, etaWall: { session: 60, day: 78, week: 540 } };
  const a = anchorsOf(m)!;
  test('the three options show the ETAs of the bell, not (expiry - now) / rate', () => {
    const o = settleOptions(clock, 300, a, at);
    expect(o.map((x) => x.etaWall)).toEqual([60, 78, 540]);
    expect(o[1]!.label).toBe('In 24 h, Sat 15:00 (1 min 18 s)');
    expect(o[2]!.label).toBe('In 7 d, Oct 30 15:00 (9 min 0 s)');
    expect(settleOptions(clock, 300)[1]!.label).toBe('In 24 h, Sat 15:00 (4 min 48 s)'); // no anchors: linear
  });
  test('the ETAs count down from the wall time they arrived', () => {
    expect(etaWall(close, clock, 300, a, at + 2500)).toBe(57.5);
    expect(etaWall(close, clock, 300, a, at + 90_000)).toBe(0);
  });
  test('a ticket expiry between two anchors follows the replay: bars at the rate, the night in the one jump tick', () => {
    // The anchors put the last bar's end at 15:00 + 60 s * 300 = 20:00 and the next open at Sat 15:00 - 18 s * 300 = 13:30.
    const mid = (close + m.expiries.day) / 2; // Sat 06:00, inside the night: reached by the jump
    expect(etaWall(mid, clock, 300, a, at)).toBe(60);
    expect(etaWall(day + 86_400 + 14 * 3600, clock, 300, a, at)).toBe(66); // Sat 14:00: the jump, then six bars
    expect(etaWall(clock - 60, clock, 300, a, at)).toBe(0);
    expect(etaWall(clock + 1800, clock, 300, a, at)).toBeCloseTo(6, 9); // six bars before the close
    expect(etaWall(day + 20.5 * 3600, clock, 300, a, at)).toBe(60); // after the last bar, before the close
  });
  test('review case: fork 15:00:01, speed 60 bars a minute (rate 300), ETAs 60/90/558; a ticket at Sat 14:00 is 66 s', () => {
    const c = clock + 1;
    const b = anchorsOf({ clockUnix: c, atMs: at, expiries: { session: close, day: expiryOf(1, c), week: expiryOf(2, c) }, etaWall: { session: 60, day: 90, week: 558 } })!;
    expect(etaWall(day + 86_400 + 14 * 3600, c, 300, b, at)).toBeCloseTo(66, 6);
    expect(etaWall(expiryOf(1, c), c, 300, b, at)).toBe(90);
    expect(etaWall(expiryOf(2, c), c, 300, b, at)).toBe(558);
  });
  test('without Today\'s close and In 24 h among the anchors the interpolation stays in fork seconds', () => {
    const b = anchorsOf({ ...m, etaWall: { session: null, day: 78, week: 540 } })!;
    expect(etaWall((clock + m.expiries.day) / 2, clock, 300, b, at)).toBe(39);
  });
  test('the D7 switch uses the bell ETA: fork 19:45 at rate 300 is 15 s linear but 3 s to the posted close', () => {
    const c = day + 19 * 3600 + 45 * 60;
    const b = anchorsOf({ clockUnix: c, atMs: at, expiries: { session: close, day: expiryOf(1, c), week: expiryOf(2, c) }, etaWall: { session: 3, day: 21, week: 483 } });
    expect(defaultHorizon(c, 300, null, at)).toBe(0);
    expect(defaultHorizon(c, 300, b, at)).toBe(1);
  });
  test('expiries follow the market clock when the App clock lags the nightly jump', () => {
    // The market answer says Sat 13:30 with 78 s to Sat 21:00; the App clock still reads Fri 20:00.
    const c = day + 86_400 + 13.5 * 3600;
    const satClose = close + 86_400;
    const b = anchorsOf({ clockUnix: c, atMs: at, expiries: { session: satClose, day: expiryOf(1, c), week: expiryOf(2, c) }, etaWall: { session: 78, day: 156, week: 546 } })!;
    const app = day + 20 * 3600;
    expect(marketNow(app, b, at)).toBe(c);
    expect(defaultHorizon(app, 300, b, at)).toBe(0);
    expect(settleOptions(app, 300, b, at)[0]).toMatchObject({ expiry: satClose, etaWall: 78 });
    expect(marketNow(app, null, at)).toBe(app);
    expect(marketNow(c + 600, b, at)).toBe(c + 600); // the App clock ahead within a session wins
    expect(marketNow(app, b, at + 78_000)).toBe(satClose); // the anchors' close has passed: the next one counts
  });
  test('no anchors without a clock or ETAs; a paused bell (null ETAs) falls back to the rate', () => {
    expect(anchorsOf({ ...m, clockUnix: null })).toBeNull();
    expect(anchorsOf({ ...m, etaWall: { session: null, day: null, week: null } })).toBeNull();
    expect(anchorsOf(null)).toBeNull();
    expect(etaWall(close, clock, 0, a, at)).toBeNull();
  });
});

describe('Open stays available between ticks and across the nightly jump', () => {
  const P = Date.UTC(2026, 9, 23, 15) / 1000;
  const mk = (clockUnix: number | null, t: number, fresh: boolean) => toMarket({ symbol: 'nvda', tradable: true, fresh, clockUnix, lastRound: { t, price8: '10000000000' } }, 0)!;
  test('a block mined after the bar gap keeps the print fresh (the bell says clock - t <= 300)', () => {
    expect(printFresh(mk(P + 300, P, true))).toBe(true);
    expect(printFresh(mk(P + 301, P, false))).toBe(true);
    expect(printFresh(mk(P + FRESH_WINDOW_S, P, false))).toBe(true);
    expect(mk(P + 301, P, false).ready).toBe(true);
  });
  test('a print older than two bars, or no clock, is not fresh', () => {
    expect(printFresh(mk(P + FRESH_WINDOW_S + 1, P, false))).toBe(false);
    expect(printFresh(mk(null, P, false))).toBe(false);
  });
  test('after the jump (21:00 re-post, clock 13:30 next day) a market fresh a moment ago stays ready', () => {
    const jumped = mk(Date.UTC(2026, 9, 24, 13, 30) / 1000, Date.UTC(2026, 9, 23, 21) / 1000, false);
    expect(printFresh(jumped)).toBe(false);
    expect(readyOf(jumped, 10_000, 11_000)).toBe(true);
    expect(readyOf(jumped, 10_000, 10_000 + READY_GRACE_MS)).toBe(false);
    expect(readyOf(jumped, null, 11_000)).toBe(false);
  });
});

describe('ticket levels against payout.ts', () => {
  const entry = 182.4;
  for (const L of [2, 5, 10, 20]) {
    for (const long of [true, false]) {
      const pv = preview(20, L, 100);
      test(`break even, pays nothing and max payout at ${L}x ${long ? 'long' : 'short'}`, () => {
        const be = priceAtMove(entry, breakEvenMove(pv.stake, pv.net, L, long));
        expect(payoutAt(pv.net, L, entry, be, long)).toBeCloseTo(pv.stake, 4);
        // break even sits on the winning side of the entry
        expect(long ? be > entry : be < entry).toBe(true);
        const zero = priceAtMove(entry, paysNothingMove(L, long));
        expect(payoutAt(pv.net, L, entry, zero, long)).toBeCloseTo(0, 6);
        const inside = priceAtMove(entry, paysNothingMove(L, long) * 0.98);
        expect(payoutAt(pv.net, L, entry, inside, long)).toBeGreaterThan(0);
        const cap = priceAtMove(entry, maxPayoutMove(L, long));
        expect(payoutAt(pv.net, L, entry, cap, long)).toBeCloseTo(pv.maxPayout, 4);
        const below = priceAtMove(entry, maxPayoutMove(L, long) * 0.98);
        expect(payoutAt(pv.net, L, entry, below, long)).toBeLessThan(pv.maxPayout);
      });
    }
  }
  test('the moves of the plan: -1/L long, +1/L short, (stake/net - 1)/L', () => {
    expect(paysNothingMove(5, true)).toBe(-0.2);
    expect(paysNothingMove(5, false)).toBe(0.2);
    expect(breakEvenMove(20, 19.8, 5, true)).toBeCloseTo((20 / 19.8 - 1) / 5, 12);
    expect(breakEvenMove(20, 19.8, 5, false)).toBeCloseTo(-(20 / 19.8 - 1) / 5, 12);
  });
});
