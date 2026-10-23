import { describe, expect, test } from 'bun:test';
import { withHeadroom } from './gas';

describe('withHeadroom', () => {
  test('adds 30%', () => expect(withHeadroom(100_000n)).toBe(130_000n));
  test('rounds up', () => {
    expect(withHeadroom(1n)).toBe(2n);
    expect(withHeadroom(21_001n)).toBe(27_302n);
  });
  test('zero stays zero', () => expect(withHeadroom(0n)).toBe(0n));
});
