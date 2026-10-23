import { describe, expect, test } from 'bun:test';
import { chunkLoaded, isChunkError, mayReload } from './chunk-reload';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('chunk reload (one automatic reload, no loop)', () => {
  test('reloads once, then not again however much time passes, until a chunk loads', () => {
    const s = mem();
    expect(mayReload(s)).toBe(true);
    expect(mayReload(s)).toBe(false);
    const later = Date.now;
    Date.now = () => later() + 10 * 60_000; // failures slower than any time window
    try {
      expect(mayReload(s)).toBe(false);
    } finally {
      Date.now = later;
    }
    chunkLoaded(s);
    expect(mayReload(s)).toBe(true);
  });
  test('no storage or a throwing storage never reloads', () => {
    expect(mayReload(null)).toBe(false);
    expect(mayReload({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined })).toBe(false);
    expect(() => chunkLoaded({ removeItem: () => { throw new Error('blocked'); } })).not.toThrow();
  });
  test('chunk errors are recognised', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'))).toBe(true);
    expect(isChunkError(new Error('boom'))).toBe(false);
  });
});
