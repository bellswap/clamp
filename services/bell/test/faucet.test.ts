import { describe, expect, test } from 'bun:test';
import { FaucetLimiter, HttpError } from '../src/faucet';

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

function code(f: () => void): number | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
}

describe('faucet rate limit', () => {
  test('one call per address per cooldown, case insensitive, persisted in the log', () => {
    const log: Record<string, number> = {};
    const l = new FaucetLimiter(log, 3600);
    expect(code(() => l.claim(A, 'ip1', 1000))).toBeNull();
    expect(log[A.toLowerCase()]).toBe(1000);
    expect(code(() => l.claim(A.toLowerCase(), 'ip2', 1000 + 3599))).toBe(429);
    expect(code(() => l.claim(A, 'ip2', 1000 + 3600))).toBeNull();
  });
  test('429 carries nextAllowedAt', () => {
    const l = new FaucetLimiter({}, 600);
    l.claim(A, 'ip', 50);
    try {
      l.claim(A, 'ip', 60);
      throw new Error('no throw');
    } catch (e) {
      expect((e as HttpError).extra.nextAllowedAt).toBe(650);
    }
  });
  test('per IP window caps fresh addresses', () => {
    const l = new FaucetLimiter({}, 3600, 2, 3600);
    expect(code(() => l.claim(A, 'ip', 0))).toBeNull();
    expect(code(() => l.claim(B, 'ip', 1))).toBeNull();
    expect(code(() => l.claim('0x90F79bf6EB2c4f870365E785982E1f101E93b906', 'ip', 2))).toBe(429);
    expect(code(() => l.claim('0x90F79bf6EB2c4f870365E785982E1f101E93b906', 'other', 2))).toBeNull();
    expect(code(() => l.claim('0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', 'ip', 3600))).toBeNull();
  });
  test('release gives the window back after a failed send', () => {
    const log: Record<string, number> = {};
    const l = new FaucetLimiter(log, 3600, 1, 3600);
    l.claim(A, 'ip', 0);
    l.release(A, 'ip');
    expect(log[A.toLowerCase()]).toBeUndefined();
    expect(code(() => l.claim(A, 'ip', 1))).toBeNull();
  });
});
