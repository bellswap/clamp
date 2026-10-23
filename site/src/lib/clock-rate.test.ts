import { describe, expect, test } from 'bun:test';
import { clockRate } from './clock-rate';

describe('clockRate', () => {
  test('bell speed is bars per wall minute: 60 bars of 300 s is 300 playground seconds per wall second', () => {
    expect(clockRate({ speed: 60, replay: { bar: 300 } })).toBe(300);
  });
  test('without a bar length the speed is the rate (mock mode)', () => {
    expect(clockRate({ speed: 60 })).toBe(60);
  });
  test('a paused replay holds the clock: rate 0', () => {
    expect(clockRate({ speed: 60, replay: { running: false, bar: 300 } })).toBe(0);
    expect(clockRate({ speed: 60, replay: { running: true, bar: 300 } })).toBe(300);
  });
  test('a zero or missing speed falls back to 1', () => {
    expect(clockRate({ speed: 0, replay: { bar: 300 } })).toBe(1);
  });
});
