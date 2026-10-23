// Regression tests for API review round 1: fee after FeeSet, a rollback
// during an indexer chunk, vault reads pinned to one block, vault sync (direct transfers, hourly carry forward, old
// state rebase), settled queries that do not walk open tickets, TicketBook payout rounding, the warm set in the memo
// keys and a malformed symbol escape. Round 2: a rollback after the watermark check, a vault read
// that resolves after a rebuild to the same height, and head reads without a clock.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_HOUSE_VAULT, MIN_TICKET_BOOK } from '../src/abi';
import { FakeFeed } from '../src/api/fake-feed';
import { TicketIndex } from '../src/api/ticket-index';
import { assetsOf } from '../src/api/vault';
import { App } from '../src/app';
import { loadEnv } from '../src/config';
import { applyEvent, indexOnce, type IndexerChain, type RawLog } from '../src/indexer';
import { multiplier, ONE, payoutOf } from '../src/math';
import { handler } from '../src/server';
import { emptyState, resetIndex, type StateData, type TicketRec } from '../src/store';

const CLOCK = 1_800_000_000;
const ALICE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const VAULT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const BOOK_ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const HOUR = 3600;
const DAY = 86_400;

let block = 10;
const meta = (at: number) => ({ block: block++, tx: `0x${(block * 7).toString(16)}`, logIndex: 0, at });

function mkApp() {
  const dir = mkdtempSync(join(tmpdir(), 'bell-fix-'));
  const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off' }));
  app.clock = async () => ({ clock: CLOCK, block: 100 });
  app.feeBps = async () => 100n; // the one-time on-chain read, cached for the process lifetime
  const d = app.store.data;
  d.feeBps = 100;
  const feed = new FakeFeed({ symbols: app.catalog.map((e) => e.symbol.toUpperCase()), uncovered: [], listed: () => new Set(Object.keys(app.store.data.markets)), clock: () => CLOCK, core: ['NVDA'] });
  (app as unknown as { feed: FakeFeed }).feed = feed;
  return { app, d, feed, h: handler(app) };
}
const get = async (h: ReturnType<typeof handler>, path: string) => {
  const r = await h(new Request(`http://x${path}`));
  return { status: r.status, body: (await r.json()) as any };
};
function list(d: StateData, symbol: string) {
  applyEvent(d, { eventName: 'MarketListed', args: { symbol, reference: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', maxLeverage: 20, maxStake: 1_000_000_000n, oiCap: 20_000_000_000n, maxStaleness: 86_400n } }, meta(CLOCK - 10_000));
}
function vaultApp(reads: Record<string, bigint>) {
  const x = mkApp();
  x.app.book = { chainId: 46633, startBlock: 1n, usdg: null, vault: VAULT, book: BOOK_ADDR, reference: null, raw: {} };
  const calls: { fn: string; blockNumber: unknown }[] = [];
  (x.app.chain.pub as unknown as { readContract: (a: { functionName: string; blockNumber?: bigint }) => Promise<bigint> }).readContract = async (a) => {
    calls.push({ fn: a.functionName, blockNumber: a.blockNumber });
    return reads[a.functionName]!;
  };
  return { ...x, calls };
}

describe('payout rounding mirrors TicketBook', () => {
  test('a loss is ceiled after the leverage is applied (the review repro)', () => {
    expect(payoutOf(99_000_000n, true, 2, 300_000_000n, 200_000_000n)).toBe(32_999_999n);
  });
  test('a gain multiplies by the leverage before the division', () => {
    // floor(7e18 / 3); dividing first gave 7 * floor(1e18 / 3), two wei lower
    expect(multiplier(true, 7, 3n, 4n)).toBe(ONE + 2_333_333_333_333_333_333n);
    expect(multiplier(false, 7, 3n, 4n)).toBe(0n);
    expect(multiplier(false, 2, 4n, 3n)).toBe(ONE + (ONE * 2n) / 4n);
  });
});

describe('/markets/:symbol follows an indexed FeeSet', () => {
  test('the fee changes without a restart', async () => {
    const { d, h } = mkApp();
    list(d, 'NVDA');
    expect((await get(h, '/markets/NVDA')).body.feeBps).toBe(100);
    applyEvent(d, { eventName: 'FeeSet', args: { feeBps: 200 } }, meta(CLOCK - 5));
    expect((await get(h, '/markets/NVDA')).body.feeBps).toBe(200);
  });
});

describe('a rollback during a chunk read commits nothing', () => {
  const logs = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/logs.json'), 'utf8')) as RawLog[];
  const BOOK = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
  test('logs of the old branch with the new branch hash are dropped; the next pass indexes the new branch', async () => {
    let branch: 'old' | 'new' = 'old';
    let hashReads = 0;
    const chain: IndexerChain = {
      head: async () => 25n,
      getLogs: async (f) => (branch === 'old' ? logs.filter((l) => BigInt(l.blockNumber) >= BigInt(f.fromBlock) && BigInt(l.blockNumber) <= BigInt(f.toBlock)) : []),
      blockTime: async (bn) => {
        branch = 'new'; // the fork is replaced while the block times are read
        return 1_792_300_000 + Number(bn) * 10;
      },
      blockHash: async (bn) => (hashReads++, `0x${branch}${bn}`),
    };
    const d = emptyState();
    const abis = { book: MIN_TICKET_BOOK, vault: MIN_HOUSE_VAULT };
    await indexOnce(d, chain, { book: BOOK, vault: VAULT, startBlock: 5n }, abis);
    expect(hashReads).toBe(2);
    expect(d.lastBlock).toBe(-1);
    expect(d.tickets).toEqual({});
    await indexOnce(d, chain, { book: BOOK, vault: VAULT, startBlock: 5n }, abis);
    expect(d.lastBlock).toBe(25);
    expect(d.lastHash).toBe('0xnew25');
    expect(d.tickets).toEqual({});
  });
});

describe('/vault sync at the indexed block', () => {
  const USDG = 1_000_000n;
  test('the four reads use one block number', async () => {
    const { d, h, calls } = vaultApp({ totalAssets: 100n * USDG, reserved: 0n, free: 100n * USDG, totalSupply: 100n * USDG * 10n ** 6n });
    d.lastBlock = 90;
    (await get(h, '/vault')).body;
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(calls.map((c) => c.blockNumber))).toEqual(new Set([90n]));
  });

  test('a direct transfer is absorbed and the history carries forward to the clock hour', async () => {
    const shares = 100n * USDG * 10n ** 6n;
    const { app, d, h } = vaultApp({ totalAssets: 200n * USDG, reserved: 0n, free: 200n * USDG, totalSupply: shares });
    applyEvent(d, { eventName: 'Deposit', args: { sender: ALICE, owner: ALICE, assets: 100n * USDG, shares } }, meta(CLOCK - 8 * DAY));
    d.lastBlock = 100; // the head of app.clock: the indexer is caught up
    const v = (await get(h, '/vault')).body;
    const hourNow = Math.floor(CLOCK / HOUR) * HOUR;
    expect(v.history[v.history.length - 1].t).toBe(hourNow);
    expect(v.history.length).toBe(8 * 24 + 1);
    expect(v.pnl7d).not.toBe(null);
    expect(v.pnl7d[0]).toBe(0);
    expect(v.pnl7d[v.pnl7d.length - 1]).toBe(100); // the 100 USDG sent straight to the vault
    expect(assetsOf(app.store.data.vault)).toBe(200n * USDG);
    // a later event carries the transfer in its point
    applyEvent(d, { eventName: 'TicketOpened', args: { id: 1n, owner: BOB, symbol: 'NVDA', long: true, leverage: 2, stake: 10n * USDG, entryPrice8: 100n, expiry: BigInt(CLOCK + DAY) } }, meta(CLOCK + 2 * HOUR));
    const last = d.vault.history[d.vault.history.length - 1]!;
    expect(last.t).toBe(hourNow + 2 * HOUR);
    expect(last.assetsRaw).toBe((200n * USDG).toString());
  });

  test('a partial state (no vault totals) is rebased on the chain values', async () => {
    const shares = 50n * USDG * 10n ** 6n;
    const { d, h } = vaultApp({ totalAssets: 50n * USDG, reserved: 5n * USDG, free: 45n * USDG, totalSupply: shares });
    d.vault.partial = true;
    d.lastBlock = 100;
    const v = (await get(h, '/vault')).body;
    expect(d.vault.partial).toBeUndefined();
    expect(v.history.length).toBe(1);
    expect(v.history[0]).toMatchObject({ assetsRaw: (50n * USDG).toString(), reservedRaw: (5n * USDG).toString() });
    expect(v.pnl7d).toEqual([0, 0]);
  });

  test('no sync while the reads at the indexed block fail (state pruned): head reads, history untouched', async () => {
    const { app, d, h } = vaultApp({});
    const calls: unknown[] = [];
    (app.chain.pub as unknown as { readContract: (a: { blockNumber?: bigint }) => Promise<bigint> }).readContract = async (a) => {
      calls.push(a.blockNumber);
      if (a.blockNumber === 90n) throw new Error('missing trie node');
      return 7n;
    };
    d.lastBlock = 90;
    const v = (await get(h, '/vault')).body;
    expect(v.assets).toBe('7');
    expect(calls.filter((b) => b === 100n).length).toBe(4);
    expect(v.history).toEqual([]);
  });
});

describe('settled queries walk the settled ids only', () => {
  test('30,000 open tickets and limit 1: a handful of record reads', () => {
    const tickets: Record<string, TicketRec> = {};
    const mk = (id: number, status: 'open' | 'settled'): TicketRec => ({ id: String(id), owner: id % 2 ? ALICE : BOB, symbol: id % 3 ? 'NVDA' : 'AAPL', long: true, leverage: 2, stake: '1000000', entryPrice8: '100', expiry: CLOCK, openedAt: CLOCK - DAY + id, openTx: '0x', openBlock: id, status, ...(status === 'settled' ? { payout: '0', settledAt: CLOCK } : {}) }) as TicketRec;
    tickets['1'] = mk(1, 'settled');
    for (let i = 2; i <= 30_001; i++) tickets[String(i)] = mk(i, 'open');
    let reads = 0;
    const counted = new Proxy(tickets, { get: (t, k) => (typeof k === 'string' && /^\d+$/.test(k) && reads++, Reflect.get(t, k)) });
    const ix = new TicketIndex(counted, () => 100);
    for (let i = 1; i <= 30_001; i++) ix.upsert(tickets[String(i)]);
    reads = 0;
    expect(ix.query({ status: 'settled', limit: 1 }).map((t) => t.id)).toEqual(['1']);
    expect(ix.query({ status: 'settled', symbol: 'NVDA', limit: 1 }).map((t) => t.id)).toEqual(['1']);
    expect(ix.query({ status: 'settled', owner: ALICE, limit: 1 }).map((t) => t.id)).toEqual(['1']);
    expect(ix.query({ status: 'settled', owner: BOB, limit: 1 })).toEqual([]);
    expect(reads).toBeLessThan(10);
    // a later settle joins the lists in id order
    tickets['5'] = mk(5, 'settled');
    ix.upsert(tickets['5']);
    expect(ix.query({ status: 'settled', limit: 5 }).map((t) => t.id)).toEqual(['5', '1']);
    expect(ix.query({ status: 'settled', limit: 5, before: 5 }).map((t) => t.id)).toEqual(['1']);
  });
});

describe('memoized /markets: warm set and symbol escape', () => {
  test('a warm call between ticks shows in the memoized /markets hot flags', async () => {
    const { d, feed, h } = mkApp();
    list(d, 'NVDA');
    list(d, 'AAPL');
    const row = async () => (await get(h, '/markets')).body.markets.find((m: { symbol: string }) => m.symbol === 'AAPL');
    expect((await row()).hot).toBe(false);
    expect(feed.warm('AAPL', 'client').ok).toBe(true);
    expect((await row()).hot).toBe(true);
  });
  test('a malformed percent escape in the symbol is a 400, not a 500', async () => {
    const { h } = mkApp();
    for (const p of ['/markets/%E0%A4%A', '/candles/%E0%A4%A', '/prices/%E0%A4%A']) expect((await get(h, p)).status).toBe(400);
  });
});

describe('review round 2', () => {
  const logs = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/logs.json'), 'utf8')) as RawLog[];
  const abis = { book: MIN_TICKET_BOOK, vault: MIN_HOUSE_VAULT };
  const range = (all: RawLog[], f: { fromBlock: string; toBlock: string }) => all.filter((l) => BigInt(l.blockNumber) >= BigInt(f.fromBlock) && BigInt(l.blockNumber) <= BigInt(f.toBlock));

  test('a rollback between the watermark check and the chunk reads commits nothing on the old state', async () => {
    // Branch b lost the settlement and has one more deposit at block 27.
    const b = [...logs.filter((_, i) => i !== 3), { ...logs[1]!, blockNumber: '0x1b' as const, transactionHash: `0x${'27'.padStart(64, '0')}` as const }];
    let branch: 'a' | 'b' = 'a';
    let head = 25n;
    let switchAfter: bigint | null = null;
    const chain: IndexerChain = {
      head: async () => head,
      getLogs: async (f) => range(branch === 'a' ? logs : b, f),
      blockTime: async (bn) => 1_792_300_000 + Number(bn) * 10,
      blockHash: async (bn) => {
        const hash = `0x${branch}${bn}`;
        if (bn === switchAfter) (branch = 'b'), (switchAfter = null); // the fork is replaced right after this read
        return hash;
      },
    };
    const d = emptyState();
    const book = { book: BOOK_ADDR, vault: VAULT, startBlock: 5n };
    await indexOnce(d, chain, book, abis);
    expect(d.tickets['1']!.status).toBe('settled');
    const sharesA = { ...d.lpShares };
    head = 30n;
    switchAfter = 25n; // the watermark check sees branch a, the chunk reads see branch b
    await indexOnce(d, chain, book, abis);
    expect(d.lastBlock).toBe(25);
    expect(d.lastHash).toBe('0xa25');
    expect(d.lpShares).toEqual(sharesA);
    await indexOnce(d, chain, book, abis);
    expect(d.lastHash).toBe('0xb30');
    expect(d.tickets['1']!.status).toBe('open');
  });

  test('reads that resolve after a reset and rebuild to the same height leave the new index alone', async () => {
    const { app, d, h } = vaultApp({});
    d.lastBlock = 100;
    d.lastHash = '0xa100';
    let snap: string | null = null;
    (app.chain.pub as unknown as { readContract: () => Promise<bigint> }).readContract = async () => {
      if (snap === null) {
        resetIndex(d, d.bookAddress);
        d.lastBlock = 100;
        d.lastHash = '0xb100';
        snap = JSON.stringify(d.vault);
      }
      return 50n;
    };
    const v = (await get(h, '/vault')).body;
    expect(v.assets).toBe('50');
    expect(JSON.stringify(d.vault)).toBe(snap!);
  });

  test('without a clock the head reads are pinned to one block number, or not made', async () => {
    const { app, d, h, calls } = vaultApp({ totalAssets: 7n, reserved: 0n, free: 7n, totalSupply: 7n });
    app.clock = async () => {
      throw new Error('clock down');
    };
    const pub = app.chain.pub as unknown as { getBlockNumber: () => Promise<bigint> };
    pub.getBlockNumber = async () => 120n;
    expect(d.lastBlock).toBe(-1);
    const v = (await get(h, '/vault')).body;
    expect(v.assets).toBe('7');
    expect(calls.map((c) => c.blockNumber)).toEqual([120n, 120n, 120n, 120n]);
    pub.getBlockNumber = async () => {
      throw new Error('rpc down');
    };
    calls.length = 0;
    await new Promise((r) => setTimeout(r, 2100)); // past the 2 s read cache
    const w = (await get(h, '/vault')).body;
    expect(calls).toEqual([]);
    expect(w.assets).toBe(null);
    expect(w.sharePrice).toBe(null);
  });
});
