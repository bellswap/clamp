// isStaleRevert (lib/wallet.ts): the open is simulated with the TicketBook ABI, so the reference's NoRound arrives
// as an unknown selector; the warm-and-retry must still run.
import { describe, expect, test } from 'bun:test';

(globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => undefined };
const { isStaleRevert, NO_ROUND_SELECTOR } = await import('../wallet');

describe('isStaleRevert', () => {
  test('NoRound(bytes32) has the selector the reference reverts with', () => {
    expect(NO_ROUND_SELECTOR).toBe('0x9c34c127');
  });
  test('a NoRound revert decoded without its ABI entry (signature, raw data or message) counts', () => {
    expect(isStaleRevert({ shortMessage: 'execution reverted', cause: { signature: '0x9c34c127' } })).toBe(true);
    expect(isStaleRevert({ cause: { data: `0x9C34C127${'00'.repeat(32)}` } })).toBe(true);
    expect(isStaleRevert(new Error('Encoded error signature "0x9c34c127" not found on ABI.'))).toBe(true);
  });
  test('named Stale and NoRound count; other reverts do not', () => {
    expect(isStaleRevert({ cause: { data: { errorName: 'Stale' } } })).toBe(true);
    expect(isStaleRevert({ errorName: 'NoRound' })).toBe(true);
    expect(isStaleRevert({ cause: { signature: '0xdeadbeef', data: '0xdeadbeef' } })).toBe(false);
    expect(isStaleRevert(new Error('OiCap'))).toBe(false);
  });
});
