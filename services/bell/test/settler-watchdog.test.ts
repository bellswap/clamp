import { describe, expect, test } from 'bun:test';
import type { Abi } from 'viem';
import { MIN_TICKET_BOOK } from '../src/abi';
import type { Chain } from '../src/chain';
import { BACKOFF_MS, settleOnce } from '../src/settler';
import { DAY } from '../src/replay';
import { D, harness } from './feed-harness';

const BOOK = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const START = D + 10 * DAY;

describe('settler watchdog', () => {
  test('a preflight revert prints the symbol at every post until the ticket settles', async () => {
    const h = harness({ start: START, core: [] });
    await h.tick();
    // the state says XYZ has a round at or after the expiry, but the chain disagrees (preflight reverts)
    h.ticket('7', 'XYZ', START - 100);
    h.data.rounds.XYZ = [{ t: START, price8: '1' }];
    const failing = new Set(['7']);
    const chain = {
      now: async () => h.chain.t,
      house: { address: '0x0000000000000000000000000000000000000001' },
      pub: {
        call: async (a: { data: string }) => {
          if (failing.has(String(BigInt('0x' + a.data.slice(10, 74))))) throw new Error('NoRoundAtOrAfter');
        },
      },
      send: async () => ({ hash: '0x01', status: 'success', blockNumber: 1n }),
    } as unknown as Chain;
    const backoff = new Map<string, number>();
    const seen: [string, string][] = [];
    const done = await settleOnce(h.data, chain, BOOK, MIN_TICKET_BOOK as Abi, () => undefined, new Set(), backoff, 0, (id, sym) => {
      seen.push([id, sym]);
      h.feed.watch(id, sym);
    });
    expect(done).toEqual([]);
    expect(seen).toEqual([['7', 'XYZ']]);
    expect(backoff.get('7')).toBe(BACKOFF_MS);
    expect(h.feed.status().watchdog).toEqual(['XYZ']);
    const before = h.chain.posts.length;
    await h.tick();
    await h.tick();
    expect(h.chain.posts.slice(before).map((p) => p.symbol)).toEqual(['XYZ', 'XYZ']);
    // the print landed: the retry after the backoff settles it, and the watchdog lets go
    failing.clear();
    expect(await settleOnce(h.data, chain, BOOK, MIN_TICKET_BOOK as Abi, () => undefined, new Set(), backoff, BACKOFF_MS)).toEqual(['7']);
    h.data.tickets['7']!.status = 'settled';
    const after = h.chain.posts.length;
    await h.tick();
    expect(h.chain.posts.slice(after)).toEqual([]);
    expect(h.feed.status().watchdog).toEqual([]);
  });
});
