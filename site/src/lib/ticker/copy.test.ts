import { describe, expect, test } from 'bun:test';
import { TCOPY } from './copy';

// src/copy.test.ts BANNED plus the C0 mechanical check's two extra phrases for new strings.
const BANNED = ['around the clock', 'any source', 'thousands', 'one minute', 'launch fee', 'creator fee', 'audited', 'airdrop', 'soon', 'funding', 'will be', 'horizon'];

function strings(x: unknown): string[] {
  if (typeof x === 'string') return [x];
  if (typeof x === 'function') return strings((x as (...a: unknown[]) => unknown)('X', 'Y', 'Z'));
  if (Array.isArray(x)) return x.flatMap(strings);
  if (x && typeof x === 'object') return Object.values(x).flatMap(strings);
  return [];
}

describe('ticker copy', () => {
  const all = strings(TCOPY);
  test('no banned words', () => {
    for (const s of all) for (const b of BANNED) expect(s.toLowerCase().includes(b) ? `${b} in "${s}"` : '').toBe('');
  });
  const RH = new RegExp(`${'Robin'}${'hood'}(?! Chain| Markets, Inc\\.)`, 'g');
  test('the brand word only in its two allowed forms', () => {
    for (const s of all) for (const m of s.matchAll(RH)) expect(`${m[0]} in "${s}"`).toBe('');
  });
  test('no emoji', () => {
    for (const s of all) expect(/\p{Extended_Pictographic}/u.test(s) ? s : '').toBe('');
  });
  test('the C0 picks verbatim', () => {
    expect(TCOPY.settlesAt).toBe('Settles at');
    expect(TCOPY.option[0]('21:00', '52 s')).toBe("Today's close, 21:00 (52 s)");
    expect(TCOPY.option[1]('Sat 21:00', '24 min')).toBe('In 24 h, Sat 21:00 (24 min)');
    expect(TCOPY.option[2]('Oct 30 21:00', '2 h 48 min')).toBe('In 7 d, Oct 30 21:00 (2 h 48 min)');
    expect(TCOPY.countdown(3, 7)).toBe('Settles in 3 min 7 s');
    expect(TCOPY.countdownSec(42)).toBe('Settles in 42 s');
    expect(TCOPY.settling).toBe('Settling');
    expect(TCOPY.source).toBe('Recorded 5-minute prices, replayed on the playground clock.');
    expect(TCOPY.demoTitle).toBe('Demo trader. Opens tickets on a timer.');
    expect(TCOPY.emptyRecent('NVDA')).toBe('No tickets on NVDA.');
    expect([TCOPY.preparing, TCOPY.noFeed, TCOPY.getUsdg, TCOPY.demo]).toEqual(['Preparing market', 'No price feed', 'Get test USDG', 'demo']);
  });
});
