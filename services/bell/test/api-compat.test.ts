// Compatibility: every route that existed at 9ee6c36 keeps its answer shape. SHAPES was captured by running the
// 9ee6c36 handler on the seed below (every key with the type of its value; arrays by their first element). The
// current handler may add keys, never drop one or change a type ('null' means the key must exist, any type).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app';
import { loadEnv } from '../src/config';
import { handler } from '../src/server';

const SHAPES: Record<string, { status: number; body: unknown }> = {"/state": {"status": 200, "body": {"chainId": "number", "block": "number", "clockUnix": "number", "speed": "number", "counts": {"tickets": "number", "open": "number", "settled": "number", "addresses": "number", "markets": "number", "lps": "number"}, "book": {"ticketBook": "string", "vault": "string", "reference": "string", "usdg": "string", "startBlock": "string"}, "replay": {"running": "boolean", "range": "string", "cursor": "number", "bars": "number", "bar": "null", "source": "null", "lastTick": "null"}, "indexedBlock": "number"}}, "/catalog[0]": {"status": 200, "body": {"symbol": "string", "display": "string", "name": "string", "subject": "string", "lastPrice": "number", "priceAgeHours": "number", "listedByRobinhood": "boolean", "logoUrl": "null", "elsewhere": "boolean", "elsewhereFeed": "null", "yahooSymbol": "string", "quoteType": "string", "sector": "string", "industry": "string", "category": "null", "marketCap": "number", "netAssets": "null", "onChain": "boolean"}}, "/prices/NVDA": {"status": 200, "body": {"symbol": "string", "rounds": [{"t": "number", "price8": "string"}]}}, "/tickets": {"status": 200, "body": {"clockUnix": "number", "tickets": [{"id": "string", "owner": "string", "symbol": "string", "long": "boolean", "leverage": "number", "stake": "string", "entryPrice8": "string", "expiry": "number", "openedAt": "number", "openTx": "string", "openBlock": "number", "netStake": "string", "horizon": "number", "status": "string", "settlePrice8": "string", "payout": "string", "settledAt": "number", "settleTx": "string", "fee": "string", "maxPayout": "string", "reference": {"price8": "string", "t": "number"}, "currentPayout": "null", "secondsLeft": "number", "win": "boolean"}]}}, "/tickets/1": {"status": 200, "body": {"clockUnix": "number", "ticket": {"id": "string", "owner": "string", "symbol": "string", "long": "boolean", "leverage": "number", "stake": "string", "entryPrice8": "string", "expiry": "number", "openedAt": "number", "openTx": "string", "openBlock": "number", "netStake": "string", "horizon": "number", "status": "string", "fee": "string", "maxPayout": "string", "reference": {"price8": "string", "t": "number"}, "currentPayout": "string", "secondsLeft": "number", "win": "null"}}}, "/tickets/2": {"status": 200, "body": {"clockUnix": "number", "ticket": {"id": "string", "owner": "string", "symbol": "string", "long": "boolean", "leverage": "number", "stake": "string", "entryPrice8": "string", "expiry": "number", "openedAt": "number", "openTx": "string", "openBlock": "number", "netStake": "string", "horizon": "number", "status": "string", "settlePrice8": "string", "payout": "string", "settledAt": "number", "settleTx": "string", "fee": "string", "maxPayout": "string", "reference": {"price8": "string", "t": "number"}, "currentPayout": "null", "secondsLeft": "number", "win": "boolean"}}}, "/activity": {"status": 200, "body": {"events": [{"kind": "string", "id": "string", "address": "string", "symbol": "string", "long": "boolean", "leverage": "number", "amount": "string", "price8": "string", "block": "number", "tx": "string", "logIndex": "number", "at": "number"}]}}, "/leaderboard": {"status": 200, "body": {"minStakedRaw": "string", "rows": [{"address": "string", "points": "number", "settled": "number", "wins": "number", "pnlRaw": "string", "pnl": "number", "stakedRaw": "string", "staked": "number"}]}}, "/vault": {"status": 200, "body": {"deployed": "boolean", "address": "string", "assets": "string", "reserved": "string", "free": "string", "shares": "string", "lpCount": "number"}}, "/faucet 400": {"status": 400, "body": {"error": "string"}}};

const A = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

function seeded(): App {
  const dir = mkdtempSync(join(tmpdir(), 'bell-compat-'));
  const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_ADMIN_TOKEN: 't' }));
  app.book = { chainId: 46633, startBlock: 1n, usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', vault: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', book: '0x5FbDB2315678afecb367f032d93F642f64180aa3', reference: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', raw: {} };
  app.clock = async () => ({ clock: 1_800_000_000, block: 100 });
  app.feeBps = async () => 100n;
  (app.chain.pub as unknown as { readContract: () => Promise<bigint> }).readContract = async () => 123n;
  const d = app.store.data;
  d.lastBlock = 99;
  d.markets.NVDA = { symbol: 'NVDA', reference: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', maxLeverage: 20, maxStake: '1000000000', oiCap: '50000000000', maxStaleness: 86400, listedBlock: 2 };
  d.rounds.NVDA = [{ t: 1_799_999_700, price8: '21000000000' }];
  d.tickets['1'] = { id: '1', owner: A, symbol: 'NVDA', long: true, leverage: 5, stake: '100000000', entryPrice8: '20000000000', expiry: 1_800_003_600, openedAt: 1_799_990_000, openTx: '0xaa', openBlock: 10, netStake: '99000000', horizon: 1, status: 'open' };
  d.tickets['2'] = { id: '2', owner: A, symbol: 'NVDA', long: false, leverage: 2, stake: '200000000', entryPrice8: '20000000000', expiry: 1_799_995_000, openedAt: 1_799_980_000, openTx: '0xbb', openBlock: 11, netStake: '198000000', horizon: 0, status: 'settled', settlePrice8: '19000000000', payout: '217800000', settledAt: 1_799_996_000, settleTx: '0xcc' };
  d.activity.push({ kind: 'open', id: '1', address: A, symbol: 'NVDA', long: true, leverage: 5, amount: '100000000', price8: '20000000000', block: 10, tx: '0xaa', logIndex: 0, at: 1_799_990_000 });
  d.lpShares[A] = '1000';
  return app;
}

/** Problems of `actual` against an expected shape, as paths. */
function mismatches(actual: unknown, shape: unknown, path = ''): string[] {
  if (shape === 'null') return [];
  if (Array.isArray(shape)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array`];
    if (!shape.length) return [];
    if (!actual.length) return [`${path}: expected a non-empty array`];
    return mismatches(actual[0], shape[0], `${path}[0]`);
  }
  if (shape && typeof shape === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: expected an object`];
    const out: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      if (!(k in (actual as object))) out.push(`${path}.${k}: missing`);
      else out.push(...mismatches((actual as Record<string, unknown>)[k], v, `${path}.${k}`));
    }
    return out;
  }
  return typeof actual === shape ? [] : [`${path}: expected ${String(shape)}, got ${actual === null ? 'null' : typeof actual}`];
}

const REQUESTS: [string, () => Request][] = [
  ['/state', () => new Request('http://x/state')],
  ['/catalog[0]', () => new Request('http://x/catalog')],
  ['/prices/NVDA', () => new Request('http://x/prices/NVDA')],
  ['/tickets', () => new Request(`http://x/tickets?owner=${A}`)],
  ['/tickets/1', () => new Request('http://x/tickets/1')],
  ['/tickets/2', () => new Request('http://x/tickets/2')],
  ['/activity', () => new Request('http://x/activity')],
  ['/leaderboard', () => new Request('http://x/leaderboard')],
  ['/vault', () => new Request('http://x/vault')],
  ['/faucet 400', () => new Request('http://x/faucet', { method: 'POST', body: '{"address":"nope"}' })],
];

describe('compatibility with the 9ee6c36 route shapes', () => {
  const app = seeded();
  const h = handler(app);
  for (const [k, req] of REQUESTS) {
    test(k, async () => {
      const r = await h(req());
      const j = (await r.json()) as unknown;
      expect(r.status).toBe(SHAPES[k]!.status);
      expect(mismatches(k === '/catalog[0]' ? (j as unknown[])[0] : j, SHAPES[k]!.body)).toEqual([]);
    });
  }
  test('every pinned route is requested', () => {
    expect(REQUESTS.map((r) => r[0]).sort()).toEqual(Object.keys(SHAPES).sort());
  });
  test('the mismatch check catches a dropped key and a changed type', () => {
    expect(mismatches({ a: 1 }, { a: 'number', b: 'string' })).toEqual(['.b: missing']);
    expect(mismatches({ a: '1' }, { a: 'number' })).toEqual(['.a: expected number, got string']);
    expect(mismatches({ a: [] }, { a: [{ x: 'number' }] })).toEqual(['.a: expected a non-empty array']);
  });
  test('/faucet from a foreign origin stays 403 with an error', async () => {
    const r = await h(new Request('http://x/faucet', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }));
    expect(r.status).toBe(403);
    expect(typeof ((await r.json()) as { error: unknown }).error).toBe('string');
  });
  test('the open ticket keeps its on-chain reference and a current payout without a feed', async () => {
    const j = (await (await h(new Request('http://x/tickets/1'))).json()) as { ticket: { reference: { price8: string }; currentPayout: string } };
    expect(j.ticket.reference.price8).toBe('21000000000');
    // 99 USDG net, long 5x, +5%: 99 * 1.25
    expect(j.ticket.currentPayout).toBe('123750000');
  });
});
