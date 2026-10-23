// Regression tests for the service review findings.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { MIN_HOUSE_VAULT, MIN_TICKET_BOOK } from '../src/abi';
import { App } from '../src/app';
import type { Chain } from '../src/chain';
import { loadEnv } from '../src/config';
import { faucet, FaucetLimiter, HttpError } from '../src/faucet';
import { indexOnce, type IndexerChain, type RawLog } from '../src/indexer';
import { leaderboard, LEADER_MIN_STAKED_RAW, rankByRoi, symbolToBytes32 } from '../src/math';
import { DAY, price8Of, remapCursor, Replay, seriesForRange, type ReplaySeries, type RoundPost } from '../src/replay';
import { handler, withCors } from '../src/server';
import { settleOnce } from '../src/settler';
import { emptyState, type StateData, type TicketRec } from '../src/store';

const BOOK = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const VAULT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const ALICE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const ZERO = '0x0000000000000000000000000000000000000000';
const ABIS = { book: MIN_TICKET_BOOK as Abi, vault: MIN_HOUSE_VAULT as Abi };
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/logs.json'), 'utf8')) as RawLog[];

function mk(abi: Abi, eventName: string, args: Record<string, unknown>, block: number, idx: number, address: Address): RawLog {
  const ev = abi.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]));
  return { address, topics, data, blockNumber: toHex(block), transactionHash: pad(toHex(block * 100 + idx)), logIndex: toHex(idx) };
}

function chainOf(head: bigint, all: RawLog[], o: { salt?: string; failTimeOnce?: number } = {}): IndexerChain {
  let failed = false;
  return {
    head: async () => head,
    getLogs: async (f) => {
      const a = BigInt(f.fromBlock);
      const b = BigInt(f.toBlock);
      const addrs = f.address.map((x) => x.toLowerCase());
      return all.filter((l) => addrs.includes(l.address.toLowerCase()) && BigInt(l.blockNumber) >= a && BigInt(l.blockNumber) <= b);
    },
    blockTime: async (bn) => {
      if (o.failTimeOnce !== undefined && Number(bn) === o.failTimeOnce && !failed) {
        failed = true;
        throw new Error('getBlock timed out');
      }
      return 1_792_300_000 + Number(bn) * 10;
    },
    blockHash: async (bn) => (bn <= head ? `0x${o.salt ?? 'a'}${bn}` : null),
  };
}
const book = (startBlock = 0n) => ({ book: BOOK, vault: VAULT, startBlock });

describe('rollback detection', () => {
  test('a different hash at lastBlock rebuilds the index; a lost settlement reopens the ticket', async () => {
    const d = emptyState();
    await indexOnce(d, chainOf(25n, fixture), book(), ABIS);
    expect(d.tickets['1']!.status).toBe('settled');
    expect(d.lastHash).toBe('0xa25');
    const withoutSettle = fixture.filter((l) => l.topics[0] !== fixture[3]!.topics[0]);
    await indexOnce(d, chainOf(30n, withoutSettle, { salt: 'b' }), book(), ABIS);
    expect(d.tickets['1']!.status).toBe('open');
    expect(d.lastBlock).toBe(30);
    expect(d.lastHash).toBe('0xb30');
  });

  test('a head below lastBlock rebuilds the index', async () => {
    const d = emptyState();
    await indexOnce(d, chainOf(25n, fixture), book(), ABIS);
    await indexOnce(d, chainOf(15n, fixture), book(), ABIS);
    expect(d.tickets['1']!.status).toBe('open');
    expect(d.lastBlock).toBe(15);
  });

  test('state from before the stored hash is re-indexed once', async () => {
    const d = emptyState();
    await indexOnce(d, chainOf(25n, fixture), book(), ABIS);
    d.lastHash = undefined;
    d.activity.push({ kind: 'deposit', block: 1, tx: '0x', logIndex: 0, at: 0 });
    await indexOnce(d, chainOf(25n, fixture), book(), ABIS);
    expect(d.activity.map((a) => a.kind)).toEqual(['market', 'deposit', 'open', 'settle']);
  });
});

describe('a chunk is committed whole', () => {
  test('a failed block time read applies nothing; the retry counts each deposit once', async () => {
    const logs = [
      mk(MIN_HOUSE_VAULT as Abi, 'Deposit', { sender: ALICE, owner: ALICE, assets: 100n, shares: 100n }, 3, 0, VAULT),
      mk(MIN_HOUSE_VAULT as Abi, 'Deposit', { sender: ALICE, owner: ALICE, assets: 50n, shares: 50n }, 4, 0, VAULT),
    ];
    const d = emptyState();
    const c = chainOf(10n, logs, { failTimeOnce: 4 });
    await expect(indexOnce(d, c, book(), ABIS)).rejects.toThrow('timed out');
    expect(d.lpShares).toEqual({});
    expect(d.activity).toEqual([]);
    expect(d.lastBlock).toBe(-1);
    await indexOnce(d, c, book(), ABIS);
    expect(d.lpShares[ALICE]).toBe('150');
    expect(d.activity.length).toBe(2);
  });
});

describe('net stake from the fee in force at the open block', () => {
  test('FeeSet events set the fee for later opens; a fee change does not rewrite earlier tickets', async () => {
    const sym = symbolToBytes32('NVDA');
    const open = (id: bigint, block: number) => mk(MIN_TICKET_BOOK as Abi, 'TicketOpened', { id, owner: ALICE, symbol: sym, long: true, leverage: 5, stake: 100_000_000n, entryPrice8: 18_000_000_000n, expiry: 1_792_364_400n }, block, 1, BOOK);
    const logs = [mk(MIN_TICKET_BOOK as Abi, 'FeeSet', { feeBps: 100 }, 2, 0, BOOK), open(1n, 3), mk(MIN_TICKET_BOOK as Abi, 'FeeSet', { feeBps: 250 }, 4, 0, BOOK), open(2n, 5)];
    const d = emptyState();
    await indexOnce(d, chainOf(10n, logs), book(), ABIS);
    expect(d.feeBps).toBe(250);
    expect(d.tickets['1']!.netStake).toBe('99000000');
    expect(d.tickets['2']!.netStake).toBe('97500000');
  });

  test('GET /tickets/:id derives fee, netStake and maxPayout from the stored net stake', async () => {
    const app = testApp();
    app.store.data.tickets['7'] = ticket('7', ALICE, { netStake: '97500000' });
    const r = await handler(app)(new Request('http://x/tickets/7'));
    const j = (await r.json()) as { ticket: { fee: string; netStake: string; maxPayout: string } };
    expect(j.ticket).toMatchObject({ fee: '2500000', netStake: '97500000', maxPayout: String(97_500_000 * 5) });
  });
});

describe('vault share transfers', () => {
  test('Alice deposits, transfers every share to Bob, Bob redeems: no LP left', async () => {
    const V = MIN_HOUSE_VAULT as Abi;
    const logs = [
      mk(V, 'Transfer', { from: ZERO, to: ALICE, value: 500n }, 3, 0, VAULT),
      mk(V, 'Deposit', { sender: ALICE, owner: ALICE, assets: 500n, shares: 500n }, 3, 1, VAULT),
      mk(V, 'Transfer', { from: ALICE, to: BOB, value: 500n }, 4, 0, VAULT),
    ];
    const d = emptyState();
    await indexOnce(d, chainOf(4n, logs), book(), ABIS);
    expect(d.lpShares).toEqual({ [BOB]: '500' });
    logs.push(mk(V, 'Withdraw', { sender: BOB, receiver: BOB, owner: BOB, assets: 500n, shares: 500n }, 5, 0, VAULT), mk(V, 'Transfer', { from: BOB, to: ZERO, value: 500n }, 5, 1, VAULT));
    await indexOnce(d, chainOf(5n, logs), book(), ABIS);
    expect(d.lpShares).toEqual({});
  });
});

// ---------------------------------------------------------------- faucet
const HOUSE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
function faucetCtx(bal: bigint, usdgStatus: 'success' | 'reverted') {
  const sent: { to: string; data?: string }[] = [];
  const chain = {
    house: { address: HOUSE },
    pub: { getCode: async () => '0x', readContract: async (a: { functionName: string }) => (a.functionName === 'balanceOf' ? bal : 0n) },
    hasCode: async () => true,
    send: async (_: unknown, tx: { to: string; data?: string }) => {
      sent.push(tx);
      return { hash: '0x01', status: tx.data ? usdgStatus : 'success', blockNumber: 1n };
    },
  } as unknown as Chain;
  const limiter = new FaucetLimiter({}, 3600);
  return { sent, limiter, ctx: { chain, limiter, enabled: true, ethWei: 5n * 10n ** 16n, usdgRaw: 1_000_000_000n, usdg: () => USDG as Address, save: () => undefined } };
}
const status = async (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : -1));

describe('faucet quotas after a partial send', () => {
  test('no USDG left: 503 before any ETH moves, quotas released', async () => {
    const f = faucetCtx(0n, 'success');
    expect(await status(faucet(f.ctx, ALICE, 'ip'))).toBe(503);
    expect(f.sent.length).toBe(0);
    expect(() => f.limiter.claim(ALICE, 'ip', Math.floor(Date.now() / 1000))).not.toThrow();
  });
  test('USDG transfer reverts after the ETH landed: quotas stay claimed', async () => {
    const f = faucetCtx(10n ** 12n, 'reverted');
    expect(await status(faucet(f.ctx, ALICE, 'ip'))).toBe(500);
    expect(f.sent.length).toBe(2);
    expect(await status(faucet(f.ctx, ALICE, 'ip'))).toBe(429);
    expect(f.sent.length).toBe(2);
  });
});

// ---------------------------------------------------------------- settler
function ticket(id: string, owner: string, extra: Partial<TicketRec> = {}): TicketRec {
  return { id, owner, symbol: 'NVDA', long: true, leverage: 5, stake: '100000000', entryPrice8: '18000000000', expiry: 1000 + Number(id), openedAt: 0, openTx: '0x', openBlock: 1, status: 'open', ...extra };
}

describe('settler does not starve later tickets', () => {
  test('25 earlier tickets that cannot settle do not block the 26th; they are backed off on the next pass', async () => {
    const d: StateData = emptyState();
    for (let i = 1; i <= 26; i++) d.tickets[String(i)] = ticket(String(i), ALICE);
    const calls: string[] = [];
    const sent: string[] = [];
    const idOf = (data: string) => String(BigInt('0x' + data.slice(10, 74)));
    const chain = {
      now: async () => 5000,
      house: { address: HOUSE },
      pub: {
        call: async (a: { data: string }) => {
          const id = idOf(a.data);
          calls.push(id);
          if (Number(id) <= 25) throw new Error('EarlyPrice');
        },
      },
      send: async (_: unknown, tx: { data: string }) => {
        sent.push(idOf(tx.data));
        return { hash: '0x01', status: 'success', blockNumber: 1n };
      },
    } as unknown as Chain;
    const backoff = new Map<string, number>();
    expect(await settleOnce(d, chain, BOOK, MIN_TICKET_BOOK as Abi, () => undefined, new Set(), backoff, 0)).toEqual(['26']);
    expect(backoff.size).toBe(25);
    calls.length = 0;
    expect(await settleOnce(d, chain, BOOK, MIN_TICKET_BOOK as Abi, () => undefined, new Set(['26']), backoff, 1000)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await settleOnce(d, chain, BOOK, MIN_TICKET_BOOK as Abi, () => undefined, new Set(['26']), backoff, 20_000)).toEqual([]);
    expect(calls.length).toBe(25);
  });
});

// ---------------------------------------------------------------- replay
const D = 1791811800; // 2026-10-12 13:30 UTC
const priceAt = (t: number) => 100 + (t - D) / 300;
function grid(bar: number, perDay: number, days = 2): ReplaySeries {
  const t: number[] = [];
  for (let day = 0; day < days; day++) for (let i = 0; i < perDay; i++) t.push(D + day * DAY + i * bar);
  return { bar, t, prices: { NVDA: t.map(priceAt) }, source: `grid ${bar}`, fetchedAt: 0 };
}

describe('replacing the replay series remaps the cursor', () => {
  test('15-minute fallback to five-minute primary keeps the recorded time of the bar', async () => {
    const fallback = grid(900, 26);
    const primary = grid(300, 78);
    let cur = fallback;
    const f = { t: D + 10 * DAY, posts: [] as RoundPost[] };
    const r = new Replay({
      now: async () => f.t,
      advance: async (s) => (f.t += s),
      post: async (rows) => void f.posts.push(...rows),
      markets: () => ['NVDA'],
      series: () => cur,
      closeHourUtc: 21,
    });
    await r.step();
    await r.step();
    expect(r.cursor).toBe(2); // fallback bar 2: 14:00
    cur = primary;
    const res = await r.step();
    expect(f.posts[f.posts.length - 1]!.price8).toBe(price8Of(priceAt(D + 1800)));
    expect(res.delta).toBe(300);
    expect(r.cursor).toBe(7);
  });

  test('without overlap the cursor follows the playground time of day', () => {
    const later = { ...grid(300, 78), t: grid(300, 78).t.map((x) => x + 7 * DAY) };
    expect(remapCursor(grid(900, 26), 2, later, D + 3 * DAY + 1800)).toBe(6);
  });
});

describe('replay range', () => {
  test("'1d' keeps the last recorded session; '5d' the whole series", () => {
    const s = grid(300, 78);
    const one = seriesForRange(s, '1d')!;
    expect(one.t.length).toBe(78);
    expect(one.t[0]).toBe(D + DAY);
    expect(one.prices.NVDA![0]).toBe(priceAt(D + DAY));
    expect(seriesForRange(s, '5d')).toBe(s);
  });

  test('POST /replay range is reflected in /state and defaults to BELL_REPLAY_RANGE', async () => {
    const app = testApp({ BELL_REPLAY_RANGE: '1d' });
    expect(app.replayRange()).toBe('1d');
    const h = handler(app);
    const r = await h(new Request('http://x/replay', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ range: '5d' }) }));
    expect(((await r.json()) as { range: string }).range).toBe('5d');
    const s = (await (await h(new Request('http://x/state'))).json()) as { replay: { range: string } };
    expect(s.replay.range).toBe('5d');
  });
});

// ---------------------------------------------------------------- server
function testApp(extra: Record<string, string> = {}): App {
  const dir = mkdtempSync(join(tmpdir(), 'bell-fix-'));
  return new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_ADMIN_TOKEN: 'test-token', ...extra }));
}

describe('leaderboard ranks by realized ROI before the cap', () => {
  test('a high-ROI trader with few tickets is kept ahead of 100 busier traders', async () => {
    const settled: { owner: string; stake: bigint; payout: bigint }[] = [];
    for (let i = 0; i < 100; i++) for (let k = 0; k < 5; k++) settled.push({ owner: `0x${i.toString(16).padStart(40, '0')}`, stake: 100_000_000n, payout: 101_000_000n });
    settled.push({ owner: BOB, stake: 150_000_000n, payout: 300_000_000n });
    settled.push({ owner: ALICE, stake: 10_000_000n, payout: 90_000_000n }); // below the minimum stake
    const rows = rankByRoi(leaderboard(settled), LEADER_MIN_STAKED_RAW).slice(0, 100);
    expect(rows[0]!.address).toBe(BOB);
    expect(rows.some((r) => r.address === ALICE)).toBe(false);

    const app = testApp();
    let id = 1;
    for (const t of settled) app.store.data.tickets[String(id)] = ticket(String(id++), t.owner, { stake: t.stake.toString(), payout: t.payout.toString(), status: 'settled' });
    const j = (await (await handler(app)(new Request('http://x/leaderboard'))).json()) as { rows: { address: string }[] };
    expect(j.rows.length).toBe(100);
    expect(j.rows[0]!.address).toBe(BOB);
  });
});

describe('CORS keeps Vary: Accept-Encoding', () => {
  test('Vary is merged, other CORS headers are set', () => {
    const out = withCors(new Response('{}', { headers: { vary: 'Accept-Encoding' } }), { 'access-control-allow-origin': '*', vary: 'Origin' });
    expect(out.headers.get('vary')).toBe('Accept-Encoding, Origin');
    expect(out.headers.get('access-control-allow-origin')).toBe('*');
    expect(withCors(new Response('{}', { headers: { vary: 'origin' } }), { vary: 'Origin' }).headers.get('vary')).toBe('origin');
    expect(withCors(new Response('{}'), { vary: 'Origin' }).headers.get('vary')).toBe('Origin');
  });
});
