import { describe, expect, test } from 'bun:test';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
const { burnerKey, KEY_STORAGE } = await import('./wallet');

describe('burnerKey', () => {
  test('stays fixed for the page load when another tab writes a different key', () => {
    const first = burnerKey();
    expect(store.get(KEY_STORAGE)).toBe(first);
    store.set(KEY_STORAGE, `0x${'1'.repeat(64)}`);
    expect(burnerKey()).toBe(first);
  });
});
