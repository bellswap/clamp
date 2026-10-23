import { describe, expect, setSystemTime, test } from 'bun:test';
import { marketsFromCatalog, pagedTickets } from './api';
import { mockFaucet, mockVault, mockVaultMove } from './mock';
import type { CatalogEntry, TicketView } from './types';

const entry = (symbol: string, onChain: boolean): CatalogEntry => ({ symbol, display: `s${symbol}`, name: symbol, sector: null, marketCap: null, lastPrice: 100, listedByRobinhood: false, onChain });

describe('markets from the catalog (a bell without GET /markets)', () => {
  test('listed symbols priced from their last round; the rest and unpriced ones have no feed', async () => {
    const v = await marketsFromCatalog([entry('RTX', true), entry('NVDA', true), entry('AAL', false)], async (s) => (s === 'RTX' ? [{ t: 1, price: 180 }, { t: 2, price: 184.5 }] : []));
    expect(v.markets.map((m) => [m.symbol, m.tradable, m.price])).toEqual([['RTX', true, 184.5], ['NVDA', false, null], ['AAL', false, null]]);
    expect(v.markets[0]!.lastRound).toEqual({ t: 2, price: 184.5 });
  });
});

describe('an owner tickets walk past the 50-row default', () => {
  const tk = (id: number, open: boolean) => ({ id: String(id), payout: open ? null : 1 }) as unknown as TicketView;
  // Newest first by id: 520 settled tickets above one older open ticket.
  const all = [...Array.from({ length: 520 }, (_, i) => tk(2000 - i, false)), tk(7, true)];

  test('pages with before=<oldest id> until a short page; the old open ticket is found', async () => {
    const asked: (string | null)[] = [];
    const out = await pagedTickets(async (before) => {
      asked.push(before);
      return all.filter((t) => before === null || BigInt(t.id) < BigInt(before)).slice(0, 500);
    });
    expect(out.length).toBe(521);
    expect(out.filter((t) => t.payout === null).map((t) => t.id)).toEqual(['7']);
    expect(asked).toEqual([null, '1501']);
  });

  test('an older bell that ignores limit and before ends after the repeated page', async () => {
    let calls = 0;
    const out = await pagedTickets(async () => {
      calls++;
      return all.slice(0, 500);
    });
    expect(out.length).toBe(500);
    expect(calls).toBe(2);
  });
});

describe('mock vault', () => {
  test('a deposit raises the vault assets by the amount once', async () => {
    const realFetch = globalThis.fetch;
    // The fixtures read the catalog from the site's public folder.
    globalThis.fetch = (async () => new Response(await Bun.file(new URL('../../public/catalog.json', import.meta.url)).text())) as unknown as typeof fetch;
    setSystemTime(new Date('2026-10-20T15:00:00Z'));
    try {
      const a = `0x${'12'.repeat(20)}`;
      await mockFaucet(a);
      const v0 = await mockVault();
      await mockVaultMove(a, 100, true);
      const v1 = await mockVault();
      expect(v1.assets - v0.assets).toBeCloseTo(100, 6);
    } finally {
      setSystemTime();
      globalThis.fetch = realFetch;
    }
  });
});
