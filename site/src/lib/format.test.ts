import { describe, expect, test } from 'bun:test';
import { bellWallLeft, fmtSettlesIn, nyOffsetHours, replayClockAfter, replaySchedule, replayTicksUntil, wallSecondsUntil } from './format';

describe('settlement countdown (C0 pick)', () => {
  test('minutes and seconds, seconds only under a minute, Settling when due', () => {
    expect(fmtSettlesIn(252)).toBe('Settles in 4 min 12 s');
    expect(fmtSettlesIn(60)).toBe('Settles in 1 min 0 s');
    expect(fmtSettlesIn(37)).toBe('Settles in 37 s');
    expect(fmtSettlesIn(0.4)).toBe('Settles in 1 s');
    expect(fmtSettlesIn(0)).toBe('Settling');
    expect(fmtSettlesIn(-5)).toBe('Settling');
  });
  test('wall seconds at the clock rate; a paused clock counts playground seconds', () => {
    expect(wallSecondsUntil(4600, 1000, 60)).toBe(60);
    expect(wallSecondsUntil(900, 1000, 60)).toBe(0);
    expect(wallSecondsUntil(1060, 1000, 0)).toBe(60);
  });
});

describe('replay-aware countdown (the night passes in one tick)', () => {
  const H = 3600;
  const day = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h, m) / 1000;
  const est = { open: 14.5 * H, last: 20 * H + 55 * 60, bar: 300 };
  const edt = { open: 13.5 * H, last: 19 * H + 55 * 60, bar: 300 };

  test('78-bar sessions at speed 60: from the last bar to the next day 21:00 close is 79 ticks, not 289 s', () => {
    const now = day(20, 20, 55);
    const exp = day(21, 21);
    expect(replayTicksUntil(exp, now, est)).toBe(79);
    // speed 60 bars per minute of 300 s bars: rate 300 playground s per wall s, one tick per wall second.
    expect(wallSecondsUntil(exp, now, 300, est)).toBe(79);
    expect(Math.round(wallSecondsUntil(exp, now, 300))).toBe(289);
  });

  test('a week ticket opened mid-session counts 7 nights as 7 ticks (546 s, not 33 min)', () => {
    const now = day(19, 15);
    const exp = day(26, 15);
    expect(replayTicksUntil(exp, now, edt)).toBe(546);
    expect(wallSecondsUntil(exp, now, 300, edt)).toBe(546);
  });

  test('inside the session the clock runs bar by bar; due or past gives 0', () => {
    expect(replayTicksUntil(day(20, 16), day(20, 15), edt)).toBe(12);
    expect(replayTicksUntil(day(20, 15), day(20, 15), edt)).toBe(0);
  });

  test('an interpolated clock past the last bar: part of the night tick left, or already at the next open', () => {
    expect(replayTicksUntil(day(21, 13, 30), day(20, 19, 57, ), edt)).toBeCloseTo(0.6, 5);
    // 1.5 ticks after the last bar the clock stands half a bar past the next open.
    expect(replayTicksUntil(day(21, 13, 40), day(20, 20, 2) + 30, edt)).toBeCloseTo(1.5, 5);
  });

  test('the schedule follows the clock time of day, else the wall date; off-hours clocks get none', () => {
    const july = Date.UTC(2026, 6, 1);
    const dec = Date.UTC(2026, 11, 1);
    expect(nyOffsetHours(july)).toBe(4);
    expect(nyOffsetHours(dec)).toBe(5);
    expect(nyOffsetHours(Date.UTC(2026, 10, 1, 5))).toBe(4);
    expect(nyOffsetHours(Date.UTC(2026, 10, 1, 7))).toBe(5);
    expect(replaySchedule(300, day(20, 13, 35), dec)).toEqual(edt);
    expect(replaySchedule(300, day(20, 20, 30), july)).toEqual(est);
    expect(replaySchedule(300, day(20, 15), july)).toEqual(edt);
    expect(replaySchedule(300, day(20, 3), july)).toBeNull();
    expect(replaySchedule(undefined, day(20, 15), july)).toBeNull();
  });

  test('a schedule decided at an earlier reading holds where both windows fit (frozen EDT recording in winter)', () => {
    const dec = Date.UTC(2026, 11, 1);
    expect(replaySchedule(300, day(20, 19, 55), dec)).toEqual(est);
    const s = replaySchedule(300, day(20, 19, 55), dec, edt)!;
    expect(s).toEqual(edt);
    // speed 60: one tick per wall second; the last bar is one tick from the 21:00 close, not 13.
    expect(wallSecondsUntil(day(20, 21), day(20, 19, 55), 300, s)).toBe(1);
    // A clock that fits only one window overrides the held schedule; another bar length drops it.
    expect(replaySchedule(300, day(20, 20, 30), dec, edt)).toEqual(est);
    expect(replaySchedule(60, day(20, 15), Date.UTC(2026, 6, 1), est)?.open).toBe(13.5 * H);
  });

  test('the clock between readings walks the ticks through every night', () => {
    // Inside the session bar by bar; inside the night tick the last bar plus the part spent; then the next open.
    expect(replayClockAfter(day(20, 15), 12, edt)).toBe(day(20, 16));
    expect(replayClockAfter(day(20, 19, 55), 0.4, edt)).toBe(day(20, 19, 57));
    expect(replayClockAfter(day(20, 19, 55), 1, edt)).toBe(day(21, 13, 30));
    expect(replayClockAfter(day(20, 15), 0, edt)).toBe(day(20, 15));
    // Speed 600 (rate 3000 s per wall s), 10 s between readings from 19:55: 100 ticks land two sessions later at 15:15.
    const c = replayClockAfter(day(20, 19, 55), (10 * 3000) / 300, edt);
    expect(c).toBe(day(22, 15, 15));
    expect(wallSecondsUntil(day(22, 21), c, 3000, edt)).toBeCloseTo(5.7, 6);
    // Speed 60 after 100 s without an answer: the same 100 ticks.
    expect(replayClockAfter(day(20, 19, 55), (100 * 300) / 300, edt)).toBe(day(22, 15, 15));
    // Many sessions at once: 78 ticks from one open to the next (77 bar steps and the night).
    expect(replayClockAfter(day(1, 13, 30), 78 * 20 + 6, edt)).toBe(day(21, 14));
  });

  test("the bell's tick count wins for its own expiries and counts down since it arrived", () => {
    const eta = { atMs: 1_000_000, points: [{ expiry: day(20, 21), wallS: 1 }, { expiry: day(21, 15), wallS: 70 }] };
    // A short session (last bar 17:55) jumps past the 21:00 close in one tick: the bell says 1 s.
    expect(bellWallLeft(day(20, 21), eta, 1_000_000)).toBe(1);
    expect(bellWallLeft(day(21, 15), eta, 1_010_000)).toBe(60);
    expect(bellWallLeft(day(20, 21), eta, 1_005_000)).toBe(0);
    expect(bellWallLeft(day(22, 21), eta, 1_000_000)).toBeNull();
    expect(bellWallLeft(day(20, 21), eta, 1_031_000)).toBeNull();
    expect(bellWallLeft(day(20, 21), null, 1_000_000)).toBeNull();
  });
});
