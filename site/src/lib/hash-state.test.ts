import { describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD, parseHash, toHash } from './hash-state';

describe('board hash state', () => {
  test('empty hash is the default board with the toggle off', () => {
    expect(parseHash('')).toEqual(DEFAULT_BOARD);
    expect(parseHash('#').rh).toBe(false);
    expect(toHash(DEFAULT_BOARD)).toBe('');
  });
  test('round trip', () => {
    const s = { rh: true, sort: 'cap' as const, range: '5d' as const, q: 'nv' };
    expect(toHash(s)).toBe('#rh=1&sort=cap&r=5d&q=nv');
    expect(parseHash(toHash(s))).toEqual(s);
  });
  test('unknown values fall back to defaults', () => {
    expect(parseHash('#sort=volume&r=10y&rh=yes')).toEqual(DEFAULT_BOARD);
  });
  test('search is trimmed and capped', () => {
    expect(toHash({ ...DEFAULT_BOARD, q: '  amd ' })).toBe('#q=amd');
    expect(parseHash(`#q=${'x'.repeat(100)}`).q.length).toBe(40);
  });
});
