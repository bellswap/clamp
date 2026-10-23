import { describe, expect, test } from 'bun:test';
import { COPY, PRODUCT_NAME } from './copy';
import { FOOTER_DISCLOSURES } from './content/disclosures';

const BANNED = ['around the clock', 'any source', 'thousands', 'one minute', 'launch fee', 'creator fee', 'audited', 'airdrop', 'soon'];

/** Every string in the copy tree, functions called with sample arguments. */
function strings(x: unknown): string[] {
  if (typeof x === 'string') return [x];
  if (typeof x === 'function') return strings((x as (...a: unknown[]) => unknown)('X', 'Y', 'Z'));
  if (Array.isArray(x)) return x.flatMap(strings);
  if (x && typeof x === 'object') return Object.values(x).flatMap(strings);
  return [];
}

describe('copy', () => {
  const all = strings(COPY);
  test('no banned words', () => {
    for (const s of all) for (const b of BANNED) expect(s.toLowerCase().includes(b) ? `${b} in "${s}"` : '').toBe('');
  });
  // The brand word is assembled so this file passes the naming lint itself.
  const RH = new RegExp(`${'Robin'}${'hood'}(?! Chain| Markets, Inc\\.)`, 'g');
  test('the brand word only in its two allowed forms', () => {
    for (const s of all) for (const m of s.matchAll(RH)) expect(`${m[0]} in "${s}"`).toBe('');
  });
  test('the footer is one line, and the product name sits in one constant', () => {
    expect(COPY.footer).toBe(FOOTER_DISCLOSURES.map((d) => d.text).join(' '));
    expect(COPY.footer.includes('\n')).toBe(false);
    expect(COPY.ticket.open(PRODUCT_NAME)).toBe('Open Clamp');
  });
  test('no emoji', () => {
    for (const s of all) expect(/\p{Extended_Pictographic}/u.test(s) ? s : '').toBe('');
  });
});
