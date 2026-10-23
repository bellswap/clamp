// Contract tests for the routes added for the playground build: /markets, /markets/:symbol,
// /candles/:symbol, POST /warm/:symbol, /replay/coverage, the new /tickets, /activity, /leaderboard and /vault
// fields, POST /admin/bots and /state; plus the ticket index (incremental equals rebuilt) and the vault history.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeFeed } from '../src/api/fake-feed';
import { indexOf, invalidateIndex } from '../src/api/ticket-index';
import { App } from '../src/app';
import { loadEnv } from '../src/config';
import { ACTIVITY_KEEP, applyEvent, trimActivity } from '../src/indexer';
import { expiryFor, payoutOf, toPrice8 } from '../src/math';
import { handler } from '../src/server';
import { ACTIVITY_MAX, emptyState, resetIndex, type ActivityRec, type StateData } from '../src/store';

const CLOCK = 1_800_000_000; // 2027-01-15 08:00 UTC, a Friday
const ALICE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const BOT = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
const VAULT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const TOKEN = 'route-test-token';

let block = 10;
let logIndex = 0;
const meta = (at: number) => ({ block: block++, tx: `0x${(block * 7).toString(16)}`, logIndex: logIndex++, at });

function list(d: StateData, symbol: string, at = CLOCK - 10_000) {
  applyEvent(d, { eventName: 'MarketListed', args: { symbol, reference: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', maxLeverage: 20, maxStake: 1_000_000_000n, oiCap: 20_000_000_000n, maxStaleness: 86_400n } }, meta(at));
}
function open(d: StateData, id: number, owner: string, symbol: string, o: { long?: boolean; lev?: number; stake?: bigint; entry?: bigint; at?: number; expiry?: number } = {}) {
  applyEvent(d, { eventName: 'TicketOpened', args: { id: BigInt(id), owner, symbol, long: o.long ?? true, leverage: o.lev ?? 5, stake: o.stake ?? 100_000_000n, entryPrice8: o.entry ?? 20_000_000_000n, expiry: BigInt(o.expiry ?? CLOCK + 3600) } }, meta(o.at ?? CLOCK - 100));
}
function settle(d: StateData, id: number, payout: bigint, at = CLOCK - 50) {
  applyEvent(d, { eventName: 'TicketSettled', args: { id: BigInt(id), settlePrice8: 21_000_000_000n, payout } }, meta(at));
}

function mkApp(o: { warmPerMin?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bell-api-'));
  const stateFile = join(dir, 'state.json');
  const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: stateFile, BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_ADMIN_TOKEN: TOKEN }));
  let clock = CLOCK;
  app.clock = async () => ({ clock, block: 100 });
  app.feeBps = async () => 100n;
  const d = app.store.data;
  d.feeBps = 100;
  const feed = new FakeFeed({ symbols: app.catalog.map((e) => e.symbol.toUpperCase()), uncovered: ['SATS'], listed: () => new Set(Object.keys(app.store.data.markets)), clock: () => clock, core: ['NVDA'], warmPerMin: o.warmPerMin });
  (app as unknown as { feed: FakeFeed }).feed = feed;
  return { app, d, feed, h: handler(app), stateFile, setClock: (c: number) => (clock = c) };
}

const get = async (h: ReturnType<typeof handler>, path: string, headers: Record<string, string> = {}) => {
  const r = await h(new Request(`http://x${path}`, { headers }));
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (h: ReturnType<typeof handler>, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await h(new Request(`http://x${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as any };
};

const ROW_KEYS = ['symbol', 'listed', 'covered', 'tradable', 'hot', 'price', 'prevClose', 'chg', 'sessionOpen', 'sessionHigh', 'sessionLow', 'spark', 'openCount', 'oiRaw', 'longOpenRaw', 'shortOpenRaw', 'oiCapRaw', 'maxStakeRaw', 'maxLeverage', 'volume24hRaw', 'lastRound'];

describe('GET /markets', () => {
  test('one row per catalog symbol with the MarketRow fields; open interest and 24 h volume from the index', async () => {
    const { d, h } = mkApp();
    list(d, 'NVDA');
    list(d, 'SATS');
    open(d, 1, BOB, 'NVDA', { long: true, stake: 7_000_000n, at: CLOCK - 90_000 }); // outside the 24 h window
    settle(d, 1, 0n);
    open(d, 2, ALICE, 'NVDA', { long: true, stake: 100_000_000n });
    open(d, 3, BOB, 'NVDA', { long: false, stake: 50_000_000n });
    d.rounds.NVDA = [{ t: CLOCK - 5, price8: '21000000000' }];
    const { status, body } = await get(h, '/markets');
    expect(status).toBe(200);
    expect(body.clockUnix).toBe(CLOCK);
    expect(body.nextClose).toBe(CLOCK - (CLOCK % 86_400) + 21 * 3600);
    expect(body.markets.length).toBe(513);
    for (const k of ROW_KEYS) expect(Object.keys(body.markets[0])).toContain(k);
    const nv = body.markets.find((m: { symbol: string }) => m.symbol === 'NVDA');
    expect(nv).toMatchObject({ listed: true, covered: true, tradable: true, hot: true, openCount: 2, oiRaw: '150000000', longOpenRaw: '100000000', shortOpenRaw: '50000000', oiCapRaw: '20000000000', maxStakeRaw: '1000000000', maxLeverage: 20, volume24hRaw: '150000000', lastRound: { t: CLOCK - 5, price8: '21000000000' } });
    expect(typeof nv.price).toBe('number');
    expect(nv.chg).toBeCloseTo(nv.price / nv.sessionOpen - 1, 12);
    expect(nv.spark.length).toBeGreaterThan(0);
    const sats = body.markets.find((m: { symbol: string }) => m.symbol === 'SATS');
    expect(sats).toMatchObject({ listed: true, covered: false, tradable: false, price: null, chg: null, spark: [] });
    const aapl = body.markets.find((m: { symbol: string }) => m.symbol === 'AAPL');
    expect(aapl).toMatchObject({ listed: false, covered: true, tradable: false, oiCapRaw: '0', maxLeverage: 0, lastRound: null });
  });

  test('memoized: the same object until the index, the clock or the feed tick changes', async () => {
    const { d, h, setClock } = mkApp();
    list(d, 'NVDA');
    const a = await get(h, '/markets');
    const b = await get(h, '/markets');
    expect(b.body).toEqual(a.body);
    open(d, 1, ALICE, 'NVDA');
    const c = await get(h, '/markets');
    expect(c.body.markets.find((m: { symbol: string }) => m.symbol === 'NVDA').openCount).toBe(1);
    setClock(CLOCK + 300);
    expect((await get(h, '/markets')).body.clockUnix).toBe(CLOCK + 300);
  });
});

describe('GET /markets/:symbol, /candles/:symbol, /prices/:symbol, POST /warm/:symbol', () => {
  test('detail adds exposure, fee, staleness, freshness, expiries and wall ETAs, and marks the symbol warm', async () => {
    const { d, h, feed } = mkApp();
    list(d, 'AAPL');
    open(d, 1, ALICE, 'AAPL', { lev: 10, stake: 100_000_000n });
    d.rounds.AAPL = [{ t: CLOCK - 200, price8: '20000000000' }];
    const { status, body } = await get(h, '/markets/aapl', { 'x-forwarded-for': '10.0.0.7' });
    expect(status).toBe(200);
    for (const k of [...ROW_KEYS, 'exposureRaw', 'feeBps', 'maxStaleness', 'fresh', 'expiries', 'etaWall']) expect(Object.keys(body)).toContain(k);
    expect(body.exposureRaw).toBe('990000000'); // 99 net x 10
    expect(body.feeBps).toBe(100);
    expect(body.maxStaleness).toBe(86_400);
    expect(body.fresh).toBe(true);
    expect(body.expiries).toEqual({ session: expiryFor(0, CLOCK), day: expiryFor(1, CLOCK), week: expiryFor(2, CLOCK) });
    expect(body.expiries.session).toBe(CLOCK - (CLOCK % 86_400) + 21 * 3600);
    expect(typeof body.etaWall.session).toBe('number');
    expect(feed.warmCalls).toContainEqual({ symbol: 'AAPL', clientKey: '10.0.0.7' });
    expect(body.hot).toBe(true); // warmed before the row was built
    d.rounds.AAPL = [{ t: CLOCK - 301, price8: '20000000000' }];
    expect((await get(h, '/markets/AAPL')).body.fresh).toBe(false);
    expect((await get(h, '/markets/NOTATICKER')).status).toBe(404);
  });

  test('candles: shape, tf and limit checks, warm', async () => {
    const { d, h, feed } = mkApp();
    list(d, 'NVDA');
    const { status, body } = await get(h, '/candles/NVDA?tf=1h&limit=5', { 'x-forwarded-for': '10.0.0.8' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ symbol: 'NVDA', tf: '1h', clockUnix: CLOCK, source: 'replay' });
    expect(body.candles.length).toBe(5);
    expect(Object.keys(body.candles[0]).sort()).toEqual(['c', 'h', 'l', 'o', 't']);
    expect(feed.warmCalls).toContainEqual({ symbol: 'NVDA', clientKey: '10.0.0.8' });
    expect((await get(h, '/candles/NVDA')).body.candles.length).toBe(300);
    expect((await get(h, '/candles/NVDA?tf=2m')).status).toBe(400);
    expect((await get(h, '/candles/NVDA?limit=0')).status).toBe(400);
    expect((await get(h, '/candles/NVDA?limit=1001')).status).toBe(400);
    expect((await get(h, '/candles/NOPE')).status).toBe(404);
    expect((await get(h, '/candles/SATS')).body.candles).toEqual([]);
  });

  test('prices keeps its shape and marks warm', async () => {
    const { d, h, feed } = mkApp();
    list(d, 'TSLA');
    d.rounds.TSLA = [{ t: CLOCK, price8: '1' }];
    const { body } = await get(h, '/prices/TSLA', { 'x-forwarded-for': '10.0.0.9' });
    expect(body).toEqual({ symbol: 'TSLA', rounds: [{ t: CLOCK, price8: '1' }] });
    expect(feed.warmCalls).toContainEqual({ symbol: 'TSLA', clientKey: '10.0.0.9' });
  });

  test('POST /warm: ok with warmUntil, 404 when not tradable, 429 over the per-IP limit', async () => {
    const { d, h } = mkApp({ warmPerMin: 2 });
    list(d, 'AAPL');
    list(d, 'MSFT');
    list(d, 'AMZN');
    list(d, 'SATS');
    const ok = await post(h, '/warm/AAPL', { ttl: 30 }, { 'x-forwarded-for': '1.2.3.4' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.symbol).toBe('AAPL');
    expect(typeof ok.body.warmUntil).toBe('number');
    expect((await post(h, '/warm/GOOGL', {})).status).toBe(404); // not listed
    expect((await post(h, '/warm/SATS', {})).status).toBe(404); // no series
    expect((await post(h, '/warm/NOPE', {})).status).toBe(404);
    expect((await post(h, '/warm/AAPL', { ttl: -1 })).status).toBe(400);
    expect((await post(h, '/warm/MSFT', {}, { 'x-forwarded-for': '1.2.3.4' })).status).toBe(200);
    const r = await post(h, '/warm/AMZN', {}, { 'x-forwarded-for': '1.2.3.4' });
    expect(r.status).toBe(429);
    expect(r.body.reason).toBe('rate');
    expect((await post(h, '/warm/AMZN', {}, { 'x-forwarded-for': '5.6.7.8' })).status).toBe(200);
  });

  test('GET /replay/coverage is feed.coverage()', async () => {
    const { h, feed } = mkApp();
    const { body } = await get(h, '/replay/coverage');
    expect(body).toEqual(JSON.parse(JSON.stringify(feed.coverage())));
    expect(body.missing).toEqual(['SATS']);
  });
});

describe('tickets, activity, leaderboard, bots', () => {
  test('/tickets filters by owner, symbol and status, pages with before, and prices open tickets from the feed', async () => {
    const { d, h, feed } = mkApp();
    list(d, 'NVDA');
    list(d, 'AAPL');
    for (let i = 1; i <= 120; i++) open(d, i, i % 2 ? ALICE : BOB, i % 3 ? 'NVDA' : 'AAPL');
    for (let i = 1; i <= 30; i++) settle(d, i, 50_000_000n);
    const all = await get(h, '/tickets');
    expect(all.body.tickets.length).toBe(50);
    expect(all.body.tickets[0].id).toBe('120');
    const page2 = await get(h, '/tickets?before=71&limit=500');
    expect(page2.body.tickets.length).toBe(70);
    expect(page2.body.tickets[0].id).toBe('70');
    const q = await get(h, `/tickets?owner=${ALICE}&symbol=aapl&status=open&limit=500`);
    const want = [];
    for (let i = 120; i > 30; i--) if (i % 2 && !(i % 3)) want.push(String(i));
    expect(q.body.tickets.map((t: { id: string }) => t.id)).toEqual(want);
    const settled = await get(h, `/tickets?status=settled&limit=500`);
    expect(settled.body.tickets.length).toBe(30);
    expect((await get(h, '/tickets?status=nope')).status).toBe(400);
    expect((await get(h, '/tickets?limit=501')).status).toBe(400);
    expect((await get(h, '/tickets?owner=nope')).status).toBe(400);
    expect((await get(h, '/tickets?owner=')).status).toBe(400);
    const t = (await get(h, '/tickets/119')).body.ticket;
    const price = feed.now('NVDA')!.price!;
    expect(t.currentPayout).toBe(payoutOf(99_000_000n, true, 5, 20_000_000_000n, toPrice8(price)).toString());
    expect(t.reference).toBe(null); // no on-chain round yet: the reference stays the last posted round
    expect(t.bot).toBe(false);
  });

  test('POST /admin/bots needs the token, persists, merges or replaces; rows carry the bot flag', async () => {
    const { d, h, app, stateFile } = mkApp();
    list(d, 'NVDA');
    open(d, 1, BOT, 'NVDA', { stake: 200_000_000n });
    open(d, 2, ALICE, 'NVDA', { stake: 200_000_000n });
    settle(d, 1, 300_000_000n);
    settle(d, 2, 100_000_000n);
    expect((await post(h, '/admin/bots', { addresses: [BOT] })).status).toBe(401);
    expect((await post(h, '/admin/bots', { addresses: ['0x12'] }, { authorization: `Bearer ${TOKEN}` })).status).toBe(400);
    const ok = await post(h, '/admin/bots', { addresses: [BOT.toUpperCase().replace('0X', '0x')] }, { authorization: `Bearer ${TOKEN}` });
    expect(ok.body).toEqual({ ok: true, count: 1 });
    expect((JSON.parse(readFileSync(stateFile, 'utf8')) as StateData).bots).toEqual([BOT]);
    expect((await post(h, '/admin/bots', { addresses: [BOB] }, { authorization: `Bearer ${TOKEN}` })).body.count).toBe(2);
    expect((await post(h, '/admin/bots', { addresses: [BOT], replace: true }, { authorization: `Bearer ${TOKEN}` })).body.count).toBe(1);
    const tickets = (await get(h, '/tickets')).body.tickets;
    expect(tickets.map((t: { id: string; bot: boolean }) => [t.id, t.bot])).toEqual([['2', false], ['1', true]]);
    const ev = (await get(h, '/activity?kind=settle')).body.events;
    expect(ev.map((e: { id: string; bot: boolean }) => [e.id, e.bot])).toEqual([['2', false], ['1', true]]);
    const lb = (await get(h, '/leaderboard')).body;
    expect(lb.rows.map((r: { address: string; bot: boolean }) => [r.address, r.bot])).toEqual([[BOT, true], [ALICE, false]]);
    const st = (await get(h, '/state')).body;
    expect(st.counts.bots).toBe(1);
    expect(app.store.data.bots).toEqual([BOT]);
  });

  test('/activity: every kind, seq, kind and symbol filters, before paging, a cap of 2,000', async () => {
    const { d, h } = mkApp();
    list(d, 'NVDA');
    applyEvent(d, { eventName: 'Deposit', args: { sender: ALICE, owner: ALICE, assets: 1_000_000_000n, shares: 10n ** 15n } }, meta(CLOCK - 500));
    open(d, 1, ALICE, 'NVDA');
    settle(d, 1, 0n);
    applyEvent(d, { eventName: 'Withdraw', args: { sender: ALICE, receiver: ALICE, owner: ALICE, assets: 1_000_000n, shares: 10n ** 12n } }, meta(CLOCK - 40));
    const all = (await get(h, '/activity')).body.events;
    expect(all.map((e: { kind: string }) => e.kind)).toEqual(['withdraw', 'settle', 'open', 'deposit', 'market']);
    expect(all.map((e: { seq: number }) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect((await get(h, '/activity?kind=deposit')).body.events.length).toBe(1);
    expect((await get(h, '/activity?kind=deposit,withdraw')).body.events.map((e: { kind: string }) => e.kind)).toEqual(['withdraw', 'deposit']);
    expect((await get(h, '/activity?symbol=nvda')).body.events.length).toBe(3);
    expect((await get(h, '/activity?before=3&limit=1')).body.events.map((e: { seq: number }) => e.seq)).toEqual([2]);
    expect((await get(h, '/activity?kind=nope')).status).toBe(400);
    expect((await get(h, '/activity?limit=501')).status).toBe(400);
    for (let i = 2; i < 2200; i++) open(d, i, BOB, 'NVDA');
    expect(d.activity.length).toBe(ACTIVITY_MAX);
    expect(ACTIVITY_MAX).toBe(2_000);
    expect(d.activity[d.activity.length - 1]!.seq).toBe(5 + 2198);
    // the deposit, withdraw and listing rows outlive 2,000 newer trades
    expect((await get(h, '/activity?kind=deposit,withdraw,market')).body.events.map((e: { kind: string }) => e.kind)).toEqual(['withdraw', 'deposit', 'market']);
    expect((await get(h, '/activity?limit=500')).body.events.length).toBe(500);
  });

  test('trimActivity keeps the order and drops trades before the kept vault and market rows', () => {
    const rows = (kinds: string[]) => kinds.map((kind, i) => ({ kind, block: i, tx: '0x', logIndex: 0, at: i, seq: i + 1 }) as ActivityRec);
    const many = rows([...Array(500).fill('market'), 'deposit', ...Array(1600).fill('open'), 'withdraw']);
    const out = trimActivity(many);
    expect(out.length).toBe(ACTIVITY_MAX);
    // 102 over the cap: the oldest listings beyond the keep count go first, every trade stays
    expect(out.filter((x) => x.kind === 'market').length).toBe(398);
    expect(out.filter((x) => x.kind === 'open').length).toBe(1600);
    // trades only push listings out down to the keep count
    let busy = rows([...Array(500).fill('market'), ...Array(1500).fill('open')]);
    for (let i = 0; i < 1000; i++) busy = trimActivity([...busy, rows(['open'])[0]!]);
    expect(busy.filter((x) => x.kind === 'market').length).toBe(ACTIVITY_KEEP.market);
    expect(busy.length).toBe(ACTIVITY_MAX);
    expect(out.filter((x) => x.kind === 'deposit' || x.kind === 'withdraw').length).toBe(2);
    expect(out.map((x) => x.seq!)).toEqual([...out.map((x) => x.seq!)].sort((a, b) => a - b));
    expect(trimActivity(rows(Array(2001).fill('deposit'))).length).toBe(ACTIVITY_MAX);
  });

  test('/leaderboard?period=day counts settlements of the last fork day only', async () => {
    const { d, h } = mkApp();
    list(d, 'NVDA');
    open(d, 1, ALICE, 'NVDA', { stake: 200_000_000n, at: CLOCK - 200_000 });
    settle(d, 1, 400_000_000n, CLOCK - 100_000);
    open(d, 2, BOB, 'NVDA', { stake: 200_000_000n });
    settle(d, 2, 300_000_000n, CLOCK - 60);
    const all = (await get(h, '/leaderboard')).body;
    expect(all.period).toBe('all');
    expect(all.rows.map((r: { address: string }) => r.address)).toEqual([ALICE, BOB]);
    const day = (await get(h, '/leaderboard?period=day')).body;
    expect(day.rows.map((r: { address: string }) => r.address)).toEqual([BOB]);
    expect((await get(h, '/leaderboard?period=week')).status).toBe(400);
  });

  test('/state carries the feed status, counts.bots and nextClose', async () => {
    const { d, h } = mkApp();
    list(d, 'NVDA');
    open(d, 1, ALICE, 'NVDA');
    open(d, 2, BOB, 'NVDA');
    settle(d, 2, 0n);
    const st = (await get(h, '/state')).body;
    expect(st.counts).toEqual({ tickets: 2, open: 1, settled: 1, addresses: 2, markets: 1, lps: 0, bots: 0 });
    expect(st.nextClose).toBe(CLOCK - (CLOCK % 86_400) + 21 * 3600);
    for (const k of ['core', 'warm', 'due', 'watchdog', 'rowsLastPost', 'tickMs', 'tickP95Ms', 'source', 'frozen', 'lastTickAt']) expect(Object.keys(st.feed)).toContain(k);
  });
});

describe('vault', () => {
  test('/vault adds sharePrice, utilization, an hourly history from the events and pnl7d', async () => {
    const { app, d, h } = mkApp();
    app.book = { chainId: 46633, startBlock: 1n, usdg: null, vault: VAULT, book: '0x5FbDB2315678afecb367f032d93F642f64180aa3', reference: null, raw: {} };
    const reads: Record<string, bigint> = { totalAssets: 1_000_000_000_000n, reserved: 250_000_000_000n, free: 750_000_000_000n, totalSupply: 1_000_000_000_000_000_000n };
    (app.chain.pub as unknown as { readContract: (a: { functionName: string }) => Promise<bigint> }).readContract = async (a) => reads[a.functionName]!;
    list(d, 'NVDA', CLOCK - 7200 * 3);
    applyEvent(d, { eventName: 'Deposit', args: { sender: ALICE, owner: ALICE, assets: 1_000_000_000_000n, shares: 10n ** 18n } }, meta(CLOCK - 7200 * 3));
    open(d, 1, BOB, 'NVDA', { stake: 100_000_000n, at: CLOCK - 7200 * 2 });
    applyEvent(d, { eventName: 'Reserved', args: { amount: 495_000_000n, totalReserved: 495_000_000n } }, meta(CLOCK - 7200 * 2));
    settle(d, 1, 0n, CLOCK - 7200);
    applyEvent(d, { eventName: 'Released', args: { amount: 495_000_000n, totalReserved: 0n } }, meta(CLOCK - 7200));
    const v = (await get(h, '/vault')).body;
    expect(v).toMatchObject({ deployed: true, assets: '1000000000000', reserved: '250000000000', free: '750000000000', shares: '1000000000000000000', lpCount: 1, utilization: 0.25 });
    expect(v.sharePrice).toBeCloseTo(1, 6);
    // one point per fork hour from the first event's hour to the last one's
    expect(v.history.length).toBe(5);
    expect(v.history.map((p: { t: number }) => p.t)).toEqual([0, 1, 2, 3, 4].map((i) => Math.floor((CLOCK - 21_600) / 3600) * 3600 + i * 3600));
    expect(Object.keys(v.history[0]).sort()).toEqual(['assetsRaw', 'reservedRaw', 'sharePrice', 't']);
    // each point holds the totals at the end of the hour before it
    expect(v.history.map((p: { reservedRaw: string }) => p.reservedRaw)).toEqual(['0', '0', '0', '495000000', '495000000']);
    expect(v.history[1].assetsRaw).toBe('1000000000000');
    // house pnl: the full 100 USDG stake was kept
    expect(v.pnl7d[v.pnl7d.length - 1]).toBe(100);
    expect(v.pnl7d[0]).toBe(0);
  });

  test('a state indexed before the vault totals existed shows no history instead of a wrong one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bell-old-'));
    const old = { ...emptyState(), lastBlock: 50, activity: [{ kind: 'deposit', address: ALICE, amount: '5', block: 3, tx: '0x', logIndex: 0, at: 1 }] } as Record<string, unknown>;
    delete old.vault;
    delete old.bots;
    delete old.activitySeq;
    await Bun.write(join(dir, 'state.json'), JSON.stringify(old));
    const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off' }));
    expect(app.store.data.vault.partial).toBe(true);
    expect(app.store.data.bots).toEqual([]);
    expect(app.store.data.activity[0]!.seq).toBe(1);
    expect(app.store.data.activitySeq).toBe(1);
    app.clock = async () => ({ clock: CLOCK, block: 100 });
    app.book = { chainId: 46633, startBlock: 1n, usdg: null, vault: VAULT, book: '0x5FbDB2315678afecb367f032d93F642f64180aa3', reference: null, raw: {} };
    (app.chain.pub as unknown as { readContract: () => Promise<bigint> }).readContract = async () => 1n;
    const v = (await get(handler(app), '/vault')).body;
    expect(v.history).toEqual([]);
    expect(v.pnl7d).toBe(null);
    resetIndex(app.store.data, '0xabc');
    expect(app.store.data.vault.partial).toBeUndefined();
  });

  test('no vault in the book: the old answer', async () => {
    const { h } = mkApp();
    expect((await get(h, '/vault')).body).toEqual({ deployed: false });
  });
});

describe('ticket index', () => {
  test('incremental updates equal a rebuild from the tickets', () => {
    const d = emptyState();
    d.feeBps = 100;
    let r = 7;
    const rnd = () => ((r = (r * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const owners = [ALICE, BOB, BOT];
    const syms = ['NVDA', 'AAPL', 'TSLA'];
    indexOf(d); // built empty, then kept current by the indexer hooks
    for (let i = 1; i <= 400; i++) {
      open(d, i, owners[i % 3]!, syms[Math.floor(rnd() * 3)]!, { long: rnd() < 0.5, lev: [2, 5, 10, 20][i % 4], stake: BigInt(1 + Math.floor(rnd() * 500)) * 1_000_000n, at: CLOCK - 100_000 + i * 200 });
      if (i > 5 && rnd() < 0.6) settle(d, i - 5, BigInt(Math.floor(rnd() * 900)) * 1_000_000n, CLOCK - 100_000 + i * 200);
    }
    const a = indexOf(d);
    const snap = (ix: ReturnType<typeof indexOf>) => ({
      count: ix.count,
      open: [...ix.open].sort(),
      settled: ix.settledCount,
      sym: [...ix.bySymbol].map(([s, x]) => [s, x.open.size, x.longOpen.toString(), x.shortOpen.toString(), x.exposure.toString(), ix.volumeSince(s, CLOCK - 86_400).toString()]).sort(),
      own: [...ix.byOwner].map(([o, x]) => [o, x.settled, x.wins, x.points, x.pnl.toString(), x.staked.toString(), x.ids.length]).sort(),
      day: ix.settledSince(CLOCK - 50_000).map((t) => t.id).sort(),
    });
    const inc = snap(a);
    invalidateIndex(d);
    const b = indexOf(d);
    expect(b).not.toBe(a);
    expect(snap(b)).toEqual(inc);
    expect(inc.count).toBe(400);
  });

  test('resetIndex clears tickets, rounds and the vault history and the index follows', () => {
    const d = emptyState();
    open(d, 1, ALICE, 'NVDA');
    d.rounds.NVDA = [{ t: CLOCK, price8: '1' }];
    expect(indexOf(d).count).toBe(1);
    resetIndex(d, '0xabc');
    expect(d.rounds).toEqual({});
    expect(d.vault.history).toEqual([]);
    expect(indexOf(d).count).toBe(0);
  });
});
