// Data access of the ticker page: the bell's market, candle, warm, ticket and activity routes or, with
// VITE_MOCK=1, the fixtures in ticker-mock.ts, so the page renders without the new API. USDG arrives as raw 6-decimal
// integer strings under *Raw keys and is converted to USDG numbers here; prices are numbers; times are fork unix s.
import { BELL_URL, MOCK } from '../../config';
import { toTicket } from '../normalize';
import type { TicketView } from '../types';
import type { Candle, Tf } from './candles';
import * as fx from './ticker-mock';

export interface Expiries { session: number; day: number; week: number }

export interface TickerMarket {
  symbol: string;
  listed: boolean;
  /** The recorded series covers the playground axis; false shows "No price feed". */
  covered: boolean;
  tradable: boolean;
  hot: boolean;
  price: number | null;
  prevClose: number | null;
  sessionOpen: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  spark: number[];
  openCount: number;
  /** USDG: gross stakes of open tickets (TicketBook markets(symbol).oi), its cap, and the long and short parts. */
  oi: number;
  oiCap: number;
  longOpen: number;
  shortOpen: number;
  maxStake: number;
  maxLeverage: number;
  volume24h: number;
  lastRound: { t: number; price: number } | null;
  /** USDG: sum of net stake times multiple over open tickets (GET /markets/:symbol only). */
  exposure: number;
  feeBps: number | null;
  maxStaleness: number | null;
  /** The bell's test: the last print is within one bar of the clock. */
  fresh: boolean;
  /** A ticket can open now: printFresh, or fresh a few wall seconds ago (useTickerMarket sets it; else printFresh). */
  ready: boolean;
  /** The bell's playground clock when it answered (GET /markets/:symbol), null when absent. */
  clockUnix: number | null;
  /** Wall ms when the answer arrived; the etaWall values count down from here. */
  atMs: number;
  expiries: Expiries | null;
  /** The bell's wall ETAs of the three expiries, counted in replay ticks (the nightly jump included). */
  etaWall: { session: number | null; day: number | null; week: number | null } | null;
}

/** Slack over the bell's one-bar freshness test. The feed stamps a print at P and moves the clock a bar on, so any
 * block mined before the next tick puts clock - t past one bar while the print is still the latest. */
export const FRESH_WINDOW_S = 2 * 300;

/** The last print is the latest one the replay posted: the bell says fresh, or the print is within two bars of the
 * bell's clock. */
export function printFresh(m: Pick<TickerMarket, 'fresh' | 'lastRound' | 'clockUnix'>): boolean {
  return m.fresh || (m.lastRound !== null && m.clockUnix !== null && m.clockUnix - m.lastRound.t <= FRESH_WINDOW_S);
}

export interface CandlesAnswer { symbol: string; tf: Tf; clockUnix: number; candles: Candle[] }

export interface TickerTicket extends TicketView { bot: boolean }

export type WarmAnswer = { ok: true; warmUntil: number | null } | { ok: false; status: number };

export class TickerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'TickerError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
/** USDG from a raw 6-decimal integer string (or number), 0 when absent. */
export function rawUsd(v: unknown): number {
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v) / 1e6;
  if (typeof v === 'number' && Number.isFinite(v)) return v / 1e6;
  if (typeof v === 'bigint') return Number(v) / 1e6;
  return 0;
}

export function toMarket(x: unknown, atMs = Date.now()): TickerMarket | null {
  if (!isObj(x) || typeof x.symbol !== 'string') return null;
  const exp = isObj(x.expiries) ? x.expiries : null;
  const eta = isObj(x.etaWall) ? x.etaWall : null;
  const lr = isObj(x.lastRound) ? x.lastRound : null;
  const lrPrice = lr ? (num(lr.price8) ?? 0) / 1e8 : 0;
  const lastRound = lr && lrPrice > 0 ? { t: num(lr.t) ?? 0, price: lrPrice } : null;
  const clockUnix = num(x.clockUnix);
  const fresh = x.fresh === true;
  return {
    symbol: x.symbol.toUpperCase(),
    listed: x.listed === true,
    covered: x.covered !== false,
    tradable: x.tradable === true,
    hot: x.hot === true,
    price: num(x.price),
    prevClose: num(x.prevClose),
    sessionOpen: num(x.sessionOpen),
    sessionHigh: num(x.sessionHigh),
    sessionLow: num(x.sessionLow),
    spark: Array.isArray(x.spark) ? x.spark.map(num).filter((v): v is number => v !== null) : [],
    openCount: num(x.openCount) ?? 0,
    oi: rawUsd(x.oiRaw),
    oiCap: rawUsd(x.oiCapRaw),
    longOpen: rawUsd(x.longOpenRaw),
    shortOpen: rawUsd(x.shortOpenRaw),
    maxStake: rawUsd(x.maxStakeRaw),
    maxLeverage: num(x.maxLeverage) ?? 20,
    volume24h: rawUsd(x.volume24hRaw),
    lastRound,
    exposure: rawUsd(x.exposureRaw),
    feeBps: num(x.feeBps),
    maxStaleness: num(x.maxStaleness),
    fresh,
    ready: printFresh({ fresh, lastRound, clockUnix }),
    clockUnix,
    atMs,
    expiries: exp ? { session: num(exp.session) ?? 0, day: num(exp.day) ?? 0, week: num(exp.week) ?? 0 } : null,
    etaWall: eta ? { session: num(eta.session), day: num(eta.day), week: num(eta.week) } : null,
  };
}

export function toCandles(x: unknown): Candle[] {
  const arr = isObj(x) && Array.isArray(x.candles) ? x.candles : Array.isArray(x) ? x : [];
  return arr
    .filter(isObj)
    .map((o) => ({ t: num(o.t) ?? NaN, o: num(o.o) ?? NaN, h: num(o.h) ?? NaN, l: num(o.l) ?? NaN, c: num(o.c) ?? NaN }))
    .filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite))
    .sort((a, b) => a.t - b.t);
}

export function toTickerTickets(x: unknown): TickerTicket[] {
  const arr = isObj(x) && Array.isArray(x.tickets) ? x.tickets : Array.isArray(x) ? x : [];
  const out: TickerTicket[] = [];
  for (const o of arr) {
    const t = toTicket(o);
    if (t) out.push({ ...t, bot: isObj(o) && o.bot === true });
  }
  return out;
}

const READ_TIMEOUT_MS = 10_000;

async function bell(path: string, init: RequestInit = {}): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
  try {
    const r = await fetch(`${BELL_URL.replace(/\/+$/, '')}${path}`, { ...init, signal: ctl.signal, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new TickerError(r.status, (isObj(body) && typeof body.error === 'string' ? body.error : null) ?? `bell answered ${r.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

export interface TickerApi {
  /** GET /markets/:symbol (marks the symbol warm); null when the bell does not know the symbol. */
  market(symbol: string): Promise<TickerMarket | null>;
  /** GET /candles/:symbol (marks warm), oldest first, the last may be forming. */
  candles(symbol: string, tf: Tf, limit: number, before?: number): Promise<CandlesAnswer>;
  /** POST /warm/:symbol: keep the symbol in the print set while the page is open. */
  warm(symbol: string): Promise<WarmAnswer>;
  /** GET /tickets?symbol=&owner=&status=&limit=, newest first. */
  tickets(q: { symbol: string; owner?: string; status?: 'open' | 'settled'; limit?: number }): Promise<TickerTicket[]>;
}

const live: TickerApi = {
  async market(symbol) {
    try {
      return toMarket(await bell(`/markets/${enc(symbol)}`));
    } catch (e) {
      if (e instanceof TickerError && e.status === 404) return null;
      throw e;
    }
  },
  async candles(symbol, tf, limit, before) {
    const b = await bell(`/candles/${enc(symbol)}?tf=${tf}&limit=${limit}${before !== undefined ? `&before=${before}` : ''}`);
    return { symbol, tf, clockUnix: isObj(b) ? num(b.clockUnix) ?? 0 : 0, candles: toCandles(b) };
  },
  async warm(symbol) {
    try {
      const b = await bell(`/warm/${enc(symbol)}`, { method: 'POST', body: '{}' });
      return { ok: true, warmUntil: isObj(b) ? num(b.warmUntil) : null };
    } catch (e) {
      return { ok: false, status: e instanceof TickerError ? e.status : 0 };
    }
  },
  async tickets({ symbol, owner, status, limit = 50 }) {
    const q = new URLSearchParams({ symbol, limit: String(limit) });
    if (owner) q.set('owner', owner);
    if (status) q.set('status', status);
    const list = toTickerTickets(await bell(`/tickets?${q}`));
    // The bell's existing /tickets answers an owner query only; keep the symbol filter on the client as well.
    return list.filter((t) => t.symbol === symbol.toUpperCase()).sort((a, b) => b.openedAt - a.openedAt || Number(b.id) - Number(a.id));
  },
};

const fixtures: TickerApi = {
  market: fx.mockMarket,
  candles: fx.mockCandles,
  warm: fx.mockWarm,
  tickets: fx.mockTickerTickets,
};

export const tickerApi: TickerApi = MOCK ? fixtures : live;
