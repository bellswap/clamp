// Mock fixtures of the ticker page's routes (VITE_MOCK=1), built on the app's mock clock and reference
// (lib/mock.ts: the playground clock starts at 20:00 UTC and runs at 60x, so a 5-minute candle forms every 5 wall
// seconds and Today's close settles about a minute after the first load). The last four playground hours use
// mock.mockPrice, so the chart, the entries of the app's mock tickets and their settlement prints agree; before that a
// bounded deterministic history per symbol. Demo traders (bot rows) open a ticket on each symbol every 20 playground
// minutes; their tickets settle at the print of their expiry like everyone's.
import * as mock from '../mock';
import { expiryOf, HORIZONS } from '../horizon';
import { MULTIPLES, payoutAt, preview } from '../payout';
import type { CatalogEntry, TicketView } from '../types';
import { aggregate, BAR_SECONDS, fromCloses, TF_SECONDS, type Tf } from './candles';
import type { CandlesAnswer, TickerMarket, TickerTicket, WarmAnswer } from './ticker-api';

/** The 14 markets of deployments/book.json (oiCap 50,000 USDG); listed catalog markets get 20,000. */
export const CORE = ['RTX', 'NOC', 'CPER', 'SOXL', 'DRAM', 'GD', 'MARA', 'UUUU', 'SPY', 'QQQ', 'NVDA', 'MU', 'SNDK', 'TSLA'];
const MAX_STAKE = 1000;
const MAX_LEVERAGE = 20;
/** A warmed long-tail symbol shows "Preparing market" this long (wall ms) before its first print lands. */
const WARM_DELAY_MS = 1200;

// ---------- deterministic randomness ----------
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche, so neighbouring keys give unrelated values
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}
const u = (s: string) => hash(s) / 4294967296;

export const BOTS: readonly string[] = Array.from({ length: 24 }, (_, i) => {
  let hex = '';
  for (let j = 0; hex.length < 40; j++) hex += hash(`bot:${i}:${j}`).toString(16).padStart(8, '0');
  return `0x${hex.slice(0, 40)}`;
});

// ---------- catalog and clock ----------
let ready: Promise<Map<string, CatalogEntry>> | null = null;
function catalog(): Promise<Map<string, CatalogEntry>> {
  ready ??= (async () => {
    const c = await mock.mockCatalog();
    await mock.mockPrices(c.find((e) => e.lastPrice !== null)?.symbol ?? 'NVDA'); // loads mock.ts's price table
    return new Map(c.map((e) => [e.symbol, e]));
  })();
  return ready;
}

let t0: number | null = null;
/** The playground time of the first fixture call; history and the demo traders' schedule hang off it. */
function origin(): number {
  t0 ??= Math.floor(mock.mockNow() / BAR_SECONDS) * BAR_SECONDS;
  return t0;
}

// ---------- prices ----------
const HIST_JOIN_S = 4 * 3600;
function hist(sym: string, t: number): number {
  const p = (k: string) => u(`${sym}:${k}`) * 2 * Math.PI;
  const day = 86400;
  const knot = 3600;
  const kk = Math.floor(t / knot);
  const f = t / knot - kk;
  const n0 = u(`${sym}:k${kk}`) - 0.5;
  const n1 = u(`${sym}:k${kk + 1}`) - 0.5;
  const smooth = (n0 + (n1 - n0) * f) * 0.012;
  const bar = (u(`${sym}:b${Math.floor(t / BAR_SECONDS)}`) - 0.5) * 0.003;
  return 0.012 * Math.sin((2 * Math.PI * t) / day + p('d')) + 0.03 * Math.sin((2 * Math.PI * t) / (5 * day) + p('w'))
    + 0.06 * Math.sin((2 * Math.PI * t) / (30 * day) + p('m')) + 0.1 * Math.sin((2 * Math.PI * t) / (120 * day) + p('q')) + smooth + bar;
}

/** The mock reference of `sym` at playground time `t`. */
export function priceAt(sym: string, t: number): number {
  const join = origin() - HIST_JOIN_S;
  if (t >= join) return mock.mockPrice(sym, t);
  const v = mock.mockPrice(sym, join) * Math.exp(hist(sym, t) - hist(sym, join));
  return Math.round(v * 1e4) / 1e4;
}

/** 5-minute candles from `from` (a bar start) to the bar forming at `now`. */
function candles5(sym: string, from: number, now: number): ReturnType<typeof fromCloses> {
  const last = Math.floor(now / BAR_SECONDS) * BAR_SECONDS;
  const closes: { t: number; c: number }[] = [];
  for (let b = from; b <= last; b += BAR_SECONDS) closes.push({ t: b, c: priceAt(sym, Math.min(b + BAR_SECONDS, now)) });
  return fromCloses(closes, priceAt(sym, from));
}

export async function mockCandles(symbol: string, tf: Tf, limit: number, before?: number): Promise<CandlesAnswer> {
  const cat = await catalog();
  const sym = symbol.toUpperCase();
  const now = mock.mockNow();
  const e = cat.get(sym);
  if (!e || e.lastPrice === null) return { symbol: sym, tf, clockUnix: now, candles: [] };
  const size = TF_SECONDS[tf];
  const end = Math.min(now, before ?? now);
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  const start = Math.floor(end / size) * size - (n - 1) * size;
  const c = aggregate(candles5(sym, start, end), tf).filter((k) => before === undefined || k.t < before);
  return { symbol: sym, tf, clockUnix: now, candles: c.slice(-n) };
}

// ---------- tickets ----------
const BOT_EVERY_S = 1200;
const BOT_BACK = 30; // demo tickets before the origin

/** The demo traders' tickets on `sym` up to playground time `now`, settled when their expiry has passed. */
function botTickets(sym: string, now: number): TickerTicket[] {
  const o = origin();
  const out: TickerTicket[] = [];
  const kMax = Math.floor((now - o) / BOT_EVERY_S);
  for (let k = -BOT_BACK; k <= kMax; k++) {
    const key = `${sym}:t${k}`;
    if (u(`${key}:skip`) < 0.25) continue;
    const openedAt = o + k * BOT_EVERY_S - Math.floor(u(`${key}:j`) * 600);
    if (openedAt > now) continue;
    const owner = BOTS[Math.floor(u(`${key}:o`) * BOTS.length)]!;
    const long = u(`${key}:s`) < 0.55;
    const leverage = MULTIPLES[Math.floor(u(`${key}:l`) * MULTIPLES.length)]!;
    const stake = [20, 50, 50, 100, 100, 250, 500][Math.floor(u(`${key}:a`) * 7)]!;
    const horizon = HORIZONS[u(`${key}:h`) < 0.55 ? 0 : u(`${key}:h`) < 0.9 ? 1 : 2]!;
    const expiry = expiryOf(horizon, openedAt);
    const pv = preview(stake, leverage, mock.MOCK_FEE_BPS);
    const entryPrice = priceAt(sym, openedAt);
    const t: TickerTicket = { id: String(900_000 + Math.abs(hash(key) % 90_000)), owner, symbol: sym, long, leverage, horizon, stake, net: pv.net, entryPrice, openedAt, expiry, status: 'open', payout: null, settlePrice: null, settledAt: null, bot: true };
    if (expiry <= now) {
      const settle = priceAt(sym, expiry);
      t.settlePrice = settle;
      t.payout = payoutAt(pv.net, leverage, entryPrice, settle, long);
      t.settledAt = expiry + 15;
      t.status = t.payout > stake ? 'won' : 'lost';
    }
    out.push(t);
  }
  return out;
}

/** The app mock's own tickets (seed rows and the viewer's) on `sym`, through its activity and ticket fixtures. */
async function appTickets(sym: string): Promise<TicketView[]> {
  const ids = new Set((await mock.mockActivity()).filter((a) => a.symbol === sym).map((a) => a.id));
  const out = await Promise.all([...ids].map((id) => mock.mockTicket(id)));
  return out.filter((t): t is TicketView => t !== null);
}

const isOpen = (t: TicketView) => t.payout === null;

export async function mockTickerTickets(q: { symbol: string; owner?: string; status?: 'open' | 'settled'; limit?: number }): Promise<TickerTicket[]> {
  await catalog();
  const sym = q.symbol.toUpperCase();
  const now = mock.mockNow();
  let rows: TickerTicket[];
  if (q.owner) rows = (await mock.mockTickets(q.owner)).filter((t) => t.symbol === sym).map((t) => ({ ...t, bot: false }));
  else rows = [...(await appTickets(sym)).map((t) => ({ ...t, bot: false })), ...botTickets(sym, now)];
  if (q.status === 'open') rows = rows.filter(isOpen);
  if (q.status === 'settled') rows = rows.filter((t) => !isOpen(t));
  const key = (t: TicketView) => (q.status === 'settled' ? t.settledAt ?? t.expiry : t.openedAt);
  return rows.sort((a, b) => key(b) - key(a)).slice(0, q.limit ?? 50);
}

// ---------- warm and market ----------
const warmedAt = new Map<string, number>();

export async function mockWarm(symbol: string): Promise<WarmAnswer> {
  const cat = await catalog();
  const e = cat.get(symbol.toUpperCase());
  if (!e || e.lastPrice === null) return { ok: false, status: 404 };
  if (!warmedAt.has(e.symbol)) warmedAt.set(e.symbol, Date.now());
  return { ok: true, warmUntil: mock.mockNow() + 90 * mock.MOCK_SPEED };
}

function downsample(v: number[], n: number): number[] {
  if (v.length <= n) return v;
  return Array.from({ length: n }, (_, i) => v[Math.round((i * (v.length - 1)) / (n - 1))]!);
}

export async function mockMarket(symbol: string): Promise<TickerMarket | null> {
  const cat = await catalog();
  const sym = symbol.toUpperCase();
  const e = cat.get(sym);
  if (!e) return null;
  const now = mock.mockNow();
  const core = CORE.includes(sym);
  const covered = e.lastPrice !== null;
  const expiries = { session: expiryOf(0, now), day: expiryOf(1, now), week: expiryOf(2, now) };
  const eta = (t: number) => Math.max(0, (t - now) / mock.MOCK_SPEED);
  const base = {
    symbol: sym, listed: covered, covered, tradable: covered, maxStake: MAX_STAKE, maxLeverage: MAX_LEVERAGE, oiCap: core ? 50_000 : 20_000,
    feeBps: mock.MOCK_FEE_BPS, maxStaleness: 86_400, clockUnix: now, atMs: Date.now(), expiries, etaWall: { session: eta(expiries.session), day: eta(expiries.day), week: eta(expiries.week) },
  };
  if (!covered) {
    return { ...base, hot: false, price: null, prevClose: null, sessionOpen: null, sessionHigh: null, sessionLow: null, spark: [], openCount: 0, oi: 0, longOpen: 0, shortOpen: 0, volume24h: 0, lastRound: null, exposure: 0, fresh: false, ready: false };
  }
  const sessionStart = expiries.session - 86_400;
  const c = candles5(sym, Math.floor(sessionStart / BAR_SECONDS) * BAR_SECONDS, now);
  const closes = c.map((k) => k.c);
  const price = priceAt(sym, now);
  const all = [...(await appTickets(sym)), ...botTickets(sym, now)];
  const open = all.filter(isOpen);
  const sum = (xs: TicketView[], f: (t: TicketView) => number) => xs.reduce((a, t) => a + f(t), 0);
  const w = warmedAt.get(sym);
  const fresh = core || (w !== undefined && Date.now() - w >= WARM_DELAY_MS);
  return {
    ...base,
    hot: open.length >= 3,
    price,
    prevClose: priceAt(sym, sessionStart),
    sessionOpen: priceAt(sym, sessionStart),
    sessionHigh: Math.max(...closes, price),
    sessionLow: Math.min(...closes, price),
    spark: downsample(closes, 80),
    openCount: open.length,
    oi: sum(open, (t) => t.stake),
    longOpen: sum(open.filter((t) => t.long), (t) => t.stake),
    shortOpen: sum(open.filter((t) => !t.long), (t) => t.stake),
    volume24h: sum(all.filter((t) => t.openedAt > now - 86_400), (t) => t.stake),
    lastRound: fresh ? { t: Math.floor(now / 15) * 15, price } : null,
    exposure: sum(open, (t) => t.net * t.leverage),
    fresh,
    ready: fresh,
  };
}
