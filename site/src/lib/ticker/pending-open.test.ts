import { describe, expect, test } from 'bun:test';
import { claimOpen, openStep, setOpenStep } from './pending-open';

describe('pending open (one ticket open at a time per tab)', () => {
  test('a second submit, from a sheet closed and reopened mid-open, cannot claim the guard until the first ends', () => {
    expect(openStep()).toBe('idle');
    expect(claimOpen()).toBe(true);
    expect(openStep()).toBe('approving');
    expect(claimOpen()).toBe(false); // the remounted form reads 'approving' and stays disabled
    setOpenStep('opening');
    expect(claimOpen()).toBe(false);
    setOpenStep('idle');
    expect(claimOpen()).toBe(true);
    setOpenStep('idle');
  });
});
