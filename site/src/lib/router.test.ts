import { describe, expect, test } from 'bun:test';
import { match, scrollsToTop } from './route-match';

describe('match', () => {
  test('decodes params', () => {
    expect(match('/t/:symbol', '/t/BRK%2EB')).toEqual({ symbol: 'BRK.B' });
  });
  test('a malformed escape is no match instead of a throw', () => {
    expect(match('/t/:symbol', '/t/%')).toBeNull();
    expect(match('/ticket/:id', '/ticket/%E0%A4%A')).toBeNull();
  });
});

describe('scrollsToTop (navigate)', () => {
  test('a board row with the state hash opens the ticker at the top', () => {
    expect(scrollsToTop('/', '/t/NVDA#q=nv&sort=move')).toBe(true);
    expect(scrollsToTop('/', '/t/NVDA?side=long#q=nv')).toBe(true);
  });
  test('a hash change on the same page keeps the scroll; a plain path always scrolls', () => {
    expect(scrollsToTop('/', '/#q=nv')).toBe(false);
    expect(scrollsToTop('/t/NVDA', '/t/NVDA#x')).toBe(false);
    expect(scrollsToTop('/t/NVDA', '/me')).toBe(true);
  });
});
